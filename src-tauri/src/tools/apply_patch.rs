//! Native lc_apply_patch implementation.
//!
//! Portions of the patch parsing and contextual matching algorithm were
//! adapted from OpenCode, Copyright (c) 2025 opencode, licensed under MIT.
//! See `THIRD_PARTY_LICENSES.md` in the LC distribution.
//!
//! LC-specific modifications are Copyright 2026 The LC Authors and licensed
//! under Apache-2.0.
//!
//! The strict parser accepts LC's OpenCode-style patch envelope, including
//! positional hunk headers and hunkless Update+Move pure renames. Native
//! target discovery canonicalizes every affected path without reading or
//! authorizing file contents. After exact-scope approval, full preflight binds
//! an authorized plan to execution. Deterministic file changes are prepared
//! before the first commit, and each file is committed through FileTransaction.
//! Cross-file atomicity is intentionally not promised.

use super::file_tx::FileTransaction;
use super::fs_ops::{canonicalize_allow_missing, merged_roots, resolve_under_roots};
use super::process_file_lock::ProcessFileLocks;
use super::{ToolError, ToolHandle, ToolOk};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use tokio_util::sync::CancellationToken;

const MAX_PATCH_BYTES: usize = 1_048_576;
const MAX_TARGET_BYTES: u64 = 32 * 1024 * 1024;
const MAX_PREPARED_BYTES: usize = 64 * 1024 * 1024;

type PlanId = String;

#[derive(Debug, Deserialize)]
pub struct ApplyPatchPreflightRequest {
    pub patch: String,
    pub allowed_roots: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
pub struct ApplyPatchTargetsRequest {
    pub patch: String,
}

#[derive(Debug, Deserialize)]
pub struct ApplyPatchRequest {
    pub patch: String,
    pub allowed_roots: Option<Vec<String>>,
    pub plan_id: PlanId,
    pub call_id: Option<String>,
    pub group_id: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ApplyPatchFileResult {
    pub path: String,
    pub action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub move_to: Option<String>,
    pub hunks_applied: usize,
    pub lines_added: usize,
    pub lines_removed: usize,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ApplyPatchResult {
    pub files: Vec<ApplyPatchFileResult>,
    pub summary: String,
    pub fully_applied: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct PatchAction {
    pub action: String,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub move_to: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ApplyPatchPreflightResult {
    pub plan_id: PlanId,
    pub affected_paths: Vec<String>,
    pub actions: Vec<PatchAction>,
    // Keep this field present even when empty. The TypeScript preflight
    // contract consumes it as an array, and omitting it turns every valid
    // preflight into a runtime type error before execution can begin.
    pub diagnostics: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct ApplyPatchTargetsResult {
    pub affected_paths: Vec<String>,
    pub actions: Vec<PatchAction>,
    pub diagnostics: Vec<String>,
}

#[derive(Debug, Clone, Copy)]
enum HunkType {
    Add,
    Update,
    Delete,
}

impl HunkType {
    fn label(self) -> &'static str {
        match self {
            Self::Add => "add",
            Self::Update => "update",
            Self::Delete => "delete",
        }
    }
}

#[derive(Debug, Clone)]
struct Hunk {
    hunk_type: HunkType,
    path: String,
    move_path: Option<String>,
    chunks: Vec<UpdateChunk>,
    content: Option<String>,
}

#[derive(Debug, Clone)]
struct UpdateChunk {
    old_lines: Vec<String>,
    new_lines: Vec<String>,
    /// Maps unchanged context lines from `(old_lines, new_lines)` offsets.
    /// When fuzzy matching succeeds, these positions must retain the source
    /// line rather than adopting whitespace or punctuation from the patch.
    context_line_mappings: Vec<(usize, usize)>,
    change_context: Option<String>,
    is_end_of_file: bool,
}

#[derive(Debug)]
struct ResolvedHunk {
    hunk: Hunk,
    source: PathBuf,
    destination: Option<PathBuf>,
}

#[derive(Debug)]
struct ResolvedPatchPlan {
    hunks: Vec<ResolvedHunk>,
    affected_paths: Vec<String>,
    plan_id: PlanId,
}

enum PreparedAction {
    Add {
        hunk: Hunk,
        target: PathBuf,
        content: String,
    },
    Delete {
        hunk: Hunk,
        target: PathBuf,
        original: Vec<u8>,
    },
    Update {
        hunk: Hunk,
        target: PathBuf,
        destination: Option<PathBuf>,
        original: Vec<u8>,
        new_content: String,
        warnings: Vec<String>,
    },
}

fn normalize_patch(raw: &str) -> String {
    raw.replace("\r\n", "\n").replace('\r', "\n")
}

fn parse_patch(text: &str) -> Result<Vec<Hunk>, String> {
    let normalized = normalize_patch(text);
    let lines: Vec<&str> = normalized.split('\n').collect();
    let begin = lines
        .iter()
        .position(|line| !line.trim().is_empty())
        .ok_or_else(|| "patch rejected: empty patch".to_string())?;
    let end = lines
        .iter()
        .rposition(|line| !line.trim().is_empty())
        .ok_or_else(|| "patch rejected: empty patch".to_string())?;

    if lines[begin].trim() != "*** Begin Patch" {
        return Err(format!(
            "patch rejected at line {}: first nonblank line must be *** Begin Patch",
            begin + 1
        ));
    }
    if lines[end].trim() != "*** End Patch" {
        return Err(format!(
            "patch rejected at line {}: last nonblank line must be *** End Patch",
            end + 1
        ));
    }
    if begin >= end {
        return Err("patch rejected: empty patch (no hunks found)".into());
    }

    let mut hunks = Vec::new();
    let mut index = begin + 1;
    while index < end {
        let line = lines[index];
        if line.trim().is_empty() {
            index += 1;
            continue;
        }

        if let Some(raw_path) = line.strip_prefix("*** Add File:") {
            let path = require_path(raw_path, "Add File", index)?;
            index += 1;
            // Add File content normally follows the header directly. Tolerate
            // positional hunk headers emitted by diff-oriented models, but do
            // not write those control lines into the new file. Prefix a
            // literal leading "@@" content line with '+' to disambiguate it.
            if index < end && is_positional_hunk_header(lines[index]) {
                index += 1;
            }
            let mut content = Vec::new();
            while index < end && !lines[index].starts_with("***") {
                content.push(
                    lines[index]
                        .strip_prefix('+')
                        .unwrap_or(lines[index])
                        .to_string(),
                );
                index += 1;
            }
            let content = if content.is_empty() {
                String::new()
            } else {
                format!("{}\n", content.join("\n"))
            };
            hunks.push(Hunk {
                hunk_type: HunkType::Add,
                path,
                move_path: None,
                chunks: Vec::new(),
                content: Some(content),
            });
            continue;
        }

        if let Some(raw_path) = line.strip_prefix("*** Delete File:") {
            hunks.push(Hunk {
                hunk_type: HunkType::Delete,
                path: require_path(raw_path, "Delete File", index)?,
                move_path: None,
                chunks: Vec::new(),
                content: None,
            });
            index += 1;
            continue;
        }

        if let Some(raw_path) = line.strip_prefix("*** Update File:") {
            let path = require_path(raw_path, "Update File", index)?;
            index += 1;
            let move_path = if index < end {
                if let Some(raw_move) = lines[index].strip_prefix("*** Move to:") {
                    let result = Some(require_path(raw_move, "Move to", index)?);
                    index += 1;
                    result
                } else {
                    None
                }
            } else {
                None
            };

            while index < end
                && (lines[index].starts_with("---") || lines[index].starts_with("+++"))
            {
                index += 1;
            }

            let mut chunks = Vec::new();
            while index < end && lines[index].starts_with("@@") {
                let header_line = index;
                let header = lines[index];
                let context = hunk_change_context(header);
                index += 1;

                let mut old_lines = Vec::new();
                let mut new_lines = Vec::new();
                let mut context_line_mappings = Vec::new();
                let mut is_end_of_file = false;
                while index < end {
                    let change = lines[index];
                    if change == "*** End of File" {
                        is_end_of_file = true;
                        index += 1;
                        break;
                    }
                    if change.starts_with("@@") || change.starts_with("***") {
                        break;
                    }
                    if blank_separator_before_marker(&lines, index, end) {
                        break;
                    }
                    if let Some(value) = change.strip_prefix(' ') {
                        let old_offset = old_lines.len();
                        let new_offset = new_lines.len();
                        old_lines.push(value.to_string());
                        new_lines.push(value.to_string());
                        context_line_mappings.push((old_offset, new_offset));
                    } else if let Some(value) = change.strip_prefix('-') {
                        old_lines.push(value.to_string());
                    } else if let Some(value) = change.strip_prefix('+') {
                        new_lines.push(value.to_string());
                    } else {
                        return Err(format!(
                            "patch rejected at line {}: update lines must start with space, -, or +",
                            index + 1
                        ));
                    }
                    index += 1;
                }
                if old_lines.is_empty() && new_lines.is_empty() {
                    return Err(format!(
                        "patch rejected at line {}: empty @@ chunk",
                        header_line + 1
                    ));
                }
                chunks.push(UpdateChunk {
                    old_lines,
                    new_lines,
                    context_line_mappings,
                    change_context: context,
                    is_end_of_file,
                });
            }
            if chunks.is_empty() && move_path.is_none() {
                return Err(format!(
                    "patch rejected: *** Update File: {} has no @@ hunks",
                    path
                ));
            }
            hunks.push(Hunk {
                hunk_type: HunkType::Update,
                path,
                move_path,
                chunks,
                content: None,
            });
            continue;
        }

        return Err(misplaced_line_error(line, index));
    }

    if hunks.is_empty() {
        return Err("patch rejected: empty patch (no hunks found)".into());
    }
    Ok(hunks)
}

/// Explain a line that cannot open a file entry.
///
/// `*** Move to:` is a real header, but a secondary one: it is read only
/// on the line immediately after `*** Update File:`. Calling it an
/// "unknown patch line" denies that the header exists, so a model cannot
/// learn the placement rule from the rejection and retries the same
/// layout. Name the rule instead.
fn misplaced_line_error(line: &str, index: usize) -> String {
    let at = index + 1;
    if line.starts_with("*** Move to:") {
        return format!(
            "patch rejected at line {at}: *** Move to: must come immediately after \
             *** Update File: <source> and before any @@ hunk. It is not a standalone action."
        );
    }
    if line.starts_with("*** End of File") {
        return format!(
            "patch rejected at line {at}: *** End of File closes an @@ hunk \
             and cannot open a file entry."
        );
    }
    if line.starts_with("*** Begin Patch") {
        return format!(
            "patch rejected at line {at}: *** Begin Patch is allowed only once, \
             as the first line of the patch."
        );
    }
    format!(
        "patch rejected at line {at}: unknown patch line '{line}'. \
         A file entry starts with *** Add File:, *** Update File:, or *** Delete File:."
    )
}

fn require_path(raw: &str, marker: &str, line: usize) -> Result<String, String> {
    let path = raw.trim();
    if path.is_empty() {
        return Err(format!(
            "patch rejected at line {}: *** {}: missing path",
            line + 1,
            marker
        ));
    }
    Ok(path.to_string())
}

fn is_simple_positional_range(value: &str) -> bool {
    let Some((start, count)) = value.split_once(',') else {
        return false;
    };
    let start = start.trim();
    let count = count.trim();
    !start.is_empty()
        && !count.is_empty()
        && start.bytes().all(|byte| byte.is_ascii_digit())
        && count.bytes().all(|byte| byte.is_ascii_digit())
}

fn is_positional_hunk_header(line: &str) -> bool {
    let Some(value) = line.strip_prefix("@@") else {
        return false;
    };
    let value = value.trim();
    value.is_empty() || value.ends_with("@@") || is_simple_positional_range(value)
}

fn hunk_change_context(header: &str) -> Option<String> {
    let value = header.strip_prefix("@@").unwrap_or(header).trim();
    if value.is_empty() || value.ends_with("@@") || is_simple_positional_range(value) {
        None
    } else {
        Some(value.to_string())
    }
}

fn blank_separator_before_marker(lines: &[&str], start: usize, end: usize) -> bool {
    if !lines[start].is_empty() {
        return false;
    }
    let mut next = start;
    while next < end && lines[next].is_empty() {
        next += 1;
    }
    next >= end || lines[next].starts_with("***")
}

fn path_identity(path: &Path) -> String {
    let value = path.to_string_lossy().replace('\\', "/");
    #[cfg(target_os = "windows")]
    {
        value.to_lowercase()
    }
    #[cfg(not(target_os = "windows"))]
    {
        value
    }
}

/// Parse a patch and canonicalize every source/destination without applying an
/// authorization boundary or reading target contents. This is deliberately
/// separate from full preflight: its only job is to identify the exact scopes
/// that authorization must decide. Full validation is repeated against the
/// approved roots before a plan ID can be issued.
fn discover_patch_targets(patch: &str) -> Result<ApplyPatchTargetsResult, ToolError> {
    if patch.len() > MAX_PATCH_BYTES {
        return Err(ToolError::Io(
            "Patch exceeds the 1 MiB UTF-8 limit. Split unrelated changes into smaller patches."
                .into(),
        ));
    }
    let hunks = parse_patch(patch).map_err(ToolError::Io)?;
    let mut affected_paths = Vec::new();
    let mut affected_set = HashSet::new();
    let mut touched = HashSet::new();
    let mut actions = Vec::with_capacity(hunks.len());

    for hunk in hunks {
        let source = canonicalize_allow_missing(&hunk.path)?;
        let source_id = path_identity(&source);
        if !touched.insert(source_id.clone()) {
            return Err(ToolError::Io(format!(
                "Patch rejected: multiple actions target '{}'. Combine them into one file section.",
                hunk.path
            )));
        }
        if affected_set.insert(source_id) {
            affected_paths.push(source.to_string_lossy().to_string());
        }

        if let Some(move_path) = hunk.move_path.as_deref() {
            let destination = canonicalize_allow_missing(move_path)?;
            let destination_id = path_identity(&destination);
            if destination_id == path_identity(&source) {
                return Err(ToolError::Io(format!(
                    "move source and destination resolve to the same file: {}",
                    hunk.path
                )));
            }
            if !touched.insert(destination_id.clone()) {
                return Err(ToolError::Io(format!(
                    "Patch rejected: multiple actions target move destination '{}'. Choose one source or use a different destination.",
                    move_path
                )));
            }
            if affected_set.insert(destination_id) {
                affected_paths.push(destination.to_string_lossy().to_string());
            }
        }

        actions.push(PatchAction {
            action: if hunk.move_path.is_some() {
                "move".into()
            } else {
                hunk.hunk_type.label().into()
            },
            path: hunk.path,
            move_to: hunk.move_path,
        });
    }

    Ok(ApplyPatchTargetsResult {
        affected_paths,
        actions,
        diagnostics: Vec::new(),
    })
}

fn build_resolved_plan(patch: &str, roots: &[PathBuf]) -> Result<ResolvedPatchPlan, ToolError> {
    if patch.len() > MAX_PATCH_BYTES {
        return Err(ToolError::Io(
            "Patch exceeds the 1 MiB UTF-8 limit. Split unrelated changes into smaller patches."
                .into(),
        ));
    }
    let hunks = parse_patch(patch).map_err(ToolError::Io)?;
    let mut resolved = Vec::with_capacity(hunks.len());
    let mut affected_paths = Vec::new();
    let mut affected_set = HashSet::new();
    let mut touched = HashSet::new();

    for hunk in hunks {
        let source = resolve_under_roots(&hunk.path, roots)?;
        let source_id = path_identity(&source);
        if !touched.insert(source_id.clone()) {
            return Err(ToolError::Io(format!(
                "Patch rejected: multiple actions target '{}'. Combine them into one file section.",
                hunk.path
            )));
        }
        if affected_set.insert(source_id) {
            affected_paths.push(source.to_string_lossy().to_string());
        }

        match hunk.hunk_type {
            HunkType::Add => {
                if source.exists() {
                    // A collision, not an IO fault — `already_exists` is
                    // what the caller needs to distinguish it from a
                    // sandbox rejection.
                    return Err(ToolError::AlreadyExists(format!(
                        "add target already exists: {}",
                        hunk.path
                    )));
                }
            }
            HunkType::Update | HunkType::Delete => {
                let metadata = std::fs::metadata(&source).map_err(|error| {
                    ToolError::Io(format!("source '{}' is unavailable: {}", hunk.path, error))
                })?;
                if !metadata.is_file() {
                    return Err(ToolError::NotAFile(format!(
                        "source is not a file: {}",
                        hunk.path
                    )));
                }
            }
        }

        let destination = match hunk.move_path.as_deref() {
            Some(move_path) => {
                let target = resolve_under_roots(move_path, roots)?;
                let target_id = path_identity(&target);
                if target_id == path_identity(&source) {
                    return Err(ToolError::Io(format!(
                        "move source and destination resolve to the same file: {}",
                        hunk.path
                    )));
                }
                if !touched.insert(target_id.clone()) {
                    return Err(ToolError::Io(format!(
                        "Patch rejected: multiple actions target move destination '{}'. Choose one source or use a different destination.",
                        move_path
                    )));
                }
                if target.exists() {
                    return Err(ToolError::AlreadyExists(format!(
                        "move destination already exists: {}",
                        move_path
                    )));
                }
                if affected_set.insert(target_id) {
                    affected_paths.push(target.to_string_lossy().to_string());
                }
                Some(target)
            }
            None => None,
        };
        resolved.push(ResolvedHunk {
            hunk,
            source,
            destination,
        });
    }

    let plan_id = compute_plan_id(patch, &resolved);
    Ok(ResolvedPatchPlan {
        hunks: resolved,
        affected_paths,
        plan_id,
    })
}

fn compute_plan_id(patch: &str, hunks: &[ResolvedHunk]) -> PlanId {
    let mut hasher = Sha256::new();
    hasher.update(normalize_patch(patch).trim().as_bytes());
    for resolved in hunks {
        hasher.update([0]);
        hasher.update(resolved.hunk.hunk_type.label().as_bytes());
        hasher.update([0]);
        hasher.update(path_identity(&resolved.source).as_bytes());
        if let Some(destination) = &resolved.destination {
            hasher.update([0]);
            hasher.update(path_identity(destination).as_bytes());
        }
    }
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{:02x}", byte))
        .collect()
}

fn normalize_unicode(value: &str) -> String {
    value
        .replace(['\u{2018}', '\u{2019}', '\u{201a}', '\u{201b}'], "'")
        .replace(['\u{201c}', '\u{201d}', '\u{201e}', '\u{201f}'], "\"")
        .replace(
            [
                '\u{2010}', '\u{2011}', '\u{2012}', '\u{2013}', '\u{2014}', '\u{2015}',
            ],
            "-",
        )
        .replace('\u{2026}', "...")
        .replace('\u{00a0}', " ")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MatchKind {
    Exact,
    Rstrip,
    Trim,
    UnicodeNormalized,
}

impl MatchKind {
    fn label(self) -> &'static str {
        match self {
            Self::Exact => "exact",
            Self::Rstrip => "rstrip",
            Self::Trim => "trim",
            Self::UnicodeNormalized => "unicode-normalized",
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct SequenceMatch {
    index: usize,
    kind: MatchKind,
}

type Comparator = fn(&str, &str) -> bool;

fn exact(left: &str, right: &str) -> bool {
    left == right
}

fn rstrip(left: &str, right: &str) -> bool {
    left.trim_end() == right.trim_end()
}

fn trim(left: &str, right: &str) -> bool {
    left.trim() == right.trim()
}

fn unicode_normalized(left: &str, right: &str) -> bool {
    normalize_unicode(left.trim()) == normalize_unicode(right.trim())
}

fn try_match(
    lines: &[String],
    pattern: &[String],
    start: usize,
    compare: Comparator,
    eof_only: bool,
) -> Option<usize> {
    if pattern.is_empty() || lines.len() < pattern.len() {
        return None;
    }
    if eof_only {
        let index = lines.len() - pattern.len();
        if index < start {
            return None;
        }
        return pattern
            .iter()
            .enumerate()
            .all(|(offset, expected)| compare(&lines[index + offset], expected))
            .then_some(index);
    }

    let end = lines.len() - pattern.len();
    (start..=end).find(|index| {
        pattern
            .iter()
            .enumerate()
            .all(|(offset, expected)| compare(&lines[index + offset], expected))
    })
}

fn seek_sequence(
    lines: &[String],
    pattern: &[String],
    start: usize,
    eof_only: bool,
) -> Option<SequenceMatch> {
    [
        (MatchKind::Exact, exact as Comparator),
        (MatchKind::Rstrip, rstrip as Comparator),
        (MatchKind::Trim, trim as Comparator),
        (
            MatchKind::UnicodeNormalized,
            unicode_normalized as Comparator,
        ),
    ]
    .into_iter()
    .find_map(|(kind, compare)| {
        try_match(lines, pattern, start, compare, eof_only)
            .map(|index| SequenceMatch { index, kind })
    })
}

fn derive_new_content(
    file_path: &str,
    chunks: &[UpdateChunk],
    original: &str,
) -> Result<(String, Vec<String>), String> {
    // A hunkless Update+Move is a pure rename. Return the original text
    // verbatim so mixed line endings, BOMs, and final-newline state cannot be
    // normalized merely by moving the file.
    if chunks.is_empty() {
        return Ok((original.to_string(), Vec::new()));
    }

    let has_bom = original.starts_with('\u{feff}');
    let body = original.strip_prefix('\u{feff}').unwrap_or(original);
    let use_crlf = match (body.find("\r\n"), body.find('\n')) {
        (Some(crlf), Some(lf)) => crlf < lf,
        (Some(_), None) => true,
        _ => false,
    };
    let had_final_newline = body.ends_with('\n') || body.ends_with('\r');
    let normalized = body.replace("\r\n", "\n").replace('\r', "\n");
    let mut original_lines: Vec<String> = if normalized.is_empty() {
        Vec::new()
    } else {
        normalized.split('\n').map(str::to_string).collect()
    };
    if had_final_newline && original_lines.last().is_some_and(String::is_empty) {
        original_lines.pop();
    }

    let mut replacements: Vec<(usize, usize, Vec<String>)> = Vec::new();
    let mut warnings = Vec::new();
    let mut line_index = 0usize;

    for chunk in chunks {
        let mut context_index = None;
        if let Some(context) = &chunk.change_context {
            let found = seek_sequence(
                &original_lines,
                std::slice::from_ref(context),
                line_index,
                false,
            )
            .ok_or_else(|| format!("Failed to find context '{}' in {}", context, file_path))?;
            line_index = found.index + 1;
            context_index = Some(line_index);
            if found.kind != MatchKind::Exact {
                warnings.push(format!(
                    "context in {} applied with {} match",
                    file_path,
                    found.kind.label()
                ));
            }
        }

        if chunk.old_lines.is_empty() {
            let insertion = if chunk.is_end_of_file {
                original_lines.len()
            } else {
                context_index.unwrap_or(original_lines.len())
            };
            replacements.push((insertion, 0, chunk.new_lines.clone()));
            continue;
        }

        let found = seek_sequence(
            &original_lines,
            &chunk.old_lines,
            line_index,
            chunk.is_end_of_file,
        )
        .ok_or_else(|| {
            format!(
                "Failed to find expected lines in {}:\n{}",
                file_path,
                chunk.old_lines.join("\n")
            )
        })?;
        let mut new_segment = chunk.new_lines.clone();
        for &(old_offset, new_offset) in &chunk.context_line_mappings {
            if let (Some(source_line), Some(context_line)) = (
                original_lines.get(found.index + old_offset),
                new_segment.get_mut(new_offset),
            ) {
                context_line.clone_from(source_line);
            }
        }
        replacements.push((found.index, chunk.old_lines.len(), new_segment));
        line_index = found.index + chunk.old_lines.len();
        if found.kind != MatchKind::Exact {
            warnings.push(format!(
                "chunk in {} applied with {} match",
                file_path,
                found.kind.label()
            ));
        }
    }

    replacements.sort_by_key(|replacement| replacement.0);
    let mut new_lines = original_lines;
    for (start, old_len, new_segment) in replacements.into_iter().rev() {
        new_lines.splice(start..start + old_len, new_segment);
    }

    let mut content = new_lines.join("\n");
    if had_final_newline && !new_lines.is_empty() {
        content.push('\n');
    }
    if use_crlf {
        content = content.replace('\n', "\r\n");
    }
    if has_bom {
        content.insert(0, '\u{feff}');
    }
    Ok((content, warnings))
}

fn prepare_plan(plan: ResolvedPatchPlan) -> Result<Vec<PreparedAction>, ToolError> {
    let mut prepared = Vec::with_capacity(plan.hunks.len());
    let mut prepared_bytes = 0usize;

    for resolved in plan.hunks {
        match resolved.hunk.hunk_type {
            HunkType::Add => {
                let content = resolved.hunk.content.clone().unwrap_or_default();
                add_prepared_bytes(&mut prepared_bytes, content.len())?;
                prepared.push(PreparedAction::Add {
                    hunk: resolved.hunk,
                    target: resolved.source,
                    content,
                });
            }
            HunkType::Delete => {
                let original = read_bounded(&resolved.source, &resolved.hunk.path)?;
                add_prepared_bytes(&mut prepared_bytes, original.len())?;
                prepared.push(PreparedAction::Delete {
                    hunk: resolved.hunk,
                    target: resolved.source,
                    original,
                });
            }
            HunkType::Update => {
                let original = read_bounded(&resolved.source, &resolved.hunk.path)?;
                // Same text-admission policy as `lc_read_file` and
                // `lc_edit_file`. `from_utf8` alone accepts a NUL byte.
                // BOM-marked UTF-16 gets its own message: patching would
                // rewrite the file as UTF-8 and change its encoding.
                if let Some(kind) = super::fs_ops::utf16_bom(&original) {
                    return Err(ToolError::Io(format!(
                        "update source '{}' is {} behind a byte-order mark: lc_read_file \
                         transcodes it for reading, but patching would rewrite the file as \
                         UTF-8 and change its encoding. Convert the file to UTF-8 first.",
                        resolved.hunk.path,
                        kind.label()
                    )));
                }
                if let Some(reason) = super::fs_ops::classify_text(&original) {
                    return Err(ToolError::Io(format!(
                        "update source '{}' is not editable text. {}",
                        resolved.hunk.path,
                        reason.remedy()
                    )));
                }
                let original_text = std::str::from_utf8(&original).map_err(|error| {
                    ToolError::Io(format!(
                        "update source is not valid UTF-8 '{}': {}",
                        resolved.hunk.path, error
                    ))
                })?;
                let (new_content, warnings) =
                    derive_new_content(&resolved.hunk.path, &resolved.hunk.chunks, original_text)
                        .map_err(ToolError::Io)?;
                add_prepared_bytes(
                    &mut prepared_bytes,
                    original.len().saturating_add(new_content.len()),
                )?;
                prepared.push(PreparedAction::Update {
                    hunk: resolved.hunk,
                    target: resolved.source,
                    destination: resolved.destination,
                    original,
                    new_content,
                    warnings,
                });
            }
        }
    }
    Ok(prepared)
}

fn read_bounded(path: &Path, display_path: &str) -> Result<Vec<u8>, ToolError> {
    let metadata = std::fs::metadata(path)
        .map_err(|error| ToolError::Io(format!("read error for '{}': {}", display_path, error)))?;
    if metadata.len() > MAX_TARGET_BYTES {
        return Err(ToolError::Io(format!(
            "target '{}' exceeds the 32 MiB apply_patch limit ({} bytes)",
            display_path,
            metadata.len()
        )));
    }
    std::fs::read(path)
        .map_err(|error| ToolError::Io(format!("read error for '{}': {}", display_path, error)))
}

fn add_prepared_bytes(total: &mut usize, additional: usize) -> Result<(), ToolError> {
    *total = total.saturating_add(additional);
    if *total > MAX_PREPARED_BYTES {
        return Err(ToolError::Io(
            "prepared patch content exceeds the 64 MiB memory limit".into(),
        ));
    }
    Ok(())
}

fn verify_unchanged(path: &Path, expected: &[u8]) -> Result<(), String> {
    match std::fs::read(path) {
        Ok(current) if current == expected => Ok(()),
        Ok(_) => Err("Source changed after patch preparation. Retry with fresh context.".into()),
        Err(error) => Err(format!(
            "source became unavailable after patch preparation: {}",
            error
        )),
    }
}

fn write_transaction(target: &Path, content: &[u8], create_only: bool) -> Result<(), String> {
    let mut transaction = FileTransaction::new(target).map_err(|error| error.to_string())?;
    transaction
        .write_all(content)
        .map_err(|error| error.to_string())?;
    if create_only {
        transaction
            .commit_create()
            .map_err(|error| error.to_string())
    } else {
        transaction.commit().map_err(|error| error.to_string())
    }
}

#[cfg(test)]
fn apply_prepared(prepared: Vec<PreparedAction>) -> ApplyPatchResult {
    apply_prepared_cancellable(prepared, || false, |_| {})
}

fn cancelled_result(action: PreparedAction) -> ApplyPatchFileResult {
    let (hunk, action_name) = match action {
        PreparedAction::Add { hunk, .. } => (hunk, "add"),
        PreparedAction::Delete { hunk, .. } => (hunk, "delete"),
        PreparedAction::Update {
            hunk, destination, ..
        } => (
            hunk,
            if destination.is_some() {
                "move"
            } else {
                "update"
            },
        ),
    };
    result_for(
        &hunk,
        action_name,
        0,
        0,
        0,
        Vec::new(),
        Some("cancelled before this file was changed".into()),
    )
}

fn apply_prepared_cancellable(
    prepared: Vec<PreparedAction>,
    mut should_cancel: impl FnMut() -> bool,
    mut after_commit: impl FnMut(&ApplyPatchFileResult),
) -> ApplyPatchResult {
    let mut files = Vec::with_capacity(prepared.len());
    let mut summary = Vec::new();
    let mut actions = prepared.into_iter();

    while let Some(action) = actions.next() {
        if should_cancel() {
            files.push(cancelled_result(action));
            files.extend(actions.map(cancelled_result));
            break;
        }
        match action {
            PreparedAction::Add {
                hunk,
                target,
                content,
            } => {
                let error = if target.exists() {
                    Some("add target already exists".to_string())
                } else {
                    write_transaction(&target, content.as_bytes(), true).err()
                };
                if error.is_none() {
                    summary.push(format!("A {}", hunk.path));
                }
                files.push(result_for(
                    &hunk,
                    "add",
                    usize::from(error.is_none()),
                    if error.is_none() {
                        count_text_lines(&content)
                    } else {
                        0
                    },
                    0,
                    Vec::new(),
                    error,
                ));
            }
            PreparedAction::Delete {
                hunk,
                target,
                original,
            } => {
                let error = verify_unchanged(&target, &original)
                    .and_then(|_| std::fs::remove_file(&target).map_err(|error| error.to_string()))
                    .err();
                if error.is_none() {
                    summary.push(format!("D {}", hunk.path));
                }
                files.push(result_for(
                    &hunk,
                    "delete",
                    usize::from(error.is_none()),
                    0,
                    if error.is_none() {
                        count_text_lines_bytes(&original)
                    } else {
                        0
                    },
                    Vec::new(),
                    error,
                ));
            }
            PreparedAction::Update {
                hunk,
                target,
                destination,
                original,
                new_content,
                warnings,
            } => {
                if let Some(move_target) = destination {
                    let mut error = verify_unchanged(&target, &original).err();
                    if error.is_none() && move_target.exists() {
                        error = Some("move destination already exists".into());
                    }
                    if error.is_none() {
                        error = write_transaction(&move_target, new_content.as_bytes(), true).err();
                    }
                    if error.is_none() {
                        if let Err(remove_error) = std::fs::remove_file(&target) {
                            let cleanup = match std::fs::read(&move_target) {
                                Ok(current) if current == new_content.as_bytes() => {
                                    std::fs::remove_file(&move_target)
                                        .map(|_| "destination rollback succeeded".to_string())
                                        .unwrap_or_else(|cleanup_error| {
                                            format!(
                                                "destination rollback failed: {}",
                                                cleanup_error
                                            )
                                        })
                                }
                                Ok(_) => "Destination changed. Rollback was not attempted. Inspect the destination before retrying.".into(),
                                Err(cleanup_error) => {
                                    format!("destination could not be checked: {}", cleanup_error)
                                }
                            };
                            error = Some(format!(
                                "Move destination was written, but source removal failed: {}. Cleanup result: {}. Inspect the source and destination before retrying.",
                                remove_error, cleanup
                            ));
                        }
                    }
                    if error.is_none() {
                        summary.push(format!(
                            "M {} -> {}",
                            hunk.path,
                            hunk.move_path.as_deref().unwrap_or_default()
                        ));
                    }
                    files.push(result_for(
                        &hunk,
                        "move",
                        if error.is_none() {
                            hunk.chunks.len()
                        } else {
                            0
                        },
                        if error.is_none() {
                            hunk_lines_added(&hunk)
                        } else {
                            0
                        },
                        if error.is_none() {
                            hunk_lines_removed(&hunk)
                        } else {
                            0
                        },
                        if error.is_none() {
                            warnings
                        } else {
                            Vec::new()
                        },
                        error,
                    ));
                } else {
                    let error = verify_unchanged(&target, &original)
                        .and_then(|_| write_transaction(&target, new_content.as_bytes(), false))
                        .err();
                    if error.is_none() {
                        summary.push(format!("M {}", hunk.path));
                    }
                    files.push(result_for(
                        &hunk,
                        "update",
                        if error.is_none() {
                            hunk.chunks.len()
                        } else {
                            0
                        },
                        if error.is_none() {
                            hunk_lines_added(&hunk)
                        } else {
                            0
                        },
                        if error.is_none() {
                            hunk_lines_removed(&hunk)
                        } else {
                            0
                        },
                        if error.is_none() {
                            warnings
                        } else {
                            Vec::new()
                        },
                        error,
                    ));
                }
            }
        }
        if let Some(committed) = files.last().filter(|result| result.error.is_none()) {
            after_commit(committed);
        }
    }

    ApplyPatchResult {
        fully_applied: files.iter().all(|file| file.error.is_none()),
        summary: if summary.is_empty() {
            "no files changed".into()
        } else {
            summary.join(", ")
        },
        files,
    }
}

#[cfg(test)]
fn patch_commit_checkpoint_key(path: &str) -> String {
    format!("native-patch-commit:{path}")
}

fn result_for(
    hunk: &Hunk,
    action: &str,
    hunks_applied: usize,
    lines_added: usize,
    lines_removed: usize,
    warnings: Vec<String>,
    error: Option<String>,
) -> ApplyPatchFileResult {
    ApplyPatchFileResult {
        path: hunk.path.clone(),
        action: action.into(),
        move_to: hunk.move_path.clone(),
        hunks_applied,
        lines_added,
        lines_removed,
        warnings,
        error,
    }
}

fn count_text_lines(content: &str) -> usize {
    content.lines().count()
}

fn count_text_lines_bytes(content: &[u8]) -> usize {
    count_text_lines(&String::from_utf8_lossy(content))
}

fn hunk_lines_added(hunk: &Hunk) -> usize {
    hunk.chunks
        .iter()
        .map(|chunk| {
            chunk
                .new_lines
                .len()
                .saturating_sub(chunk.context_line_mappings.len())
        })
        .sum()
}

fn hunk_lines_removed(hunk: &Hunk) -> usize {
    hunk.chunks
        .iter()
        .map(|chunk| {
            chunk
                .old_lines
                .len()
                .saturating_sub(chunk.context_line_mappings.len())
        })
        .sum()
}

#[tauri::command]
pub fn tool_apply_patch_targets(
    req: ApplyPatchTargetsRequest,
) -> Result<ApplyPatchTargetsResult, ToolError> {
    discover_patch_targets(&req.patch)
}

#[tauri::command]
pub fn tool_apply_patch_preflight(
    req: ApplyPatchPreflightRequest,
) -> Result<ApplyPatchPreflightResult, ToolError> {
    let roots = merged_roots(req.allowed_roots.as_deref().unwrap_or(&[]));
    let plan = build_resolved_plan(&req.patch, &roots)?;
    let actions = plan
        .hunks
        .iter()
        .map(|resolved| PatchAction {
            action: if resolved.destination.is_some() {
                "move".into()
            } else {
                resolved.hunk.hunk_type.label().into()
            },
            path: resolved.hunk.path.clone(),
            move_to: resolved.hunk.move_path.clone(),
        })
        .collect();
    Ok(ApplyPatchPreflightResult {
        plan_id: plan.plan_id,
        affected_paths: plan.affected_paths,
        actions,
        diagnostics: Vec::new(),
    })
}

#[tauri::command]
pub async fn tool_apply_patch(req: ApplyPatchRequest) -> Result<ToolOk, ToolError> {
    let cancel_token = CancellationToken::new();
    let _guard = req.call_id.as_ref().map(|call_id| {
        super::registry::register_with_group(
            call_id.clone(),
            ToolHandle(cancel_token.clone()),
            req.group_id.clone(),
        )
    });
    let worker_token = cancel_token.clone();
    tokio::task::spawn_blocking(move || execute_request_cancellable(req, &worker_token))
        .await
        .map_err(|error| ToolError::Io(format!("task join failed: {}", error)))?
}

#[cfg(test)]
fn execute_request(req: ApplyPatchRequest) -> Result<ToolOk, ToolError> {
    let cancel_token = CancellationToken::new();
    execute_request_cancellable(req, &cancel_token)
}

fn execute_request_cancellable(
    req: ApplyPatchRequest,
    cancel_token: &CancellationToken,
) -> Result<ToolOk, ToolError> {
    if cancel_token.is_cancelled() {
        return Err(ToolError::Aborted);
    }
    if req.plan_id.trim().is_empty() {
        return Err(ToolError::Io(
            "apply_patch execution requires a native preflight plan_id".into(),
        ));
    }
    let roots = merged_roots(req.allowed_roots.as_deref().unwrap_or(&[]));
    let initial_plan = build_resolved_plan(&req.patch, &roots)?;
    if cancel_token.is_cancelled() {
        return Err(ToolError::Aborted);
    }
    if initial_plan.plan_id != req.plan_id {
        return Err(ToolError::Io(format!(
            "plan_id mismatch: authorized {}, resolved {}",
            req.plan_id, initial_plan.plan_id
        )));
    }

    // Preflight/authorization happens before this command. Acquire every
    // canonical source and destination in sorted order, then resolve the plan
    // again under the locks so another LC executable cannot change the target
    // set between discovery and preparation.
    let lock_targets: Vec<PathBuf> = initial_plan
        .affected_paths
        .iter()
        .map(PathBuf::from)
        .collect();
    let _process_locks = ProcessFileLocks::acquire(&lock_targets).map_err(|error| {
        ToolError::Io(format!(
            "could not acquire cross-process file locks: {}",
            error
        ))
    })?;
    if cancel_token.is_cancelled() {
        return Err(ToolError::Aborted);
    }
    let locked_plan = build_resolved_plan(&req.patch, &roots)?;
    if locked_plan.plan_id != initial_plan.plan_id
        || locked_plan.affected_paths != initial_plan.affected_paths
    {
        return Err(ToolError::Io(
            "Patch targets changed while acquiring cross-process locks. Run preflight again."
                .into(),
        ));
    }

    let prepared = prepare_plan(locked_plan)?;
    if cancel_token.is_cancelled() {
        return Err(ToolError::Aborted);
    }
    let result = apply_prepared_cancellable(
        prepared,
        || cancel_token.is_cancelled(),
        |_committed| {
            #[cfg(test)]
            super::registry::test_support::hit(&patch_commit_checkpoint_key(&_committed.path));
        },
    );
    Ok(serde_json::to_value(result).unwrap_or_else(|_| {
        serde_json::json!({
            "files": [],
            "summary": "serialization error",
            "fully_applied": false
        })
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir {
        path: PathBuf,
    }

    impl TempDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "lc-apply-patch-test-{:016x}",
                rand::random::<u64>()
            ));
            std::fs::create_dir_all(&path).unwrap();
            // The tool canonicalizes every target, so the fixture has to
            // resolve the same way or the comparisons drift apart wherever
            // the temp dir is not already canonical: macOS hands out
            // `/var/folders/…`, where `/var` symlinks to `/private/var`, and
            // Windows temp paths can be 8.3 short names (`RUNNER~1` on GitHub's
            // runners) that expand when resolved. Going through the tool's own
            // helper also drops the `\\?\` prefix `std::fs::canonicalize`
            // would otherwise add on Windows.
            let path = canonicalize_allow_missing(&path.to_string_lossy()).unwrap();
            Self { path }
        }

        fn path(&self) -> &Path {
            &self.path
        }

        fn roots(&self) -> Vec<PathBuf> {
            vec![self.path.clone()]
        }

        fn root_strings(&self) -> Vec<String> {
            vec![self.path.to_string_lossy().to_string()]
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    fn chunk(old: &[&str], new: &[&str], context: Option<&str>) -> UpdateChunk {
        UpdateChunk {
            old_lines: old.iter().map(|line| (*line).to_string()).collect(),
            new_lines: new.iter().map(|line| (*line).to_string()).collect(),
            context_line_mappings: Vec::new(),
            change_context: context.map(str::to_string),
            is_end_of_file: false,
        }
    }

    #[test]
    fn parses_add_update_delete_move_and_eof() {
        let patch = "*** Begin Patch\n*** Add File: add.txt\n+added\n*** Update File: old.txt\n*** Move to: new.txt\n@@\n-old\n+new\n*** End of File\n*** Delete File: gone.txt\n*** End Patch";
        let hunks = parse_patch(patch).unwrap();
        assert_eq!(hunks.len(), 3);
        assert!(matches!(hunks[0].hunk_type, HunkType::Add));
        assert_eq!(hunks[0].content.as_deref(), Some("added\n"));
        assert_eq!(hunks[1].move_path.as_deref(), Some("new.txt"));
        assert!(hunks[1].chunks[0].is_end_of_file);
        assert!(matches!(hunks[2].hunk_type, HunkType::Delete));
    }

    #[test]
    fn add_ignores_optional_positional_hunk_header() {
        let patch =
            "*** Begin Patch\n*** Add File: add.txt\n@@ 1,0\n+first\n+second\n*** End Patch";
        let hunks = parse_patch(patch).unwrap();
        assert_eq!(hunks[0].content.as_deref(), Some("first\nsecond\n"));
    }

    #[test]
    fn add_can_escape_a_literal_leading_atat_line() {
        let patch = "*** Begin Patch\n*** Add File: add.txt\n+@@ 1,0\n+content\n*** End Patch";
        let hunks = parse_patch(patch).unwrap();
        assert_eq!(hunks[0].content.as_deref(), Some("@@ 1,0\ncontent\n"));
    }

    #[test]
    fn update_accepts_simple_positional_hunk_header() {
        let patch =
            "*** Begin Patch\n*** Update File: file.txt\n@@ 1,1\n-before\n+after\n*** End Patch";
        let hunks = parse_patch(patch).unwrap();
        assert_eq!(hunks[0].chunks[0].change_context, None);
        let (content, _) = derive_new_content("file.txt", &hunks[0].chunks, "before\n").unwrap();
        assert_eq!(content, "after\n");
    }

    #[test]
    fn named_update_context_remains_supported() {
        let patch = "*** Begin Patch\n*** Update File: file.txt\n@@ function_name\n-old\n+new\n*** End Patch";
        let hunks = parse_patch(patch).unwrap();
        assert_eq!(
            hunks[0].chunks[0].change_context.as_deref(),
            Some("function_name")
        );
    }

    #[test]
    fn hunkless_move_is_accepted_but_hunkless_update_is_rejected() {
        let move_patch =
            "*** Begin Patch\n*** Update File: old.txt\n*** Move to: new.txt\n*** End Patch";
        let hunks = parse_patch(move_patch).unwrap();
        assert_eq!(hunks.len(), 1);
        assert_eq!(hunks[0].move_path.as_deref(), Some("new.txt"));
        assert!(hunks[0].chunks.is_empty());

        let update_patch = "*** Begin Patch\n*** Update File: file.txt\n*** End Patch";
        assert!(parse_patch(update_patch).is_err());
    }

    #[test]
    fn preflight_serialization_keeps_empty_diagnostics() {
        let value = serde_json::to_value(ApplyPatchPreflightResult {
            plan_id: "plan".into(),
            affected_paths: vec!["file.txt".into()],
            actions: vec![],
            diagnostics: vec![],
        })
        .unwrap();

        assert_eq!(value["diagnostics"], serde_json::json!([]));
    }

    #[test]
    fn target_discovery_canonicalizes_every_scope_without_roots_or_mutation() {
        let directory = TempDir::new();
        let add = directory.path().join("new").join("add.txt");
        let source = directory.path().join("source.txt");
        let destination = directory.path().join("moved").join("source.txt");
        std::fs::write(&source, "before\n").unwrap();
        let patch = format!(
            "*** Begin Patch\n*** Add File: {}\n+new\n*** Update File: {}\n*** Move to: {}\n@@\n-before\n+after\n*** End Patch",
            add.display(),
            source.display(),
            destination.display(),
        );

        let discovery = discover_patch_targets(&patch).unwrap();
        assert_eq!(discovery.affected_paths.len(), 3);
        assert_eq!(discovery.actions.len(), 2);
        assert!(discovery
            .affected_paths
            .iter()
            .any(|path| path == &add.to_string_lossy()));
        assert!(discovery
            .affected_paths
            .iter()
            .any(|path| path == &source.to_string_lossy()));
        assert!(discovery
            .affected_paths
            .iter()
            .any(|path| path == &destination.to_string_lossy()));
        assert!(!add.exists());
        assert!(!destination.exists());
        assert_eq!(std::fs::read_to_string(source).unwrap(), "before\n");
    }

    #[test]
    fn malformed_target_discovery_fails_before_preflight() {
        let patch = "*** Begin Patch\n*** Add File:\n+bad\n*** End Patch";
        assert!(discover_patch_targets(patch).is_err());

        let unsafe_path = "*** Begin Patch\n*** Add File: ../escape.txt\n+bad\n*** End Patch";
        assert!(discover_patch_targets(unsafe_path).is_err());
    }

    #[test]
    fn full_preflight_still_requires_authorized_roots() {
        let directory = TempDir::new();
        let target = directory.path().join("new.txt");
        let patch = format!(
            "*** Begin Patch\n*** Add File: {}\n+new\n*** End Patch",
            target.display()
        );
        assert!(discover_patch_targets(&patch).is_ok());
        assert!(tool_apply_patch_preflight(ApplyPatchPreflightRequest {
            patch,
            allowed_roots: Some(Vec::new()),
        })
        .is_err());
        assert!(!target.exists());
    }

    #[test]
    fn patch_and_prepared_plan_boundaries_are_enforced() {
        let directory = TempDir::new();
        let oversized_patch = "x".repeat(MAX_PATCH_BYTES + 1);
        assert_eq!(
            discover_patch_targets(&oversized_patch)
                .unwrap_err()
                .to_string(),
            "io_error: Patch exceeds the 1 MiB UTF-8 limit. Split unrelated changes into smaller patches."
        );

        let duplicate_path = directory.path().join("duplicate.txt");
        let duplicate_source = format!(
            "*** Begin Patch\n*** Add File: {}\n+x\n*** Add File: {}\n+y\n*** End Patch",
            duplicate_path.display(),
            duplicate_path.display(),
        );
        assert_eq!(
            discover_patch_targets(&duplicate_source)
                .unwrap_err()
                .to_string(),
            format!(
                "io_error: Patch rejected: multiple actions target '{}'. Combine them into one file section.",
                duplicate_path.display(),
            )
        );
        let combined_source = format!(
            "*** Begin Patch\n*** Add File: {}\n+x\n+y\n*** End Patch",
            duplicate_path.display(),
        );
        assert!(discover_patch_targets(&combined_source).is_ok());

        let first_source = directory.path().join("first.txt");
        let second_source = directory.path().join("second.txt");
        let duplicate_move = directory.path().join("destination.txt");
        let duplicate_destination = format!(
            "*** Begin Patch\n*** Update File: {}\n*** Move to: {}\n*** Update File: {}\n*** Move to: {}\n*** End Patch",
            first_source.display(),
            duplicate_move.display(),
            second_source.display(),
            duplicate_move.display(),
        );
        assert_eq!(
            discover_patch_targets(&duplicate_destination)
                .unwrap_err()
                .to_string(),
            format!(
                "io_error: Patch rejected: multiple actions target move destination '{}'. Choose one source or use a different destination.",
                duplicate_move.display(),
            )
        );
        let second_destination = directory.path().join("second-destination.txt");
        let distinct_destinations = format!(
            "*** Begin Patch\n*** Update File: {}\n*** Move to: {}\n*** Update File: {}\n*** Move to: {}\n*** End Patch",
            first_source.display(),
            duplicate_move.display(),
            second_source.display(),
            second_destination.display(),
        );
        assert!(discover_patch_targets(&distinct_destinations).is_ok());

        let prefix = format!(
            "*** Begin Patch\n*** Add File: {}\n+",
            directory.path().join("exact.txt").display()
        );
        let suffix = "\n*** End Patch";
        let exact_patch = format!(
            "{}{}{}",
            prefix,
            "x".repeat(MAX_PATCH_BYTES - prefix.len() - suffix.len()),
            suffix
        );
        assert_eq!(exact_patch.len(), MAX_PATCH_BYTES);
        assert!(discover_patch_targets(&exact_patch).is_ok());

        let mut prepared = 0usize;
        add_prepared_bytes(&mut prepared, MAX_PREPARED_BYTES).unwrap();
        assert!(add_prepared_bytes(&mut prepared, 1)
            .unwrap_err()
            .to_string()
            .contains("64 MiB"));
    }

    #[test]
    fn per_target_file_boundary_is_enforced_before_reading() {
        let directory = TempDir::new();
        let target = directory.path().join("oversized.txt");
        let file = std::fs::File::create(&target).unwrap();
        file.set_len(MAX_TARGET_BYTES + 1).unwrap();
        let error = read_bounded(&target, "oversized.txt").unwrap_err();
        assert!(error.to_string().contains("32 MiB"));
    }

    #[test]
    fn rejects_unknown_lines_between_file_sections() {
        let patch = "*** Begin Patch\nunexpected\n*** Add File: file.txt\n+ok\n*** End Patch";
        assert!(parse_patch(patch).is_err());
    }

    #[test]
    fn rejects_unprefixed_update_chunk_lines() {
        let patch = "*** Begin Patch\n*** Update File: file.txt\n@@\ninvalid\n*** End Patch";
        assert!(parse_patch(patch).is_err());
    }

    #[test]
    fn rejects_text_outside_envelope() {
        let patch = "prefix\n*** Begin Patch\n*** Add File: file.txt\n+ok\n*** End Patch";
        assert!(parse_patch(patch).is_err());
    }

    /// A misplaced `*** Move to:` was reported as an "unknown patch
    /// line", which denies the header exists and teaches the caller
    /// nothing. An archived session shows a model retrying the same
    /// layout after that message. State the placement rule instead.
    #[test]
    fn misplaced_move_to_names_the_placement_rule() {
        let patch = "*** Begin Patch\n*** Update File: a.txt\n@@\n-old\n+new\n\
                     *** Move to: b.txt\n*** End Patch";
        let err = parse_patch(patch).unwrap_err();
        assert!(
            err.contains("*** Move to:") && err.contains("*** Update File:"),
            "must name the rule, got: {err}"
        );
        assert!(
            !err.contains("unknown patch line"),
            "must not deny the header exists, got: {err}"
        );
    }

    /// A genuinely unrecognized line still explains how a file entry
    /// starts, rather than only quoting the offending text.
    #[test]
    fn unknown_line_lists_the_valid_file_headers() {
        let patch = "*** Begin Patch\n*** Rename File: a.txt\n*** End Patch";
        let err = parse_patch(patch).unwrap_err();
        assert!(err.contains("unknown patch line"), "got: {err}");
        assert!(err.contains("*** Add File:"), "got: {err}");
    }

    #[test]
    fn contextual_pure_addition_inserts_after_context() {
        let chunks = vec![chunk(&[], &["inserted"], Some("anchor"))];
        let (content, _) = derive_new_content("file.txt", &chunks, "anchor\ntail\n").unwrap();
        assert_eq!(content, "anchor\ninserted\ntail\n");
    }

    #[test]
    fn update_preserves_crlf() {
        let chunks = vec![chunk(&["before"], &["after"], None)];
        let (content, _) = derive_new_content("file.txt", &chunks, "before\r\nrest\r\n").unwrap();
        assert_eq!(content, "after\r\nrest\r\n");
    }

    #[test]
    fn update_preserves_missing_final_newline() {
        let chunks = vec![chunk(&["before"], &["after"], None)];
        let (content, _) = derive_new_content("file.txt", &chunks, "before").unwrap();
        assert_eq!(content, "after");
    }

    #[test]
    fn update_preserves_utf8_bom() {
        let chunks = vec![chunk(&["before"], &["after"], None)];
        let (content, _) = derive_new_content("file.txt", &chunks, "\u{feff}before\n").unwrap();
        assert_eq!(content, "\u{feff}after\n");
    }

    #[test]
    fn eof_anchor_updates_last_matching_sequence() {
        let mut eof_chunk = chunk(&["marker", "end"], &["changed", "end"], None);
        eof_chunk.is_end_of_file = true;
        let (content, _) =
            derive_new_content("file.txt", &[eof_chunk], "marker\nmiddle\nmarker\nend\n").unwrap();
        assert_eq!(content, "marker\nmiddle\nchanged\nend\n");
    }

    #[test]
    fn fuzzy_match_reports_its_quality_without_a_second_scan() {
        let chunks = vec![chunk(&["  before  "], &["after"], None)];
        let (_, warnings) = derive_new_content("file.txt", &chunks, "before\n").unwrap();
        assert_eq!(warnings, vec!["chunk in file.txt applied with trim match"]);
    }

    #[test]
    fn fuzzy_match_preserves_source_whitespace_on_context_lines() {
        let patch = "*** Begin Patch\n*** Update File: file.txt\n@@\n clean line\n-trail four spaces\n+trail four spaces (fallback matched!)\n indented with tab\n*** End Patch";
        let hunks = parse_patch(patch).unwrap();
        let original = "clean line    \ntrail four spaces    \n\tindented with tab\nend\n";

        let (content, warnings) =
            derive_new_content("file.txt", &hunks[0].chunks, original).unwrap();

        assert_eq!(
            content,
            "clean line    \ntrail four spaces (fallback matched!)\n\tindented with tab\nend\n"
        );
        assert_eq!(warnings, vec!["chunk in file.txt applied with trim match"]);
    }

    #[test]
    fn empty_add_creates_empty_content() {
        let hunks = parse_patch("*** Begin Patch\n*** Add File: empty.txt\n*** End Patch").unwrap();
        assert_eq!(hunks[0].content.as_deref(), Some(""));
    }

    #[test]
    fn same_path_move_is_rejected_without_touching_source() {
        let directory = TempDir::new();
        let source = directory.path().join("same.txt");
        std::fs::write(&source, "before\n").unwrap();
        let patch = format!(
            "*** Begin Patch\n*** Update File: {}\n*** Move to: {}\n@@\n-before\n+after\n*** End Patch",
            source.display(),
            source.display()
        );
        assert!(build_resolved_plan(&patch, &directory.roots()).is_err());
        assert_eq!(std::fs::read_to_string(source).unwrap(), "before\n");
    }

    #[test]
    fn hunkless_move_preserves_source_bytes_exactly() {
        let directory = TempDir::new();
        let source = directory.path().join("source.txt");
        let destination = directory.path().join("destination.txt");
        let original = b"\xef\xbb\xbfbefore\r\nmixed\nend\r";
        std::fs::write(&source, original).unwrap();
        let patch = format!(
            "*** Begin Patch\n*** Update File: {}\n*** Move to: {}\n*** End Patch",
            source.display(),
            destination.display()
        );

        let plan = build_resolved_plan(&patch, &directory.roots()).unwrap();
        let result = apply_prepared(prepare_plan(plan).unwrap());

        assert!(result.fully_applied, "{:?}", result.files);
        assert_eq!(result.files[0].action, "move");
        assert_eq!(result.files[0].hunks_applied, 0);
        assert!(!source.exists());
        assert_eq!(std::fs::read(destination).unwrap(), original);
    }

    #[test]
    fn add_and_move_destinations_are_no_clobber() {
        let directory = TempDir::new();
        let existing = directory.path().join("existing.txt");
        let source = directory.path().join("source.txt");
        std::fs::write(&existing, "sentinel\n").unwrap();
        std::fs::write(&source, "before\n").unwrap();

        let add = format!(
            "*** Begin Patch\n*** Add File: {}\n+replacement\n*** End Patch",
            existing.display()
        );
        assert!(build_resolved_plan(&add, &directory.roots()).is_err());

        let move_patch = format!(
            "*** Begin Patch\n*** Update File: {}\n*** Move to: {}\n@@\n-before\n+after\n*** End Patch",
            source.display(),
            existing.display()
        );
        assert!(build_resolved_plan(&move_patch, &directory.roots()).is_err());
        assert_eq!(std::fs::read_to_string(existing).unwrap(), "sentinel\n");
        assert_eq!(std::fs::read_to_string(source).unwrap(), "before\n");
    }

    #[test]
    fn deterministic_failure_prevents_earlier_add_commit() {
        let directory = TempDir::new();
        let created = directory.path().join("created.txt");
        let update = directory.path().join("update.txt");
        std::fs::write(&update, "actual\n").unwrap();
        let patch = format!(
            "*** Begin Patch\n*** Add File: {}\n+created\n*** Update File: {}\n@@\n-missing\n+changed\n*** End Patch",
            created.display(),
            update.display()
        );
        let plan = build_resolved_plan(&patch, &directory.roots()).unwrap();
        assert!(prepare_plan(plan).is_err());
        assert!(!created.exists());
        assert_eq!(std::fs::read_to_string(update).unwrap(), "actual\n");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn second_commit_failure_reports_the_applied_prefix() {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ;

        let directory = TempDir::new();
        let first = directory.path().join("first.txt");
        let second = directory.path().join("second.txt");
        std::fs::write(&first, "before one\n").unwrap();
        std::fs::write(&second, "before two\n").unwrap();
        let patch = format!(
            "*** Begin Patch\n*** Update File: {}\n@@\n-before one\n+after one\n*** Update File: {}\n@@\n-before two\n+after two\n*** End Patch",
            first.display(),
            second.display()
        );
        let plan = build_resolved_plan(&patch, &directory.roots()).unwrap();
        let prepared = prepare_plan(plan).unwrap();
        let _locked = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ)
            .open(&second)
            .unwrap();

        let result = apply_prepared(prepared);

        assert!(!result.fully_applied);
        assert!(result.files[0].error.is_none());
        assert!(result.files[1].error.is_some());
        assert_eq!(std::fs::read_to_string(first).unwrap(), "after one\n");
        assert_eq!(std::fs::read_to_string(second).unwrap(), "before two\n");
    }

    #[test]
    fn applies_add_update_delete_and_move() {
        let directory = TempDir::new();
        let add = directory.path().join("add.txt");
        let update = directory.path().join("update.txt");
        let delete = directory.path().join("delete.txt");
        let source = directory.path().join("source.txt");
        let moved = directory.path().join("moved.txt");
        std::fs::write(&update, "before\r\n").unwrap();
        std::fs::write(&delete, "remove\n").unwrap();
        std::fs::write(&source, "old\n").unwrap();
        let patch = format!(
            "*** Begin Patch\n*** Add File: {}\n+added\n*** Update File: {}\n@@\n-before\n+after\n*** Delete File: {}\n*** Update File: {}\n*** Move to: {}\n@@\n-old\n+new\n*** End Patch",
            add.display(),
            update.display(),
            delete.display(),
            source.display(),
            moved.display()
        );
        let plan = build_resolved_plan(&patch, &directory.roots()).unwrap();
        let result = apply_prepared(prepare_plan(plan).unwrap());
        assert!(result.fully_applied, "{:?}", result.files);
        assert_eq!(std::fs::read_to_string(add).unwrap(), "added\n");
        assert_eq!(std::fs::read_to_string(update).unwrap(), "after\r\n");
        assert!(!delete.exists());
        assert!(!source.exists());
        assert_eq!(std::fs::read_to_string(moved).unwrap(), "new\n");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn abort_group_stops_a_multi_file_patch_between_commits() {
        let directory = TempDir::new();
        let first = directory.path().join("first.txt");
        let second = directory.path().join("second.txt");
        std::fs::write(&first, "before one\n").unwrap();
        std::fs::write(&second, "before two\n").unwrap();
        let patch = format!(
            "*** Begin Patch\n*** Update File: {}\n@@\n-before one\n+after one\n*** Update File: {}\n@@\n-before two\n+after two\n*** End Patch",
            first.display(),
            second.display()
        );
        let preflight = tool_apply_patch_preflight(ApplyPatchPreflightRequest {
            patch: patch.clone(),
            allowed_roots: Some(directory.root_strings()),
        })
        .unwrap();
        let checkpoint = super::super::registry::test_support::BlockingCheckpoint::install(
            patch_commit_checkpoint_key(&first.to_string_lossy()),
        );
        let call_id = format!("test-patch-abort-{:016x}", rand::random::<u64>());
        let group_id = format!("test-patch-group-{:016x}", rand::random::<u64>());
        let task = tokio::spawn(tool_apply_patch(ApplyPatchRequest {
            patch,
            allowed_roots: Some(directory.root_strings()),
            plan_id: preflight.plan_id,
            call_id: Some(call_id.clone()),
            group_id: Some(group_id.clone()),
        }));

        assert!(
            checkpoint.wait_for_hits(1, std::time::Duration::from_secs(5)),
            "patch never completed its first file commit"
        );
        assert_eq!(std::fs::read_to_string(&first).unwrap(), "after one\n");
        assert_eq!(std::fs::read_to_string(&second).unwrap(), "before two\n");
        assert_eq!(
            super::super::registry::abort_group(group_id).await.unwrap(),
            1,
            "active patch was not registered under its execution group"
        );
        checkpoint.release();

        let result = tokio::time::timeout(std::time::Duration::from_secs(5), task)
            .await
            .expect("cancelled patch should settle promptly")
            .expect("patch task should not panic")
            .expect("patch cancellation should return its applied prefix");
        assert_eq!(result["fully_applied"], false);
        assert!(result["files"][0].get("error").is_none());
        assert_eq!(
            result["files"][1]["error"],
            "cancelled before this file was changed"
        );
        assert_eq!(std::fs::read_to_string(first).unwrap(), "after one\n");
        assert_eq!(std::fs::read_to_string(second).unwrap(), "before two\n");
        assert_eq!(
            checkpoint.hits(),
            1,
            "patch reported another commit checkpoint after group abort"
        );
        assert!(
            !super::super::registry::registry()
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .contains_key(&call_id),
            "settled patch left a registry entry behind"
        );
    }

    #[test]
    fn plan_mismatch_is_rejected_before_mutation() {
        let directory = TempDir::new();
        let target = directory.path().join("new.txt");
        let patch = format!(
            "*** Begin Patch\n*** Add File: {}\n+new\n*** End Patch",
            target.display()
        );
        let result = execute_request(ApplyPatchRequest {
            patch,
            allowed_roots: Some(directory.root_strings()),
            plan_id: "wrong-plan".into(),
            call_id: None,
            group_id: None,
        });
        assert!(result.is_err());
        assert!(!target.exists());
    }

    /// Patching a marked UTF-16 source would rewrite it as UTF-8. The
    /// guard refuses before any commit. It had no test until now.
    #[tokio::test]
    async fn apply_patch_refuses_a_marked_utf16_update_source() {
        let root = std::env::temp_dir().join(format!(
            "lc-patch-utf16-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let target = root.join("log.txt");
        let original = super::super::fs_ops::utf16_bytes_for_test("needle here\n");
        std::fs::write(&target, &original).unwrap();

        let patch = format!(
            "*** Begin Patch\n*** Update File: {}\n@@\n-needle here\n+replaced here\n*** End Patch",
            target.to_string_lossy()
        );
        // Take the real plan id from preflight, so the refusal under
        // test is the encoding guard and not the plan-id check.
        let plan = tool_apply_patch_preflight(ApplyPatchPreflightRequest {
            patch: patch.clone(),
            allowed_roots: Some(vec![root.to_string_lossy().to_string()]),
        })
        .expect("preflight resolves the target");

        let error = tool_apply_patch(ApplyPatchRequest {
            patch,
            allowed_roots: Some(vec![root.to_string_lossy().to_string()]),
            plan_id: plan.plan_id,
            call_id: None,
            group_id: None,
        })
        .await
        .expect_err("a marked UTF-16 source must fail the call");

        let text = error.to_string();
        assert!(
            text.contains("utf-16le") && text.contains("byte-order mark"),
            "patch must refuse and say why, got {text}"
        );
        assert_eq!(
            std::fs::read(&target).unwrap(),
            original,
            "nothing may be committed"
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
