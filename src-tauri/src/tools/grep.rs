//! `tool_grep` — search files under a directory for a text pattern.
//!
//! Read-only, sandboxed by `resolve_under_roots` (same as `list_dir`
//! and `read_file`).  Uses `walkdir` for iterative, non-recursive
//! traversal (no stack-overflow risk on deep trees).  Results are
//! capped by multiple budgets: result count, visited entries, total
//! bytes read, matched-content bytes, and wall-clock deadline.  Paths
//! are sorted for stable, deterministic output across platforms.
//! Invalid regex patterns produce an explicit error — no silent
//! fallback to literal matching.
//!
//! The search runs in two passes.  Pass 1 walks the tree and selects
//! candidate files; only pass 1 consumes the visited-entry budget.
//! Pass 2 (`read_candidates`) opens each selected file and applies the
//! regex; it owns every output budget, the cancellation cadence, and
//! the deadline check.  Keeping the two budgets separate matters: a
//! spent visited budget must never discard candidates pass 1 already
//! selected.
//!
//! BOM-marked UTF-16 is transcoded before classification. After that step,
//! binary policy matches `lc_read_file`: a NUL byte inside the first
//! `NUL_SNIFF_BYTES` marks binary content, including unmarked UTF-16.
//! `lc_read_file` refuses such a path with `binary_detected`; grep skips it
//! and counts it in `skipped_binary`, because one binary file must not fail
//! a whole batch of searches.

use super::fs_ops::{enforce_filesystem_batch_limit, merged_roots, resolve_under_roots};
use super::glob::{build_glob_set, expand_braces};
use super::registry::{ToolHandle, ToolRegistryGuard};
use super::{ToolError, ToolOk};
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::time::Instant;
use tokio_util::sync::CancellationToken;
use walkdir::WalkDir;

const DEFAULT_MAX_RESULTS: usize = 1000;
const HARD_CAP_RESULTS: usize = 5000;
const MAX_FILE_SIZE: u64 = 1_048_576; // 1 MiB
/// Window for the replacement-character heuristic.
const BINARY_SNIFF_BYTES: usize = 65_536; // 64 KiB
/// Window for the NUL-byte check.  Imported rather than restated, so
/// grep and the tools in `fs_ops` cannot drift into calling the same
/// file text and binary.
use super::fs_ops::TEXT_SNIFF_BYTES as NUL_SNIFF_BYTES;
const BINARY_NON_UTF8_THRESHOLD: usize = 4096; // >4 KB of non-UTF8 → binary
const DEFAULT_MAX_VISITED: usize = 50_000;
const HARD_CAP_VISITED: usize = 200_000;
const DEFAULT_MAX_BYTES_READ: u64 = 100_000_000; // 100 MB
const HARD_CAP_BYTES_READ: u64 = 500_000_000; // 500 MB
/// Matched-content budget for one call.  Caps total payload; the
/// per-line cap below only bounds a single match.
const DEFAULT_MAX_MATCH_BYTES: u64 = 262_144; // 256 KiB
/// Longest match line returned verbatim.  A minified bundle is one
/// enormous line inside a small file, so the 1 MiB file guard does not
/// bound a single match without this.
const MAX_MATCH_LINE_CHARS: usize = 2_000;
/// Context lines on each side of a match, at most. Context costs the
/// same matched-content budget as the match line itself.
const MAX_CONTEXT_LINES: usize = 10;
const CANCELLATION_CHECK_INTERVAL: usize = 100; // check every 100 files

fn effective_max_results(requested: Option<usize>) -> usize {
    requested
        .unwrap_or(DEFAULT_MAX_RESULTS)
        .min(HARD_CAP_RESULTS)
}

/// Directory names we always skip during recursive walk.
const SKIP_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "__pycache__",
    ".venv",
    "venv",
    ".env",
    "dist",
    "build",
    ".next",
    ".nuxt",
    ".cache",
    "coverage",
    ".idea",
    ".vscode",
];

/// File extensions we always skip (binary / media / archives).
const SKIP_EXTS: &[&str] = &[
    "exe", "dll", "so", "dylib", "bin", "png", "jpg", "jpeg", "gif", "ico", "webp", "bmp", "woff",
    "woff2", "ttf", "eot", "pdf", "zip", "tar", "gz", "7z", "rar",
];

/// Why a search stopped before it finished.
///
/// Reported as `truncated_reason` whenever completeness is not proven.
/// Causes can coincide, so the variant order below is the documented
/// precedence. Without a fixed order, equivalent queries could report
/// different causes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TruncationReason {
    Cancelled,
    Deadline,
    /// The result budget emptied. A bounded proof scan either finds another
    /// match or leaves completeness unknown.
    Results,
    MatchBytes,
    Bytes,
    Visited,
    PerFileMatches,
}

impl TruncationReason {
    fn as_str(self) -> &'static str {
        match self {
            TruncationReason::Cancelled => "cancelled",
            TruncationReason::Deadline => "deadline",
            TruncationReason::Results => "results",
            TruncationReason::MatchBytes => "match_bytes",
            TruncationReason::Bytes => "bytes",
            TruncationReason::Visited => "visited",
            TruncationReason::PerFileMatches => "per_file_matches",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Completeness {
    Complete,
    Truncated,
    NotDetermined,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct SearchOutcome {
    completeness: Completeness,
    reason: Option<TruncationReason>,
}

impl SearchOutcome {
    fn complete() -> Self {
        Self {
            completeness: Completeness::Complete,
            reason: None,
        }
    }

    fn truncated(reason: TruncationReason) -> Self {
        Self {
            completeness: Completeness::Truncated,
            reason: Some(reason),
        }
    }

    fn not_determined(reason: TruncationReason) -> Self {
        Self {
            completeness: Completeness::NotDetermined,
            reason: Some(reason),
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct GrepSearchEntry {
    pub path: String,
    pub pattern: String,
    /// Per-search include override. Replaces the batch-wide `include`
    /// for this search when present and non-blank.
    #[serde(default)]
    pub include: Option<String>,
}

/// Output shape for a search.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum OutputMode {
    #[default]
    Content,
    FilesWithMatches,
    Count,
}

#[derive(Debug, Deserialize)]
pub struct GrepRequest {
    pub searches: Vec<GrepSearchEntry>,
    pub include: Option<String>,
    /// Glob pattern to skip files (same dialect and path shape as
    /// `include`). Batch-wide.
    #[serde(default)]
    pub exclude: Option<String>,
    pub ignore_case: Option<bool>,
    pub max_results: Option<usize>,
    /// Lines of context before and after each match. Content mode only.
    /// Default 0, at most `MAX_CONTEXT_LINES`.
    #[serde(default)]
    pub context_lines: Option<usize>,
    /// Output shape. Default `content`.
    #[serde(default)]
    pub output_mode: Option<OutputMode>,
    /// Per-file match cap. The result signals when a further match
    /// proves that this sampling limit omitted content.
    #[serde(default)]
    pub max_matches_per_file: Option<usize>,
    /// Search inside the fixed skip directories (`node_modules`, `.git`,
    /// ...). Default false — the pruning stays.
    #[serde(default)]
    pub include_excluded_dirs: Option<bool>,
    pub allowed_roots: Option<Vec<String>>,
    /// Phase 2.1: Operation-level identity for cancellation registration.
    #[serde(default)]
    pub call_id: Option<String>,
    #[serde(default)]
    pub group_id: Option<String>,
    /// Max directory entries to visit across the entire call (soft: DEFAULT_MAX_VISITED, hard: HARD_CAP_VISITED).
    #[serde(default)]
    pub max_visited_entries: Option<usize>,
    /// Max total bytes to read across all files (soft: DEFAULT_MAX_BYTES_READ, hard: HARD_CAP_BYTES_READ).
    #[serde(default)]
    pub max_bytes_read: Option<u64>,
    /// Wall-clock budget in milliseconds from call start. 0 or absent = no deadline.
    #[serde(default)]
    pub deadline_ms: Option<u64>,
}

/// Everything one search needs beyond path, pattern, and budget.
/// Carried as one struct so a new option is not a new positional
/// parameter on every function in the pipeline.
struct SearchOptions<'a> {
    include: Option<&'a globset::GlobSet>,
    exclude: Option<&'a globset::GlobSet>,
    context_lines: usize,
    mode: OutputMode,
    max_matches_per_file: Option<usize>,
    include_excluded_dirs: bool,
}

impl<'a> Default for SearchOptions<'a> {
    fn default() -> Self {
        SearchOptions {
            include: None,
            exclude: None,
            context_lines: 0,
            mode: OutputMode::Content,
            max_matches_per_file: None,
            include_excluded_dirs: false,
        }
    }
}

/// What a search collected, in the shape its mode asked for.
/// `matches` is always reported; in `files_with_matches` and `count`
/// modes it is empty and the mode-specific field carries the result.
enum ModeOutput {
    Content(Vec<serde_json::Value>),
    Files(Vec<String>),
    Counts(Vec<(String, u64)>),
}

#[tauri::command]
pub async fn tool_grep(req: GrepRequest) -> Result<ToolOk, ToolError> {
    enforce_filesystem_batch_limit("lc_grep", "searches", req.searches.len())?;
    // Options are call-wide; reject impossible combinations before any
    // I/O. Context only exists in content mode — accepting it silently
    // elsewhere would be an ignored parameter.
    let mode = req.output_mode.unwrap_or_default();
    let context_lines = req.context_lines.unwrap_or(0).min(MAX_CONTEXT_LINES);
    if context_lines > 0 && mode != OutputMode::Content {
        return Err(ToolError::Io(
            "context_lines applies only to output_mode \"content\"".into(),
        ));
    }
    // Register a cancellation token if call_id was provided.
    let (cancel_token, _guard) = if let Some(ref call_id) = req.call_id {
        let token = CancellationToken::new();
        {
            let entry = super::registry::ToolRegistryEntry {
                handle: ToolHandle(token.clone()),
                group_id: req.group_id.clone(),
            };
            let mut reg = super::registry::registry()
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            reg.insert(call_id.clone(), entry);
        }
        (
            Some(token),
            Some(ToolRegistryGuard {
                call_id: call_id.clone(),
            }),
        )
    } else {
        (None, None)
    };

    tokio::task::spawn_blocking(move || {
        let roots = merged_roots(req.allowed_roots.as_deref().unwrap_or(&[]));
        // `include` and `exclude` are batch-wide, so each is compiled
        // once. An invalid pattern fails the whole call — a silent
        // match-nothing is indistinguishable from "no matches exist".
        let include_set = compile_glob(req.include.as_deref())?;
        let exclude_set = compile_glob(req.exclude.as_deref())?;
        let max_matches_per_file = req.max_matches_per_file.map(|n| n.min(HARD_CAP_RESULTS));
        let include_excluded_dirs = req.include_excluded_dirs.unwrap_or(false);
        let mut results: Vec<serde_json::Value> = Vec::with_capacity(req.searches.len());
        let mut budget = GrepBudget {
            remaining_results: effective_max_results(req.max_results),
            remaining_visited: req
                .max_visited_entries
                .unwrap_or(DEFAULT_MAX_VISITED)
                .min(HARD_CAP_VISITED),
            remaining_bytes: req
                .max_bytes_read
                .unwrap_or(DEFAULT_MAX_BYTES_READ)
                .min(HARD_CAP_BYTES_READ),
            remaining_match_bytes: DEFAULT_MAX_MATCH_BYTES,
            deadline: req.deadline_ms.map(|ms| {
                Instant::now()
                    .checked_add(std::time::Duration::from_millis(ms))
                    .unwrap_or(Instant::now())
            }),
        };

        for search in &req.searches {
            if let Some(ref token) = cancel_token {
                if token.is_cancelled() {
                    // Cancellation is a normal truncated result, not an
                    // error — the same contract `lc_glob_files`
                    // documents. Nothing was searched, so the counters
                    // are all zero rather than absent.
                    results.push(grep_entry(
                        &search.path,
                        &search.pattern,
                        ModeOutput::Content(Vec::new()),
                        SearchOutcome::truncated(TruncationReason::Cancelled),
                        None,
                        None,
                        &GrepCounters::default(),
                    ));
                    continue;
                }
            }
            // A per-search include replaces the batch-wide one.
            let entry_include = match compile_glob(search.include.as_deref())? {
                Some(set) => Some(set),
                None => include_set.clone(),
            };
            let options = SearchOptions {
                include: entry_include.as_ref(),
                exclude: exclude_set.as_ref(),
                context_lines,
                mode,
                max_matches_per_file,
                include_excluded_dirs,
            };
            let entry = grep_single_dir(
                &search.path,
                &roots,
                &search.pattern,
                req.ignore_case,
                &mut budget,
                cancel_token.as_ref(),
                &options,
            );
            results.push(entry);
        }

        Ok(serde_json::json!({ "results": results }))
    })
    .await
    .map_err(|e| ToolError::Io(format!("task join failed: {}", e)))?
}

/// Compile an optional glob filter the way `tool_grep` does: blank
/// means absent, invalid fails the call.
fn compile_glob(pattern: Option<&str>) -> Result<Option<globset::GlobSet>, ToolError> {
    pattern
        .filter(|pattern| !pattern.trim().is_empty())
        .map(|pattern| build_glob_set(&expand_braces(pattern)))
        .transpose()
}

struct GrepBudget {
    remaining_results: usize,
    remaining_visited: usize,
    remaining_bytes: u64,
    remaining_match_bytes: u64,
    deadline: Option<Instant>,
}

impl GrepBudget {
    fn deadline_passed(&self) -> bool {
        self.deadline
            .is_some_and(|deadline| Instant::now() >= deadline)
    }

    /// Pass 1 guard.  The walk is the only pass that consumes visited
    /// entries, so this is the only place `remaining_visited` may stop
    /// work.  Checks run in `TruncationReason` precedence order.
    fn walk_stop_reason(&self) -> Option<TruncationReason> {
        if self.deadline_passed() {
            return Some(TruncationReason::Deadline);
        }
        if self.remaining_visited == 0 {
            return Some(TruncationReason::Visited);
        }
        None
    }

}

/// Per-search diagnostic counters.
///
/// Every field is reported on every result entry, including error and
/// cancelled entries, so an absent field never has to be told apart
/// from a zero one.
#[derive(Debug, Default, Clone)]
struct GrepCounters {
    visited: usize,
    files_selected: usize,
    bytes_read: u64,
    skipped_large: usize,
    skipped_binary: usize,
    skipped_symlink: usize,
    skipped_unreadable: usize,
    files_transcoded: usize,
}

/// The single constructor for every result entry.
///
/// One constructor is the point: success, error, mid-walk cancellation
/// and mid-read cancellation all used to build their own JSON, and
/// three of the four omitted the diagnostics entirely.  Routing them
/// all through here means the next field cannot be added to only some
/// of them.
fn grep_entry(
    path: &str,
    pattern: &str,
    output: ModeOutput,
    outcome: SearchOutcome,
    error_code: Option<&str>,
    error: Option<&str>,
    counters: &GrepCounters,
) -> serde_json::Value {
    let mut result = serde_json::json!({
        "path": path,
        "pattern": pattern,
        "truncated": match outcome.completeness {
            Completeness::Complete => serde_json::Value::Bool(false),
            Completeness::Truncated => serde_json::Value::Bool(true),
            Completeness::NotDetermined => serde_json::Value::Null,
        },
        "visited_entries": counters.visited,
        "files_selected": counters.files_selected,
        "bytes_read": counters.bytes_read,
        "skipped_large": counters.skipped_large,
        "skipped_binary": counters.skipped_binary,
        "skipped_symlink": counters.skipped_symlink,
        "skipped_unreadable": counters.skipped_unreadable,
        "files_transcoded": counters.files_transcoded,
    });
    match output {
        ModeOutput::Content(matches) => {
            result["matches"] = serde_json::json!(matches);
        }
        ModeOutput::Files(files) => {
            result["matches"] = serde_json::json!([]);
            result["files"] = serde_json::json!(files);
        }
        ModeOutput::Counts(counts) => {
            result["matches"] = serde_json::json!([]);
            result["counts"] = serde_json::json!(counts
                .into_iter()
                .map(|(file, count)| serde_json::json!({ "file": file, "count": count }))
                .collect::<Vec<_>>());
        }
    }
    if let Some(reason) = outcome.reason {
        result["truncated_reason"] = serde_json::json!(reason.as_str());
    }
    if let Some(code) = error_code {
        result["error_code"] = serde_json::json!(code);
    }
    if let Some(message) = error {
        result["error"] = serde_json::json!(message);
    }
    result
}

/// Truncate a match line to `MAX_MATCH_LINE_CHARS`, never splitting a
/// character.  Returns the text and whether it was cut.
fn cap_match_line(line: &str) -> (String, bool) {
    for (chars, (offset, _)) in line.char_indices().enumerate() {
        if chars == MAX_MATCH_LINE_CHARS {
            return (line[..offset].to_string(), true);
        }
    }
    (line.to_string(), false)
}

/// Pass 2 — read every selected candidate and apply the regex.
///
/// Owns all output budgets (results, matched-content bytes, bytes
/// read), the deadline check, and the cancellation cadence. The result
/// separates proven truncation from an unproved result-limit stop.
fn read_candidates(
    candidates: &[PathBuf],
    regex: &regex::Regex,
    budget: &mut GrepBudget,
    counters: &mut GrepCounters,
    cancel_token: Option<&CancellationToken>,
    output: &mut ModeOutput,
    opts: &SearchOptions,
) -> SearchOutcome {
    let mut sampled_more = false;
    for (files_examined, file_path) in candidates.iter().enumerate() {
        let result_spent_before_file = budget.remaining_results == 0;
        let match_bytes_spent_before_file = budget.remaining_match_bytes == 0;
        let more_candidates = files_examined + 1 < candidates.len();
        let unproved_limit = if result_spent_before_file {
            Some(TruncationReason::Results)
        } else if opts.mode == OutputMode::Content && match_bytes_spent_before_file {
            Some(TruncationReason::MatchBytes)
        } else {
            None
        };
        // Cancellation first: it outranks every budget reason.  Keyed
        // to files examined, not to `matches.len()` — a match count
        // stops advancing across non-matching files, which let a long
        // read pass run to completion with the token already set.
        if files_examined % CANCELLATION_CHECK_INTERVAL == 0 {
            if let Some(token) = cancel_token {
                if token.is_cancelled() {
                    return SearchOutcome::truncated(TruncationReason::Cancelled);
                }
            }
        }
        if budget.deadline_passed() {
            return SearchOutcome::truncated(TruncationReason::Deadline);
        }
        if budget.remaining_bytes == 0 {
            return SearchOutcome::truncated(TruncationReason::Bytes);
        }
        let meta = match std::fs::metadata(file_path) {
            Ok(m) => m,
            Err(_) => {
                counters.skipped_unreadable += 1;
                if more_candidates {
                    if let Some(reason) = unproved_limit {
                        return SearchOutcome::not_determined(reason);
                    }
                }
                continue;
            }
        };
        if meta.len() > MAX_FILE_SIZE {
            counters.skipped_large += 1;
            if more_candidates {
                if let Some(reason) = unproved_limit {
                    return SearchOutcome::not_determined(reason);
                }
            }
            continue;
        }
        if meta.len() > budget.remaining_bytes {
            return SearchOutcome::truncated(TruncationReason::Bytes);
        }

        let content_bytes = match std::fs::read(file_path) {
            Ok(c) => c,
            Err(_) => {
                counters.skipped_unreadable += 1;
                if more_candidates {
                    if let Some(reason) = unproved_limit {
                        return SearchOutcome::not_determined(reason);
                    }
                }
                continue;
            }
        };
        let bytes_read = content_bytes.len() as u64;
        counters.bytes_read += bytes_read;
        budget.remaining_bytes = budget.remaining_bytes.saturating_sub(bytes_read);

        let (content, encoding) = match grep_decode(&content_bytes) {
            Some(decoded) => decoded,
            None => {
                counters.skipped_binary += 1;
                if more_candidates {
                    if let Some(reason) = unproved_limit {
                        return SearchOutcome::not_determined(reason);
                    }
                }
                continue;
            }
        };
        if encoding != "utf-8" {
            // `lc_read_file` announces the encoding it returned. Grep
            // transcoded the same bytes and used to say nothing, so a
            // match could come from a UTF-16 file with no sign of it.
            counters.files_transcoded += 1;
        }

        let abs_path = file_path.to_string_lossy().to_string();
        // Context needs random access to a match's neighbours. Without
        // it, a lazy scan avoids materialising every line of every file
        // for a window nothing reads.
        let indexed: Option<Vec<&str>> =
            (opts.context_lines > 0).then(|| content.lines().collect());
        let content_file = ContentFileContext {
            indexed: indexed.as_deref(),
            abs_path: &abs_path,
            encoding,
        };
        let mut file_matches: usize = 0;
        let mut sample_cap_reached = false;
        for (index, line) in content.lines().enumerate() {
            if !regex.is_match(line) {
                continue;
            }
            // A further matching line proves that a spent result budget
            // omitted output. Non-matching lines do not prove truncation.
            if opts.mode == OutputMode::Content && budget.remaining_results == 0 {
                return SearchOutcome::truncated(TruncationReason::Results);
            }
            if sample_cap_reached {
                sampled_more = true;
                break;
            }
            match opts.mode {
                OutputMode::FilesWithMatches => {
                    if budget.remaining_results == 0 {
                        return SearchOutcome::truncated(TruncationReason::Results);
                    }
                    if let ModeOutput::Files(files) = output {
                        files.push(abs_path.clone());
                    }
                    budget.remaining_results -= 1;
                    // The rest of this file adds nothing in this mode.
                    break;
                }
                OutputMode::Count => {
                    if let ModeOutput::Counts(counts) = output {
                        match counts.last_mut() {
                            // Already counting this file. Further
                            // matches cost no budget: the result unit
                            // in this mode is the file row, not the
                            // match. Charging per match would cap a
                            // count at `max_results` and report a floor
                            // as if it were a total.
                            Some(last) if last.0 == abs_path => last.1 += 1,
                            _ => {
                                if budget.remaining_results == 0 {
                                    return SearchOutcome::truncated(TruncationReason::Results);
                                }
                                counts.push((abs_path.clone(), 1));
                                budget.remaining_results -= 1;
                            }
                        }
                    }
                    file_matches += 1;
                }
                OutputMode::Content => {
                    if let Some(reason) =
                        push_content_match(&content_file, line, index, budget, output, opts)
                    {
                        return SearchOutcome::truncated(reason);
                    }
                    file_matches += 1;
                    budget.remaining_results -= 1;
                }
            }
            if let Some(cap) = opts.max_matches_per_file {
                if file_matches >= cap {
                    // The file is already in memory. Continue only until
                    // another match proves that sampling omitted output.
                    sample_cap_reached = true;
                }
            }
        }

        if more_candidates && budget.remaining_results == 0 {
            if sampled_more {
                return SearchOutcome::truncated(TruncationReason::PerFileMatches);
            }
            if result_spent_before_file {
                return SearchOutcome::not_determined(TruncationReason::Results);
            }
            continue;
        }
        if more_candidates
            && opts.mode == OutputMode::Content
            && budget.remaining_match_bytes == 0
        {
            if sampled_more {
                return SearchOutcome::truncated(TruncationReason::PerFileMatches);
            }
            if match_bytes_spent_before_file {
                return SearchOutcome::not_determined(TruncationReason::MatchBytes);
            }
        }
    }
    if sampled_more {
        SearchOutcome::truncated(TruncationReason::PerFileMatches)
    } else {
        SearchOutcome::complete()
    }
}

struct ContentFileContext<'a> {
    indexed: Option<&'a [&'a str]>,
    abs_path: &'a str,
    encoding: &'a str,
}

/// Build and push one content-mode match, with its context lines when
/// requested. Context is charged to the same matched-content budget as
/// the match itself, capped at the same length.
fn push_content_match(
    file: &ContentFileContext<'_>,
    line: &str,
    index: usize,
    budget: &mut GrepBudget,
    output: &mut ModeOutput,
    opts: &SearchOptions,
) -> Option<TruncationReason> {
    let (text, content_truncated) = cap_match_line(line);
    let cost = text.len() as u64;
    if cost > budget.remaining_match_bytes {
        return Some(TruncationReason::MatchBytes);
    }
    budget.remaining_match_bytes -= cost;

    let mut entry = serde_json::json!({
        "file": file.abs_path,
        "line": index + 1,
        "content": text,
    });
    if content_truncated {
        // Emitted only when true; absence means the line is
        // complete. Documented in the tool description.
        entry["content_truncated"] = serde_json::json!(true);
    }
    if file.encoding != "utf-8" {
        // Same rule: present only when notable. This line came out of a
        // transcode, so its bytes on disk are not what is shown here.
        entry["encoding"] = serde_json::json!(file.encoding);
    }
    // `indexed` is present exactly when context was requested.
    if let Some(all_lines) = file.indexed.filter(|_| opts.context_lines > 0) {
        let n = opts.context_lines;
        let mut before: Vec<serde_json::Value> = Vec::new();
        let before_start = index.saturating_sub(n);
        if let Some(reason) = push_context(&mut before, all_lines, before_start..index, budget) {
            return Some(reason);
        }
        let after_end = (index + 1 + n).min(all_lines.len());
        let mut after: Vec<serde_json::Value> = Vec::new();
        if let Some(reason) = push_context(&mut after, all_lines, (index + 1)..after_end, budget) {
            return Some(reason);
        }
        // Adjacent matches can share context lines; each match carries
        // its own window rather than merging, so line numbers stay
        // attached to the match that requested them.
        if !before.is_empty() {
            entry["before"] = serde_json::json!(before);
        }
        if !after.is_empty() {
            entry["after"] = serde_json::json!(after);
        }
    }
    if let ModeOutput::Content(matches) = output {
        matches.push(entry);
    }
    None
}

/// Capped, line-numbered context lines charged to the match-bytes
/// budget.
fn push_context(
    target: &mut Vec<serde_json::Value>,
    all_lines: &[&str],
    range: std::ops::Range<usize>,
    budget: &mut GrepBudget,
) -> Option<TruncationReason> {
    for i in range {
        let (text, cut) = cap_match_line(all_lines[i]);
        let cost = text.len() as u64;
        if cost > budget.remaining_match_bytes {
            return Some(TruncationReason::MatchBytes);
        }
        budget.remaining_match_bytes -= cost;
        let mut obj = serde_json::json!({ "line": i + 1, "content": text });
        if cut {
            obj["content_truncated"] = serde_json::json!(true);
        }
        target.push(obj);
    }
    None
}

/// Decode candidate content for search. BOM-marked UTF-16 is transcoded
/// with `lc_read_file`'s decoder, so output from cmd's `/u` flag is
/// searchable; a malformed marked stream is skipped like other binary
/// content. Everything else keeps grep's deliberately permissive rule
/// (`is_binary`), documented in the tool description.
fn grep_decode(content_bytes: &[u8]) -> Option<(String, &'static str)> {
    if let Some(kind) = super::fs_ops::utf16_bom(content_bytes) {
        return super::fs_ops::decode_utf16(&content_bytes[2..], kind)
            .map(|text| (text, kind.label()));
    }
    if is_binary(content_bytes) {
        return None;
    }
    Some((
        String::from_utf8_lossy(content_bytes).into_owned(),
        "utf-8",
    ))
}

/// Binary sniff.  Two checks over the raw bytes, never over a decoded
/// string.
///
/// The NUL check is what catches unmarked UTF-16: NUL is valid UTF-8, so
/// that content decodes cleanly and the replacement-character
/// heuristic below never fires on it. Without this check the regex
/// runs against `n\0e\0e\0d\0l\0e\0` and can never match, so the file
/// is silently reported as containing nothing.
fn is_binary(content_bytes: &[u8]) -> bool {
    let nul_len = content_bytes.len().min(NUL_SNIFF_BYTES);
    if content_bytes[..nul_len].contains(&0u8) {
        return true;
    }

    let sniff_len = content_bytes.len().min(BINARY_SNIFF_BYTES);
    let window = &content_bytes[..sniff_len];
    // Valid UTF-8 produces no replacement characters, so the decode is
    // only needed once that cheap check fails.
    if std::str::from_utf8(window).is_ok() {
        return false;
    }
    let non_utf8 = String::from_utf8_lossy(window)
        .chars()
        .filter(|c| *c == char::REPLACEMENT_CHARACTER)
        .count();
    non_utf8 > BINARY_NON_UTF8_THRESHOLD
}

/// Path shape a glob is matched against: root-relative with forward
/// slashes (globset never matches `\`), or the basename when `path`
/// targets a single file and the walk yields it as its own root.
fn glob_candidate(file_path: &Path, search_dir: &Path) -> String {
    let rel = file_path
        .strip_prefix(search_dir)
        .map(|r| r.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default();
    if rel.is_empty() {
        file_path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default()
    } else {
        rel
    }
}

/// Pass 1 — walk the tree and select candidate files.
fn select_candidates(
    search_dir: &Path,
    opts: &SearchOptions,
    budget: &mut GrepBudget,
    counters: &mut GrepCounters,
    cancel_token: Option<&CancellationToken>,
) -> (Vec<PathBuf>, Option<TruncationReason>) {
    let mut candidates: Vec<PathBuf> = Vec::new();
    let prune_skip_dirs = !opts.include_excluded_dirs;
    let walker = WalkDir::new(search_dir)
        .follow_links(false)
        .into_iter()
        .filter_entry(move |e| {
            if e.file_type().is_dir() && prune_skip_dirs {
                let name = e.file_name().to_string_lossy();
                !SKIP_DIRS.contains(&name.as_ref())
            } else {
                true
            }
        });

    for entry in walker {
        // Cancellation outranks every budget reason.
        if counters.visited.is_multiple_of(CANCELLATION_CHECK_INTERVAL) {
            if let Some(token) = cancel_token {
                if token.is_cancelled() {
                    return (candidates, Some(TruncationReason::Cancelled));
                }
            }
        }
        if let Some(reason) = budget.walk_stop_reason() {
            return (candidates, Some(reason));
        }

        let entry = match entry {
            Ok(e) => e,
            Err(_) => {
                counters.visited += 1;
                budget.remaining_visited -= 1;
                counters.skipped_unreadable += 1;
                continue;
            }
        };
        let file_path = entry.path().to_path_buf();
        counters.visited += 1;
        budget.remaining_visited -= 1;

        if entry.file_type().is_dir() {
            continue;
        }
        // `follow_links(false)` means a symlink is neither dir nor
        // file here. `lc_list_dir` reports these as `kind: "symlink"`
        // and `lc_glob_files` returns them as matches, so a model does
        // meet them through sibling tools; dropping them with no
        // counter made grep the only silent one.
        if entry.file_type().is_symlink() {
            counters.skipped_symlink += 1;
            continue;
        }
        if !entry.file_type().is_file() {
            continue;
        }

        // Extension-based skip.
        if let Some(ext) = file_path.extension().and_then(|e| e.to_str()) {
            if SKIP_EXTS.contains(&ext.to_lowercase().as_str()) {
                counters.skipped_binary += 1;
                continue;
            }
        }

        // Exclude and include use the same dialect and path shape.
        // Exclude first: it is the cheaper question when both are set.
        let candidate = glob_candidate(&file_path, search_dir);
        if let Some(glob) = opts.exclude {
            if glob.is_match(&candidate) {
                continue;
            }
        }
        if let Some(glob) = opts.include {
            if !glob.is_match(&candidate) {
                continue;
            }
        }

        // Size check.
        match std::fs::metadata(&file_path) {
            Ok(m) if m.len() <= MAX_FILE_SIZE => {}
            Ok(_) => {
                counters.skipped_large += 1;
                continue;
            }
            Err(_) => {
                counters.skipped_unreadable += 1;
                continue;
            }
        }

        candidates.push(file_path);
    }

    (candidates, None)
}

fn grep_single_dir(
    path: &str,
    roots: &[PathBuf],
    pattern: &str,
    ignore_case: Option<bool>,
    budget: &mut GrepBudget,
    cancel_token: Option<&CancellationToken>,
    opts: &SearchOptions,
) -> serde_json::Value {
    let mut counters = GrepCounters::default();

    let search_dir = match resolve_under_roots(path, roots) {
        Ok(d) => d,
        Err(e) => {
            return grep_entry(
                path,
                pattern,
                ModeOutput::Content(Vec::new()),
                SearchOutcome::complete(),
                Some("read_failed"),
                Some(&e.to_string()),
                &counters,
            )
        }
    };

    let ignore_case = ignore_case.unwrap_or(false);

    // Build regex — reject invalid patterns explicitly (no silent
    // fallback to literal matching).
    let regex = if ignore_case {
        regex::RegexBuilder::new(pattern)
            .case_insensitive(true)
            .build()
    } else {
        regex::Regex::new(pattern)
    };
    let regex = match regex {
        Ok(re) => re,
        Err(e) => {
            return grep_entry(
                path,
                pattern,
                ModeOutput::Content(Vec::new()),
                SearchOutcome::complete(),
                Some("invalid_regex"),
                Some(&format!("invalid_regex: {}", e)),
                &counters,
            )
        }
    };

    // Pass 1: collect candidates.
    let (mut candidates, walk_stop) =
        select_candidates(&search_dir, opts, budget, &mut counters, cancel_token);
    // Sort for deterministic, stable output across platforms.
    candidates.sort();
    counters.files_selected = candidates.len();

    // Pass 2 still runs when pass 1 stopped early: the candidates it
    // did collect are real, and discarding them was the whole bug.
    let mut output = match opts.mode {
        OutputMode::Content => ModeOutput::Content(Vec::new()),
        OutputMode::FilesWithMatches => ModeOutput::Files(Vec::new()),
        OutputMode::Count => ModeOutput::Counts(Vec::new()),
    };
    let read_outcome = if matches!(walk_stop, Some(TruncationReason::Cancelled)) {
        // Cancellation is the exception: do not start reading.
        SearchOutcome::truncated(TruncationReason::Cancelled)
    } else {
        read_candidates(
            &candidates,
            &regex,
            budget,
            &mut counters,
            cancel_token,
            &mut output,
            opts,
        )
    };

    // A proven stop outranks an unproved result-budget stop. Otherwise,
    // pass 2 names where work ended, as before.
    let outcome = match (read_outcome.completeness, walk_stop) {
        (Completeness::Truncated, Some(reason))
            if read_outcome.reason == Some(TruncationReason::PerFileMatches) =>
        {
            SearchOutcome::truncated(reason)
        }
        (Completeness::Truncated, _) => read_outcome,
        (Completeness::NotDetermined, Some(reason)) => SearchOutcome::truncated(reason),
        (Completeness::NotDetermined, None) => read_outcome,
        (Completeness::Complete, Some(reason)) => SearchOutcome::truncated(reason),
        (Completeness::Complete, None) => read_outcome,
    };
    grep_entry(path, pattern, output, outcome, None, None, &counters)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn grep_batch_limit_rejects_cap_plus_one_before_io() {
        let error = tool_grep(GrepRequest {
            searches: (0..=super::super::fs_ops::FILESYSTEM_BATCH_MAX_ENTRIES)
                .map(|index| GrepSearchEntry {
                    path: format!("missing-{index}"),
                    pattern: "x".into(),
                    include: None,
                })
                .collect(),
            include: None,
            exclude: None,
            ignore_case: None,
            max_results: None,
            context_lines: None,
            output_mode: None,
            max_matches_per_file: None,
            include_excluded_dirs: None,
            allowed_roots: None,
            call_id: None,
            group_id: None,
            max_visited_entries: None,
            max_bytes_read: None,
            deadline_ms: None,
        })
        .await
        .expect_err("grep cap + 1 must fail before I/O");
        assert!(error.to_string().contains("searches contains 21 entries"));
        assert!(error.to_string().contains("batches of 20 or fewer"));
    }

    #[test]
    fn result_limit_defaults_and_clamps_at_native_boundary() {
        assert_eq!(effective_max_results(None), DEFAULT_MAX_RESULTS);
        assert_eq!(
            effective_max_results(Some(HARD_CAP_RESULTS)),
            HARD_CAP_RESULTS
        );
        assert_eq!(
            effective_max_results(Some(HARD_CAP_RESULTS + 1)),
            HARD_CAP_RESULTS
        );
    }

    fn test_root(label: &str) -> PathBuf {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "lc-grep-{}-{}-{}",
            label,
            std::process::id(),
            unique
        ))
    }

    /// Compile an `include` filter the same way `tool_grep` does.
    fn include_set(pattern: &str) -> globset::GlobSet {
        build_glob_set(&expand_braces(pattern)).expect("valid include pattern")
    }

    fn budget() -> GrepBudget {
        GrepBudget {
            remaining_results: 100,
            remaining_visited: 1000,
            remaining_bytes: 1_000_000,
            remaining_match_bytes: DEFAULT_MAX_MATCH_BYTES,
            deadline: None,
        }
    }

    fn matched_files(result: &serde_json::Value) -> Vec<String> {
        result["matches"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["file"].as_str().unwrap().to_string())
            .collect()
    }

    fn run(root: &Path, pattern: &str, budget: &mut GrepBudget) -> serde_json::Value {
        run_with(root, pattern, budget, &SearchOptions::default())
    }

    fn run_with(
        root: &Path,
        pattern: &str,
        budget: &mut GrepBudget,
        opts: &SearchOptions,
    ) -> serde_json::Value {
        let roots = merged_roots(&[root.to_string_lossy().to_string()]);
        grep_single_dir(
            &root.to_string_lossy(),
            &roots,
            pattern,
            None,
            budget,
            None,
            opts,
        )
    }

    /// Every diagnostic counter, by name. Absence must never have to be
    /// told apart from zero, so all of these are required on every entry.
    const DIAGNOSTIC_FIELDS: &[&str] = &[
        "visited_entries",
        "files_selected",
        "bytes_read",
        "skipped_large",
        "skipped_binary",
        "skipped_symlink",
        "skipped_unreadable",
        "files_transcoded",
    ];

    fn assert_full_diagnostics(entry: &serde_json::Value, context: &str) {
        for field in DIAGNOSTIC_FIELDS {
            assert!(
                entry.get(field).is_some_and(|v| v.is_number()),
                "{context}: missing numeric `{field}` in {entry}"
            );
        }
    }

    #[test]
    fn fixed_exclusion_catalogs_match_the_public_contract() {
        assert_eq!(
            SKIP_DIRS,
            [
                ".git",
                "node_modules",
                "target",
                "__pycache__",
                ".venv",
                "venv",
                ".env",
                "dist",
                "build",
                ".next",
                ".nuxt",
                ".cache",
                "coverage",
                ".idea",
                ".vscode",
            ]
        );
        assert_eq!(
            SKIP_EXTS,
            [
                "exe", "dll", "so", "dylib", "bin", "png", "jpg", "jpeg", "gif", "ico", "webp",
                "bmp", "woff", "woff2", "ttf", "eot", "pdf", "zip", "tar", "gz", "7z", "rar",
            ]
        );
    }

    #[test]
    fn include_matches_files_in_subdirectories() {
        let root = test_root("include-subdir");
        std::fs::create_dir_all(root.join("pkg")).unwrap();
        std::fs::write(root.join("pkg/mod.py"), "needle").unwrap();
        std::fs::write(root.join("pkg/mod.rs"), "needle").unwrap();
        let roots = merged_roots(&[root.to_string_lossy().to_string()]);

        let py_only = include_set("*.py");
        let result = grep_single_dir(
            &root.to_string_lossy(),
            &roots,
            "needle",
            None,
            &mut budget(),
            None,
            &SearchOptions {
                include: Some(&py_only),
                ..Default::default()
            },
        );

        let files = matched_files(&result);
        assert_eq!(files.len(), 1, "got {:?}", files);
        assert!(files[0].ends_with("mod.py"), "got {:?}", files);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn include_supports_brace_expansion() {
        let root = test_root("include-braces");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("a.ts"), "needle").unwrap();
        std::fs::write(root.join("b.tsx"), "needle").unwrap();
        std::fs::write(root.join("c.md"), "needle").unwrap();
        let roots = merged_roots(&[root.to_string_lossy().to_string()]);

        let ts_only = include_set("*.{ts,tsx}");
        let result = grep_single_dir(
            &root.to_string_lossy(),
            &roots,
            "needle",
            None,
            &mut budget(),
            None,
            &SearchOptions {
                include: Some(&ts_only),
                ..Default::default()
            },
        );

        assert_eq!(matched_files(&result).len(), 2);
        std::fs::remove_dir_all(root).unwrap();
    }

    /// A single-file `path` walks that file as its own root, so the
    /// relative path is empty. It used to fail every include pattern,
    /// silently dropping file targets from a mixed batch.
    #[test]
    fn include_applies_to_single_file_targets() {
        let root = test_root("include-single-file");
        std::fs::create_dir_all(&root).unwrap();
        let py = root.join("solo.py");
        std::fs::write(&py, "needle").unwrap();
        let roots = merged_roots(&[root.to_string_lossy().to_string()]);

        let py_glob = include_set("*.py");
        let hit = grep_single_dir(
            &py.to_string_lossy(),
            &roots,
            "needle",
            None,
            &mut budget(),
            None,
            &SearchOptions {
                include: Some(&py_glob),
                ..Default::default()
            },
        );
        assert_eq!(hit["matches"].as_array().unwrap().len(), 1);
        assert_eq!(hit["files_selected"], 1);

        // A non-matching filter must still exclude it.
        let md_glob = include_set("*.md");
        let miss = grep_single_dir(
            &py.to_string_lossy(),
            &roots,
            "needle",
            None,
            &mut budget(),
            None,
            &SearchOptions {
                include: Some(&md_glob),
                ..Default::default()
            },
        );
        assert_eq!(miss["matches"].as_array().unwrap().len(), 0);
        assert_eq!(miss["files_selected"], 0);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn invalid_include_pattern_fails_the_call() {
        let root = test_root("include-invalid");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("a.py"), "needle").unwrap();

        let result = tool_grep(GrepRequest {
            searches: vec![GrepSearchEntry {
                path: root.to_string_lossy().to_string(),
                pattern: "needle".to_string(),
                include: None,
            }],
            include: Some("[".to_string()),
            exclude: None,
            ignore_case: None,
            max_results: None,
            context_lines: None,
            output_mode: None,
            max_matches_per_file: None,
            include_excluded_dirs: None,
            allowed_roots: Some(vec![root.to_string_lossy().to_string()]),
            call_id: None,
            group_id: None,
            max_visited_entries: None,
            max_bytes_read: None,
            deadline_ms: None,
        })
        .await;

        assert!(result.is_err(), "invalid include glob must fail the call");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn tool_grep_whitespace_include_is_unfiltered() {
        let root = test_root("grep-ws-include");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("a.py"), "needle").unwrap();
        std::fs::write(root.join("b.rs"), "needle").unwrap();

        let result = tool_grep(GrepRequest {
            searches: vec![GrepSearchEntry {
                path: root.to_string_lossy().to_string(),
                pattern: "needle".to_string(),
                include: None,
            }],
            include: Some("   ".to_string()),
            exclude: None,
            ignore_case: None,
            max_results: None,
            context_lines: None,
            output_mode: None,
            max_matches_per_file: None,
            include_excluded_dirs: None,
            allowed_roots: Some(vec![root.to_string_lossy().to_string()]),
            call_id: None,
            group_id: None,
            max_visited_entries: None,
            max_bytes_read: None,
            deadline_ms: None,
        })
        .await
        .expect("expected Ok");
        let matches = result["results"][0]["matches"].as_array().unwrap();
        assert_eq!(matches.len(), 2, "whitespace include must not filter files");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn result_budget_is_shared_across_searches() {
        let root = test_root("shared-budget");
        std::fs::create_dir_all(root.join("one")).unwrap();
        std::fs::create_dir_all(root.join("two")).unwrap();
        std::fs::write(root.join("one/a.txt"), "needle one").unwrap();
        std::fs::write(root.join("two/b.txt"), "needle two").unwrap();
        let roots = merged_roots(&[root.to_string_lossy().to_string()]);
        let mut budget = GrepBudget {
            remaining_results: 1,
            remaining_visited: 100,
            remaining_bytes: 1024,
            remaining_match_bytes: DEFAULT_MAX_MATCH_BYTES,
            deadline: None,
        };

        let first = grep_single_dir(
            &root.join("one").to_string_lossy(),
            &roots,
            "needle",
            None,
            &mut budget,
            None,
            &SearchOptions::default(),
        );
        let second = grep_single_dir(
            &root.join("two").to_string_lossy(),
            &roots,
            "needle",
            None,
            &mut budget,
            None,
            &SearchOptions::default(),
        );

        assert_eq!(first["matches"].as_array().unwrap().len(), 1);
        assert_eq!(second["matches"].as_array().unwrap().len(), 0);
        assert_eq!(second["truncated"], true);
        // The second search proved a further match existed, so the
        // result budget is the honest cause.
        assert_eq!(second["truncated_reason"], "results");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reports_files_rejected_by_large_file_guard() {
        let root = test_root("large-file");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            root.join("large.txt"),
            vec![b'x'; MAX_FILE_SIZE as usize + 1],
        )
        .unwrap();
        let mut b = GrepBudget {
            remaining_bytes: 2 * MAX_FILE_SIZE,
            ..budget()
        };

        let result = run(&root, "needle", &mut b);

        assert_eq!(result["skipped_large"], 1);
        std::fs::remove_dir_all(root).unwrap();
    }

    // ── F1 / P1 — the visited budget must not discard collected work ──

    /// Pass 1 consumes the visited budget; pass 2 does not. Exhausting
    /// it once discarded every candidate pass 1 had already selected,
    /// so a search over a large tree returned `matches: []` while
    /// reporting a non-zero candidate count.
    #[test]
    fn walk_budget_exhaustion_keeps_collected_matches() {
        let root = test_root("visited-keeps-matches");
        std::fs::create_dir_all(&root).unwrap();
        for name in ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt"] {
            std::fs::write(root.join(name), "needle\n").unwrap();
        }
        // Enough entries to select some candidates, not enough to finish.
        let mut b = GrepBudget {
            remaining_visited: 4,
            ..budget()
        };

        let result = run(&root, "needle", &mut b);

        assert_eq!(result["files_selected"], 3);
        assert_eq!(
            result["matches"].as_array().unwrap().len(),
            3,
            "matches from selected candidates must survive: {result}"
        );
        assert_eq!(result["truncated"], true);
        assert_eq!(result["truncated_reason"], "visited");
        std::fs::remove_dir_all(root).unwrap();
    }

    /// P1a: a later search in the same batch still returns nothing once
    /// the shared visited budget is spent. That is accepted behavior,
    /// but it must not look like a true no-match.
    #[test]
    fn later_batch_search_after_visited_exhaustion_is_distinguishable() {
        let root = test_root("visited-later-search");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("a.txt"), "needle\n").unwrap();
        let mut b = GrepBudget {
            remaining_visited: 0,
            ..budget()
        };

        let result = run(&root, "needle", &mut b);

        assert_eq!(result["matches"].as_array().unwrap().len(), 0);
        assert_eq!(result["truncated"], true);
        assert_eq!(result["truncated_reason"], "visited");
        assert_eq!(result["visited_entries"], 0);
        assert_eq!(result["files_selected"], 0);
        assert_full_diagnostics(&result, "starved batch search");
        std::fs::remove_dir_all(root).unwrap();
    }

    // ── F2 / F9 / P2 — binary policy ──

    fn utf16le(text: &str, bom: bool) -> Vec<u8> {
        let mut bytes = Vec::new();
        if bom {
            bytes.extend_from_slice(&[0xFF, 0xFE]);
        }
        for unit in text.encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        bytes
    }

    fn utf16be(text: &str) -> Vec<u8> {
        let mut bytes = vec![0xFE, 0xFF];
        for unit in text.encode_utf16() {
            bytes.extend_from_slice(&unit.to_be_bytes());
        }
        bytes
    }

    /// UTF-16 text decodes as valid UTF-8 (NUL is a legal code point),
    /// so the replacement-character heuristic never fired on it. The
    /// regex then ran against `n\0e\0e\0d\0l\0e\0`, matched nothing,
    /// and the file was reported as containing no matches at all.
    #[test]
    fn utf16le_with_bom_is_searched_via_transcoding() {
        let root = test_root("utf16le");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("log.txt"), utf16le("needle here\n", true)).unwrap();

        let result = run(&root, "needle", &mut budget());

        assert_eq!(
            result["matches"].as_array().unwrap().len(),
            1,
            "BOM-marked UTF-16 is transcoded and searched: {result}"
        );
        assert_eq!(
            result["skipped_binary"], 0,
            "a transcoded file is not binary: {result}"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn utf16be_with_bom_is_searched_via_transcoding() {
        let root = test_root("utf16be");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("log.txt"), utf16be("needle here\n")).unwrap();

        let result = run(&root, "needle", &mut budget());

        assert_eq!(result["matches"].as_array().unwrap().len(), 1);
        assert_eq!(result["skipped_binary"], 0);
        std::fs::remove_dir_all(root).unwrap();
    }

    /// A malformed marked stream (odd trailing byte) is skipped like
    /// binary content rather than partially decoded.
    #[test]
    fn malformed_utf16_behind_a_bom_is_skipped() {
        let root = test_root("utf16-broken");
        std::fs::create_dir_all(&root).unwrap();
        let mut bytes = utf16le("needle here\n", true);
        bytes.push(b'x'); // odd trailing byte
        std::fs::write(root.join("log.txt"), bytes).unwrap();

        let result = run(&root, "needle", &mut budget());

        assert_eq!(result["matches"].as_array().unwrap().len(), 0);
        assert_eq!(result["skipped_binary"], 1);
        std::fs::remove_dir_all(root).unwrap();
    }

    /// A BOM-less UTF-16LE file of pure ASCII is the case that made
    /// this invisible: every byte is valid UTF-8.
    #[test]
    fn bom_less_utf16_is_still_reported_as_binary() {
        let root = test_root("utf16-nobom");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("log.txt"), utf16le("needle here\n", false)).unwrap();

        let result = run(&root, "needle", &mut budget());

        assert_eq!(result["matches"].as_array().unwrap().len(), 0);
        assert_eq!(result["skipped_binary"], 1);
        std::fs::remove_dir_all(root).unwrap();
    }

    /// F9: `lc_read_file` calls a file binary when a NUL appears in the
    /// first 8 KiB (`fs_ops.rs`). Grep must draw the line in the same
    /// place, or one tool refuses a file the other happily searches.
    #[test]
    fn nul_policy_matches_read_file_binary_detected() {
        assert_eq!(
            NUL_SNIFF_BYTES, 8_192,
            "grep's NUL window must equal the one lc_read_file uses"
        );

        let root = test_root("nul-window");
        std::fs::create_dir_all(&root).unwrap();

        // NUL inside the shared window: binary for both tools.
        let mut inside = b"needle\n".to_vec();
        inside.extend_from_slice(&[b'x'; 100]);
        inside.push(0);
        std::fs::write(root.join("inside.txt"), &inside).unwrap();

        let result = run(&root, "needle", &mut budget());
        assert_eq!(result["matches"].as_array().unwrap().len(), 0);
        assert_eq!(result["skipped_binary"], 1);

        // NUL beyond the shared window: text for both tools.
        std::fs::remove_file(root.join("inside.txt")).unwrap();
        let mut outside = b"needle\n".to_vec();
        outside.extend_from_slice(&vec![b'x'; NUL_SNIFF_BYTES + 500]);
        outside.push(0);
        std::fs::write(root.join("outside.txt"), &outside).unwrap();

        let result = run(&root, "needle", &mut budget());
        assert_eq!(
            result["matches"].as_array().unwrap().len(),
            1,
            "a NUL past the window must not make the file binary: {result}"
        );
        assert_eq!(result["skipped_binary"], 0);
        std::fs::remove_dir_all(root).unwrap();
    }

    /// P7 replaces four tests that walked char boundaries on a local
    /// `String` — logic production never ran. This exercises the real
    /// sniff instead: a multi-byte character straddling the window must
    /// not make a UTF-8 file look binary.
    #[test]
    fn utf8_multibyte_at_sniff_boundary_stays_searchable() {
        let root = test_root("sniff-boundary");
        std::fs::create_dir_all(&root).unwrap();
        // Place '€' (3 bytes) so the 64 KiB mark lands mid-character.
        let mut content = "a".repeat(BINARY_SNIFF_BYTES - 1);
        content.push('€');
        content.push_str("\nneedle\n");
        std::fs::write(root.join("wide.txt"), content.as_bytes()).unwrap();

        let result = run(&root, "needle", &mut budget());

        assert_eq!(
            result["matches"].as_array().unwrap().len(),
            1,
            "multi-byte char at the window edge must not trip the sniff: {result}"
        );
        assert_eq!(result["skipped_binary"], 0);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn true_binary_content_is_still_skipped() {
        let root = test_root("real-binary");
        std::fs::create_dir_all(&root).unwrap();
        // No NUL, but dense invalid UTF-8 past the threshold.
        let junk = vec![0xC0u8; BINARY_NON_UTF8_THRESHOLD * 2 + 10];
        std::fs::write(root.join("blob.dat"), junk).unwrap();

        let result = run(&root, "needle", &mut budget());

        assert_eq!(result["skipped_binary"], 1);
        std::fs::remove_dir_all(root).unwrap();
    }

    // ── F3 / P3 / P3b — payload bounds ──

    #[test]
    fn long_line_is_capped_and_flagged() {
        let root = test_root("long-line");
        std::fs::create_dir_all(&root).unwrap();
        let line = format!("{}needle{}", "x".repeat(5_000), "y".repeat(5_000));
        std::fs::write(root.join("minified.js"), line).unwrap();

        let result = run(&root, "needle", &mut budget());

        let matches = result["matches"].as_array().unwrap();
        assert_eq!(matches.len(), 1);
        let content = matches[0]["content"].as_str().unwrap();
        assert_eq!(content.chars().count(), MAX_MATCH_LINE_CHARS);
        assert_eq!(matches[0]["content_truncated"], true);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn short_line_is_not_flagged_as_truncated() {
        let root = test_root("short-line");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("a.txt"), "needle\n").unwrap();

        let result = run(&root, "needle", &mut budget());

        let matches = result["matches"].as_array().unwrap();
        assert_eq!(matches[0]["content"], "needle");
        assert!(
            matches[0].get("content_truncated").is_none(),
            "absence means the line is complete"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    /// The per-line cap bounds one match. Without a call-wide budget,
    /// 1000 capped matches still return ~2 MB.
    #[test]
    fn total_match_bytes_budget_stops_the_call() {
        let root = test_root("match-bytes");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("a.txt"), "needle one\nneedle two\nneedle three\n").unwrap();
        let mut b = GrepBudget {
            remaining_match_bytes: 15, // enough for one line, not two
            ..budget()
        };

        let result = run(&root, "needle", &mut b);

        assert_eq!(result["matches"].as_array().unwrap().len(), 1);
        assert_eq!(result["truncated"], true);
        assert_eq!(result["truncated_reason"], "match_bytes");
        std::fs::remove_dir_all(root).unwrap();
    }

    // ── F11 — truncation must be provable ──

    /// A spent result budget cannot prove that another match exists.
    /// The result reports that completeness was not determined instead
    /// of asserting that output was omitted.
    #[test]
    fn spent_result_budget_reports_not_determined_without_a_proof_scan() {
        let root = test_root("results-lean");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("a_hit.txt"), "needle
needle
needle
").unwrap();
        // Files the old proof scan would have opened looking for proof.
        for index in 0..200 {
            std::fs::write(root.join(format!("z{index:04}.txt")), "x".repeat(500)).unwrap();
        }
        let mut b = GrepBudget {
            remaining_results: 3,
            remaining_bytes: 50_000_000,
            ..budget()
        };

        let result = run(&root, "needle", &mut b);

        assert_eq!(result["matches"].as_array().unwrap().len(), 3);
        assert!(result["truncated"].is_null());
        assert_eq!(result["truncated_reason"], "results");
        // One bounded proof candidate was read. The remaining files were not.
        let read = result["bytes_read"].as_u64().unwrap();
        assert!(read < 1_000, "bounded proof scan: read {read} bytes");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn result_proof_scan_attempts_only_one_unreadable_candidate() {
        let root = test_root("results-unreadable-proof");
        std::fs::create_dir_all(&root).unwrap();
        let candidates = vec![
            root.join("missing-1.txt"),
            root.join("missing-2.txt"),
            root.join("missing-3.txt"),
        ];
        let mut b = GrepBudget {
            remaining_results: 0,
            ..budget()
        };
        let mut counters = GrepCounters::default();
        let outcome = read_candidates(
            &candidates,
            &regex::Regex::new("needle").unwrap(),
            &mut b,
            &mut counters,
            None,
            &mut ModeOutput::Content(Vec::new()),
            &SearchOptions::default(),
        );

        assert_eq!(
            outcome,
            SearchOutcome::not_determined(TruncationReason::Results)
        );
        assert_eq!(counters.skipped_unreadable, 1);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn one_more_match_than_budget_is_reported_truncated() {
        let root = test_root("one-over");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("a.txt"), "needle\nneedle\nneedle\n").unwrap();
        let mut b = GrepBudget {
            remaining_results: 2,
            ..budget()
        };

        let result = run(&root, "needle", &mut b);

        assert_eq!(result["matches"].as_array().unwrap().len(), 2);
        assert_eq!(result["truncated"], true);
        assert_eq!(result["truncated_reason"], "results");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn exact_result_cap_at_end_is_reported_complete() {
        let root = test_root("exact-cap");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("a.txt"), "needle\nneedle\n").unwrap();
        let mut b = GrepBudget {
            remaining_results: 2,
            ..budget()
        };

        let result = run(&root, "needle", &mut b);

        assert_eq!(result["matches"].as_array().unwrap().len(), 2);
        assert_eq!(result["truncated"], false);
        assert!(result.get("truncated_reason").is_none());
        std::fs::remove_dir_all(root).unwrap();
    }

    // ── P3b — reason precedence ──

    /// Causes coincide. Without a fixed order, two runs of one query
    /// could name different causes for the same stop.
    #[test]
    fn truncated_reason_follows_documented_precedence() {
        let root = test_root("reason-precedence");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("a.txt"), "needle\n").unwrap();
        let expired = Instant::now()
            .checked_sub(std::time::Duration::from_secs(1))
            .unwrap();

        // Deadline outranks every output budget.
        let mut all_spent = GrepBudget {
            remaining_results: 0,
            remaining_visited: 100,
            remaining_bytes: 100,
            remaining_match_bytes: 0,
            deadline: Some(expired),
        };
        let deadline = run(&root, "needle", &mut all_spent);
        assert_eq!(deadline["truncated_reason"], "deadline");

        // A matching line proves results before matched-content bytes.
        let mut results_and_match = GrepBudget {
            remaining_results: 0,
            remaining_match_bytes: 0,
            ..budget()
        };
        let results = run(&root, "needle", &mut results_and_match);
        assert_eq!(results["truncated_reason"], "results");

        // The read pass does not consume the visited budget.
        let visited_spent = GrepBudget {
            remaining_visited: 0,
            ..budget()
        };
        assert_eq!(
            visited_spent.walk_stop_reason(),
            Some(TruncationReason::Visited)
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    // ── F4 / P4 — cancellation cadence ──

    /// The read pass checked the token on `matches.len() % 100`. A match
    /// count stops advancing across non-matching files, so a search
    /// holding 1 match could scan 100,000 more files without ever
    /// looking at the token again. Seeding one match reproduces exactly
    /// that state: the old cadence never fired, the new one does.
    #[test]
    fn read_pass_checks_cancellation_on_files_not_matches() {
        let root = test_root("cancel-cadence");
        std::fs::create_dir_all(&root).unwrap();
        let mut candidates = Vec::new();
        for index in 0..150 {
            let path = root.join(format!("f{index}.txt"));
            std::fs::write(&path, "nothing here\n").unwrap();
            candidates.push(path);
        }
        let token = CancellationToken::new();
        token.cancel();

        // Pre-seed a match so `matches.len() % 100` is never 0.
        let mut output = ModeOutput::Content(vec![
            serde_json::json!({"file": "seed", "line": 1, "content": "seed"}),
        ]);
        let outcome = read_candidates(
            &candidates,
            &regex::Regex::new("needle").unwrap(),
            &mut budget(),
            &mut GrepCounters::default(),
            Some(&token),
            &mut output,
            &SearchOptions::default(),
        );

        assert_eq!(
            outcome,
            SearchOutcome::truncated(TruncationReason::Cancelled),
            "cancellation must be observed regardless of match count"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    /// Cancellation is a normal truncated result that keeps what it
    /// collected — the contract `lc_glob_files` already documents.
    /// `error: "aborted"` is gone, so `error` now means a real failure.
    ///
    /// Asserted at the single constructor every entry is built through,
    /// because `tool_grep` mints its own token internally: a caller
    /// cannot hand it a pre-cancelled one.
    #[test]
    fn cancellation_is_truncated_not_error() {
        let entry = grep_entry(
            "some/path",
            "needle",
            ModeOutput::Content(Vec::new()),
            SearchOutcome::truncated(TruncationReason::Cancelled),
            None,
            None,
            &GrepCounters::default(),
        );

        assert_eq!(entry["truncated"], true);
        assert_eq!(entry["truncated_reason"], "cancelled");
        assert!(
            entry.get("error").is_none(),
            "cancellation must not be reported as an error: {entry}"
        );
        assert_full_diagnostics(&entry, "cancelled entry");
    }

    /// Both passes must surface cancellation as that reason, so the
    /// constructor above is reached from the real code paths.
    #[test]
    fn both_passes_report_cancellation() {
        let root = test_root("cancel-both-passes");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("a.txt"), "needle\n").unwrap();
        let token = CancellationToken::new();
        token.cancel();

        let (_candidates, walk_stop) = select_candidates(
            &root,
            &SearchOptions::default(),
            &mut budget(),
            &mut GrepCounters::default(),
            Some(&token),
        );
        assert_eq!(walk_stop, Some(TruncationReason::Cancelled));

        let read_outcome = read_candidates(
            &[root.join("a.txt")],
            &regex::Regex::new("needle").unwrap(),
            &mut budget(),
            &mut GrepCounters::default(),
            Some(&token),
            &mut ModeOutput::Content(Vec::new()),
            &SearchOptions::default(),
        );
        assert_eq!(
            read_outcome,
            SearchOutcome::truncated(TruncationReason::Cancelled)
        );

        // End to end: the whole search reports it too, with no error.
        let roots = merged_roots(&[root.to_string_lossy().to_string()]);
        let entry = grep_single_dir(
            &root.to_string_lossy(),
            &roots,
            "needle",
            None,
            &mut budget(),
            Some(&token),
            &SearchOptions::default(),
        );
        assert_eq!(entry["truncated"], true);
        assert_eq!(entry["truncated_reason"], "cancelled");
        assert!(entry.get("error").is_none());
        std::fs::remove_dir_all(root).unwrap();
    }

    // ── F6 / P5 — one shape for every entry ──

    #[test]
    fn every_entry_carries_all_diagnostic_fields() {
        let root = test_root("all-diagnostics");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("a.txt"), "needle\n").unwrap();
        let roots = merged_roots(&[root.to_string_lossy().to_string()]);

        // Success.
        let ok = run(&root, "needle", &mut budget());
        assert_full_diagnostics(&ok, "success entry");

        // Truncated.
        let mut spent = GrepBudget {
            remaining_results: 0,
            ..budget()
        };
        let truncated = run(&root, "needle", &mut spent);
        assert_full_diagnostics(&truncated, "truncated entry");

        // Invalid regex.
        let bad_regex = grep_single_dir(
            &root.to_string_lossy(),
            &roots,
            "(unclosed",
            None,
            &mut budget(),
            None,
            &SearchOptions::default(),
        );
        assert!(bad_regex["error"]
            .as_str()
            .unwrap()
            .starts_with("invalid_regex"));
        assert_eq!(bad_regex["error_code"], "invalid_regex");
        assert_full_diagnostics(&bad_regex, "invalid regex entry");

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn error_entry_carries_zeroed_diagnostics() {
        let root = test_root("error-diag-root");
        let outside = test_root("error-diag-outside");
        std::fs::create_dir_all(&root).unwrap();
        let roots = merged_roots(&[root.to_string_lossy().into_owned()]);
        let entry = grep_single_dir(
            &outside.to_string_lossy(),
            &roots,
            "needle",
            None,
            &mut budget(),
            None,
            &SearchOptions::default(),
        );

        assert!(entry["error"].is_string());
        assert_eq!(entry["truncated"], false);
        assert_full_diagnostics(&entry, "path error entry");
        assert_eq!(entry["visited_entries"], 0);
        assert_eq!(entry["files_selected"], 0);
        std::fs::remove_dir_all(root).unwrap();
    }

    // ── F10 — hidden files ──

    /// `lc_glob_files` and `lc_list_dir` hide dot-prefixed names by
    /// default; grep searches them. That asymmetry is real and is now
    /// documented rather than silent, so this test pins the behavior
    /// the description promises.
    #[test]
    fn hidden_files_are_searched() {
        let root = test_root("hidden");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join(".secrets.cfg"), "needle\n").unwrap();

        let result = run(&root, "needle", &mut budget());

        let files = matched_files(&result);
        assert_eq!(files.len(), 1, "grep searches dotfiles: {result}");
        assert!(files[0].ends_with(".secrets.cfg"));
        std::fs::remove_dir_all(root).unwrap();
    }

    // ── P9 — the last silent paths ──

    /// A candidate that disappears between pass 1 and pass 2 is the
    /// realistic race. It used to vanish from the result with no trace.
    #[test]
    fn unreadable_files_are_counted() {
        let root = test_root("unreadable");
        std::fs::create_dir_all(&root).unwrap();
        let missing = root.join("ghost.txt");

        let mut counters = GrepCounters::default();
        let outcome = read_candidates(
            std::slice::from_ref(&missing),
            &regex::Regex::new("needle").unwrap(),
            &mut budget(),
            &mut counters,
            None,
            &mut ModeOutput::Content(Vec::new()),
            &SearchOptions::default(),
        );

        assert_eq!(outcome, SearchOutcome::complete(), "a dead path is not a stop condition");
        assert_eq!(counters.skipped_unreadable, 1);
        std::fs::remove_dir_all(root).unwrap();
    }

    /// Symlink creation needs privilege on Windows. When it is not
    /// available the test cannot run, so it reports that rather than
    /// pretending to pass.
    #[test]
    fn symlinked_files_are_counted() {
        let root = test_root("symlink");
        std::fs::create_dir_all(&root).unwrap();
        let target = root.join("real.txt");
        std::fs::write(&target, "needle\n").unwrap();
        let link = root.join("link.txt");

        #[cfg(windows)]
        let created = std::os::windows::fs::symlink_file(&target, &link).is_ok();
        #[cfg(unix)]
        let created = std::os::unix::fs::symlink(&target, &link).is_ok();

        if !created {
            eprintln!("skipping: symlink creation not permitted in this environment");
            std::fs::remove_dir_all(root).unwrap();
            return;
        }

        let result = run(&root, "needle", &mut budget());

        assert_eq!(
            result["skipped_symlink"], 1,
            "a dropped symlink must be counted, not silent: {result}"
        );
        // The real file is still searched.
        assert_eq!(result["matches"].as_array().unwrap().len(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }

    // ── P8 — capability work ──

    /// Context lines carry their own 1-based line numbers, respect the
    /// window bounds at file start and end, and share the match-bytes
    /// budget.
    #[test]
    fn context_lines_are_numbered_and_bounded() {
        let root = test_root("context");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("a.txt"), "one\ntwo\nthree\nneedle\nfour\nfive\n").unwrap();

        let opts = SearchOptions {
            context_lines: 2,
            ..Default::default()
        };
        let result = run_with(&root, "needle", &mut budget(), &opts);

        let matches = result["matches"].as_array().unwrap();
        assert_eq!(matches.len(), 1);
        let before = matches[0]["before"].as_array().unwrap();
        let after = matches[0]["after"].as_array().unwrap();
        assert_eq!(before[0]["line"].as_u64().unwrap(), 2);
        assert_eq!(before[0]["content"].as_str().unwrap(), "two");
        assert_eq!(before[1]["line"].as_u64().unwrap(), 3);
        assert_eq!(before[1]["content"].as_str().unwrap(), "three");
        assert_eq!(after[0]["line"].as_u64().unwrap(), 5);
        assert_eq!(after[0]["content"].as_str().unwrap(), "four");
        assert_eq!(after[1]["line"].as_u64().unwrap(), 6);
        assert_eq!(after[1]["content"].as_str().unwrap(), "five");
        assert_eq!(matches[0]["content"].as_str().unwrap(), "needle");
        std::fs::remove_dir_all(root).unwrap();
    }

    /// The context window is clipped at the file edges, not padded.
    #[test]
    fn context_window_clips_at_file_edges() {
        let root = test_root("context-edge");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("a.txt"), "needle\nsecond\n").unwrap();

        let opts = SearchOptions {
            context_lines: 5,
            ..Default::default()
        };
        let result = run_with(&root, "needle", &mut budget(), &opts);

        let matches = result["matches"].as_array().unwrap();
        assert!(matches[0].get("before").is_none(), "no lines exist before line 1");
        let after = matches[0]["after"].as_array().unwrap();
        assert_eq!(after.len(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }

    /// files_with_matches returns one entry per file, an empty
    /// `matches`, and still obeys the shared result budget.
    #[test]
    fn files_with_matches_mode_lists_files() {
        let root = test_root("files-mode");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("a.txt"), "needle\nneedle\n").unwrap();
        std::fs::write(root.join("b.txt"), "needle\n").unwrap();
        std::fs::write(root.join("c.txt"), "nothing\n").unwrap();

        let opts = SearchOptions {
            mode: OutputMode::FilesWithMatches,
            ..Default::default()
        };
        let result = run_with(&root, "needle", &mut budget(), &opts);

        assert_eq!(result["matches"].as_array().unwrap().len(), 0);
        let files: Vec<&str> = result["files"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| f.as_str().unwrap())
            .collect();
        assert_eq!(files.len(), 2, "got {files:?}");
        assert!(files.iter().all(|f| f.ends_with("a.txt") || f.ends_with("b.txt")));

        // One file per result-budget unit: a budget of 1 stops truncated.
        let mut b = GrepBudget {
            remaining_results: 1,
            ..budget()
        };
        let capped = run_with(&root, "needle", &mut b, &opts);
        assert_eq!(capped["files"].as_array().unwrap().len(), 1);
        assert_eq!(capped["truncated"], true);
        assert_eq!(capped["truncated_reason"], "results");
        std::fs::remove_dir_all(root).unwrap();
    }

    /// count mode reports per-file match counts and a total, without
    /// returning line content.
    #[test]
    fn count_mode_counts_per_file() {
        let root = test_root("count-mode");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("a.txt"), "needle\nneedle\nneedle\n").unwrap();
        std::fs::write(root.join("b.txt"), "needle\n").unwrap();

        let opts = SearchOptions {
            mode: OutputMode::Count,
            ..Default::default()
        };
        let result = run_with(&root, "needle", &mut budget(), &opts);

        assert_eq!(result["matches"].as_array().unwrap().len(), 0);
        let counts = result["counts"].as_array().unwrap();
        assert_eq!(counts.len(), 2);
        assert!(counts[0]["file"].as_str().unwrap().ends_with("a.txt"));
        assert_eq!(counts[0]["count"].as_u64().unwrap(), 3);
        assert!(counts[1]["file"].as_str().unwrap().ends_with("b.txt"));
        assert_eq!(counts[1]["count"].as_u64().unwrap(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }

    /// max_matches_per_file is a sampling limit. A further match proves
    /// that the result omitted content, while later files remain searched.
    #[test]
    fn max_matches_per_file_signals_proven_omission() {
        let root = test_root("per-file-cap");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("dense.txt"), "needle\nneedle\nneedle\nneedle\n").unwrap();
        std::fs::write(root.join("sparse.txt"), "needle\n").unwrap();

        let opts = SearchOptions {
            max_matches_per_file: Some(2),
            ..Default::default()
        };
        let result = run_with(&root, "needle", &mut budget(), &opts);

        let matches = result["matches"].as_array().unwrap();
        assert_eq!(matches.len(), 3, "2 from dense, 1 from sparse: {result}");
        assert_eq!(result["truncated"], true);
        assert_eq!(result["truncated_reason"], "per_file_matches");
        let dense = matches
            .iter()
            .filter(|m| m["file"].as_str().unwrap().ends_with("dense.txt"))
            .count();
        assert_eq!(dense, 2);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn exact_per_file_cap_does_not_claim_truncation() {
        let root = test_root("per-file-exact");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("a.txt"), "needle\nneedle\n").unwrap();
        let opts = SearchOptions {
            max_matches_per_file: Some(2),
            ..Default::default()
        };

        let result = run_with(&root, "needle", &mut budget(), &opts);

        assert_eq!(result["matches"].as_array().unwrap().len(), 2);
        assert_eq!(result["truncated"], false);
        assert!(result.get("truncated_reason").is_none());
        std::fs::remove_dir_all(root).unwrap();
    }

    /// exclude skips files the way include selects them: same dialect,
    /// same path shape, batch-wide.
    #[test]
    fn exclude_filter_skips_matching_files() {
        let root = test_root("exclude");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("keep.txt"), "needle\n").unwrap();
        std::fs::write(root.join("drop.min.js"), "needle\n").unwrap();

        let exclude = include_set("*.min.js");
        let opts = SearchOptions {
            exclude: Some(&exclude),
            ..Default::default()
        };
        let result = run_with(&root, "needle", &mut budget(), &opts);

        let files = matched_files(&result);
        assert_eq!(files.len(), 1, "got {files:?}");
        assert!(files[0].ends_with("keep.txt"));
        std::fs::remove_dir_all(root).unwrap();
    }

    /// A per-search include replaces the batch-wide one for that search.
    #[tokio::test]
    async fn per_search_include_overrides_the_batch_include() {
        let root = test_root("per-search-include");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("a.ts"), "needle\n").unwrap();
        std::fs::write(root.join("b.md"), "needle\n").unwrap();

        let result = tool_grep(GrepRequest {
            searches: vec![
                GrepSearchEntry {
                    path: root.to_string_lossy().to_string(),
                    pattern: "needle".to_string(),
                    include: Some("*.md".to_string()),
                },
                GrepSearchEntry {
                    path: root.to_string_lossy().to_string(),
                    pattern: "needle".to_string(),
                    include: None,
                },
            ],
            include: Some("*.ts".to_string()),
            exclude: None,
            ignore_case: None,
            max_results: None,
            context_lines: None,
            output_mode: None,
            max_matches_per_file: None,
            include_excluded_dirs: None,
            allowed_roots: Some(vec![root.to_string_lossy().to_string()]),
            call_id: None,
            group_id: None,
            max_visited_entries: None,
            max_bytes_read: None,
            deadline_ms: None,
        })
        .await
        .expect("expected Ok");

        let first = matched_files(&result["results"][0]);
        let second = matched_files(&result["results"][1]);
        assert!(
            first.len() == 1 && first[0].ends_with("b.md"),
            "per-search include wins: {first:?}"
        );
        assert!(
            second.len() == 1 && second[0].ends_with("a.ts"),
            "batch include applies when unset: {second:?}"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    /// include_excluded_dirs turns off the fixed pruning on purpose —
    /// the answer is sometimes only inside node_modules.
    #[test]
    fn include_excluded_dirs_searches_skip_directories() {
        let root = test_root("skip-dirs");
        std::fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        std::fs::write(root.join("node_modules/pkg/dep.js"), "needle\n").unwrap();
        std::fs::write(root.join("outside.txt"), "needle\n").unwrap();

        let pruned = run(&root, "needle", &mut budget());
        assert_eq!(pruned["matches"].as_array().unwrap().len(), 1);

        let opts = SearchOptions {
            include_excluded_dirs: true,
            ..Default::default()
        };
        let included = run_with(&root, "needle", &mut budget(), &opts);
        assert_eq!(included["matches"].as_array().unwrap().len(), 2);
        std::fs::remove_dir_all(root).unwrap();
    }

    /// The result unit in count mode is the file row, not the match.
    /// Charging per match gave `count` the same ceiling as `content`,
    /// so a survey of a large match set returned a floor labelled as a
    /// count. 50 matches under a budget of 10 must still count 50.
    #[test]
    fn count_mode_charges_one_result_per_file_not_per_match() {
        let root = test_root("count-budget");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("many.txt"), "needle\n".repeat(50)).unwrap();
        std::fs::write(root.join("few.txt"), "needle\n".repeat(3)).unwrap();
        let roots = merged_roots(&[root.to_string_lossy().to_string()]);
        let mut b = GrepBudget {
            remaining_results: 10,
            ..budget()
        };
        let opts = SearchOptions {
            mode: OutputMode::Count,
            ..SearchOptions::default()
        };

        let result = grep_single_dir(
            &root.to_string_lossy(),
            &roots,
            "needle",
            None,
            &mut b,
            None,
            &opts,
        );

        let counts = result["counts"].as_array().unwrap();
        let total: u64 = counts.iter().map(|c| c["count"].as_u64().unwrap()).sum();
        assert_eq!(total, 53, "counts must be complete: {result}");
        assert_eq!(result["truncated"], false, "two files fit a budget of 10");
        // Eight rows of budget are still unspent.
        assert_eq!(b.remaining_results, 8);
        std::fs::remove_dir_all(root).unwrap();
    }

    /// The file row is still budgeted, so a batch cannot list unlimited
    /// files in count mode.
    #[test]
    fn count_mode_still_stops_when_file_rows_run_out() {
        let root = test_root("count-rows");
        std::fs::create_dir_all(&root).unwrap();
        for index in 0..5 {
            std::fs::write(root.join(format!("f{index}.txt")), "needle\n").unwrap();
        }
        let roots = merged_roots(&[root.to_string_lossy().to_string()]);
        let mut b = GrepBudget {
            remaining_results: 2,
            ..budget()
        };
        let opts = SearchOptions {
            mode: OutputMode::Count,
            ..SearchOptions::default()
        };

        let result = grep_single_dir(
            &root.to_string_lossy(),
            &roots,
            "needle",
            None,
            &mut b,
            None,
            &opts,
        );

        assert_eq!(result["counts"].as_array().unwrap().len(), 2);
        assert_eq!(result["truncated"], true);
        assert_eq!(result["truncated_reason"], "results");
        std::fs::remove_dir_all(root).unwrap();
    }


    /// `lc_read_file` announces the encoding it returned. Grep
    /// transcoded the same bytes and reported nothing, so a match could
    /// come out of a UTF-16 file with no sign of it anywhere.
    #[test]
    fn transcoded_matches_announce_their_encoding() {
        let root = test_root("grep-encoding");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("utf16.txt"), utf16le("needle here\n", true)).unwrap();
        std::fs::write(root.join("utf8.txt"), "needle here\n").unwrap();

        let result = run(&root, "needle", &mut budget());

        assert_eq!(result["files_transcoded"], 1, "{result}");
        let matches = result["matches"].as_array().unwrap();
        assert_eq!(matches.len(), 2);
        let transcoded: Vec<&serde_json::Value> = matches
            .iter()
            .filter(|m| m.get("encoding").is_some())
            .collect();
        assert_eq!(transcoded.len(), 1, "only the UTF-16 match is marked");
        assert_eq!(transcoded[0]["encoding"], "utf-16le");
        assert!(
            transcoded[0]["file"].as_str().unwrap().ends_with("utf16.txt"),
            "the mark must be on the transcoded file's match"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    /// A plain UTF-8 search reports zero, not an absent field.
    #[test]
    fn utf8_only_search_reports_no_transcoding() {
        let root = test_root("grep-no-encoding");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("a.txt"), "needle\n").unwrap();

        let result = run(&root, "needle", &mut budget());

        assert_eq!(result["files_transcoded"], 0);
        assert!(result["matches"][0].get("encoding").is_none());
        std::fs::remove_dir_all(root).unwrap();
    }

}
