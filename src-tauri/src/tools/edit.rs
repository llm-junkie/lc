//! `tool_edit` — targeted file edits (exact-string replacement).
//!
//! The model provides `old_string` and `new_string`.  Rust verifies
//! that `old_string` appears exactly once (using line-ending-agnostic
//! comparison) and applies the replacement atomically (temp file +
//! rename).  If the string appears zero or multiple times the edit
//! is rejected so the model can adjust its context.
//!
//! Security: `path` must resolve under `allowed_roots` via
//! `resolve_under_roots`.  Same sandbox as `write_file`.

use super::file_tx::FileTransaction;
use super::fs_ops::{enforce_filesystem_batch_limit, merged_roots, resolve_under_roots};
use super::process_file_lock::ProcessFileLocks;
use super::{ToolError, ToolOk};
use serde::Deserialize;
use std::path::PathBuf;

/// Largest file `tool_edit` will read into memory. Matches
/// `apply_patch::MAX_TARGET_BYTES`. The edit path holds up to three copies of
/// the text at once (original, LF-normalized, final), so an uncapped read on a
/// large accidental target is an out-of-memory risk rather than a slow edit.
const MAX_TARGET_BYTES: u64 = 32 * 1024 * 1024;

/// Upper bound on reported match/near-match line numbers. Enough for the model
/// to disambiguate; short enough to keep the tool result small.
const MAX_REPORTED_LINES: usize = 20;

fn count_text_lines(content: &str) -> usize {
    content.lines().count()
}

/// 1-based line numbers of each non-overlapping occurrence of `needle`.
///
/// `match_indices` yields strictly increasing positions, so the newline count
/// advances with a single forward scan instead of re-counting each prefix.
fn match_line_numbers(haystack: &str, needle: &str, limit: usize) -> Vec<usize> {
    if needle.is_empty() {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut line = 1usize;
    let mut cursor = 0usize;
    for (pos, _) in haystack.match_indices(needle) {
        line += haystack[cursor..pos].matches('\n').count();
        cursor = pos;
        out.push(line);
        if out.len() >= limit {
            break;
        }
    }
    out
}

/// 1-based start lines where `needle_lines` matches `haystack_lines` under a
/// relaxed per-line comparator.
fn relaxed_match_lines(
    haystack_lines: &[&str],
    needle_lines: &[&str],
    compare: fn(&str, &str) -> bool,
) -> Vec<usize> {
    if needle_lines.is_empty() || needle_lines.len() > haystack_lines.len() {
        return Vec::new();
    }
    let end = haystack_lines.len() - needle_lines.len();
    (0..=end)
        .filter(|&index| {
            needle_lines
                .iter()
                .enumerate()
                .all(|(offset, expected)| compare(haystack_lines[index + offset], expected))
        })
        .map(|index| index + 1)
        .take(MAX_REPORTED_LINES)
        .collect()
}

fn cmp_rstrip(a: &str, b: &str) -> bool {
    a.trim_end() == b.trim_end()
}

fn cmp_trim(a: &str, b: &str) -> bool {
    a.trim() == b.trim()
}

/// Explain why an exact match failed, without relaxing the match itself.
///
/// `apply_patch` recovers from whitespace drift with a comparator ladder. Here
/// the replacement stays strictly exact — a silent fuzzy write is far worse
/// than a failed edit — so the same ladder is used only to tell the model what
/// to fix. Returns `(hint, near_match_lines)`.
fn diagnose_miss(content_normalized: &str, old_normalized: &str) -> (String, Vec<usize>) {
    let haystack: Vec<&str> = content_normalized.lines().collect();
    let needle: Vec<&str> = old_normalized.lines().collect();

    let rstrip = relaxed_match_lines(&haystack, &needle, cmp_rstrip);
    if !rstrip.is_empty() {
        return (
            "No exact match. The text matches if trailing whitespace is ignored. Copy the file's trailing whitespace into old_string."
                .to_string(),
            rstrip,
        );
    }

    let trimmed = relaxed_match_lines(&haystack, &needle, cmp_trim);
    if !trimmed.is_empty() {
        return (
            "No exact match. The text matches if leading and trailing whitespace are ignored. Copy the file's leading and trailing whitespace into old_string."
                .to_string(),
            trimmed,
        );
    }

    // Nothing matched as a block. Locating just the first line separates "your
    // anchor is stale" from "the surrounding lines drifted".
    if let Some(first) = needle.first() {
        let first_line_hits = relaxed_match_lines(&haystack, std::slice::from_ref(first), cmp_trim);
        if !first_line_hits.is_empty() {
            return (
                "No exact match. The first line of old_string was found but the lines after it differ. Reread the file and copy the current text."
                    .to_string(),
                first_line_hits,
            );
        }
    }

    (
        "No exact match. The first line of old_string was not found. Reread the file and verify the path before you retry."
            .to_string(),
        Vec::new(),
    )
}

#[derive(Debug, Deserialize)]
pub struct EditFileEntry {
    pub path: String,
    pub old_string: String,
    pub new_string: String,
}

#[derive(Debug, Deserialize)]
pub struct EditRequest {
    pub files: Vec<EditFileEntry>,
    pub create_if_missing: Option<bool>,
    pub allowed_roots: Option<Vec<String>>,
}

#[tauri::command]
pub async fn tool_edit(req: EditRequest) -> Result<ToolOk, ToolError> {
    enforce_filesystem_batch_limit("lc_edit_file", "files", req.files.len())?;
    tokio::task::spawn_blocking(move || {
        let roots = merged_roots(req.allowed_roots.as_deref().unwrap_or(&[]));
        let mut results: Vec<serde_json::Value> = Vec::with_capacity(req.files.len());

        for file in &req.files {
            let entry = edit_single_file(
                &file.path,
                &roots,
                &file.old_string,
                &file.new_string,
                req.create_if_missing,
            );
            results.push(entry);
        }

        Ok(serde_json::json!({ "results": results }))
    })
    .await
    .map_err(|e| ToolError::Io(format!("task join failed: {}", e)))?
}

fn edit_single_file(
    path: &str,
    roots: &[PathBuf],
    old_string: &str,
    new_string: &str,
    create_if_missing: Option<bool>,
) -> serde_json::Value {
    let create_if_missing = create_if_missing.unwrap_or(false);

    let target = match resolve_under_roots(path, roots) {
        Ok(t) => t,
        Err(e) => return edit_err_entry(path, &e.to_string(), false),
    };

    // Hold the native target lock before the existence check/read and through
    // commit so separate LC executables cannot race this edit.
    let _process_lock = match ProcessFileLocks::acquire(std::slice::from_ref(&target)) {
        Ok(lock) => lock,
        Err(error) => {
            return edit_err_entry(
                path,
                &format!("could not acquire cross-process file lock: {}", error),
                target.exists(),
            )
        }
    };

    if !target.exists() {
        if create_if_missing {
            // Use FileTransaction for atomic create of a missing file.
            let mut tx = match FileTransaction::new(&target) {
                Ok(t) => t,
                Err(e) => return edit_err_entry(path, &e.to_string(), false),
            };
            let content = new_string;
            if let Err(e) = tx.write_str(content) {
                return edit_err_entry(path, &e.to_string(), false);
            }
            if let Err(e) = tx.commit_create() {
                return edit_err_entry(path, &e.to_string(), false);
            }
            // `created: true` disambiguates this from a replacement — without
            // it, `replaced: true, occurrences: 0` reads as a contradiction.
            let mut entry = serde_json::json!({
                "path": path,
                "replaced": true, "created": true, "occurrences": 0, "file_exists": false,
                "bytes_before": 0, "bytes_after": content.len(),
                "lines_added": count_text_lines(content), "lines_removed": 0,
            });
            if !old_string.is_empty() {
                entry["hint"] = serde_json::json!(
                    "file did not exist, so it was created from new_string; old_string was \
                     not used"
                );
            }
            return entry;
        }
        return edit_err_entry(path, "file not found", false);
    }

    let meta = match std::fs::metadata(&target) {
        Ok(m) => m,
        Err(e) => return edit_err_entry(path, &e.to_string(), true),
    };
    if !meta.is_file() {
        return edit_err_entry(path, "not a file", true);
    }
    let bytes_before = meta.len();
    if bytes_before > MAX_TARGET_BYTES {
        return edit_err_entry(
            path,
            &format!(
                "file too large to edit ({} bytes, max {} bytes). Reduce the file below the \
                 limit or use an external editor.",
                bytes_before, MAX_TARGET_BYTES
            ),
            true,
        );
    }

    // Same text-admission policy as `lc_read_file` and `lc_apply_patch`.
    // `read_to_string` alone accepts a NUL byte, because NUL is valid
    // UTF-8 — which let this tool edit a UTF-16 file that `lc_read_file`
    // refuses to show the caller.
    let original_bytes = match std::fs::read(&target) {
        Ok(bytes) => bytes,
        Err(e) => return edit_err_entry(path, &e.to_string(), true),
    };
    // BOM-marked UTF-16 is readable elsewhere via transcoding, but
    // editing here would rewrite the file as UTF-8 and silently change
    // its encoding. Refuse with that stated plainly.
    if let Some(kind) = super::fs_ops::utf16_bom(&original_bytes) {
        return edit_err_entry(
            path,
            &format!(
                "file is {} behind a byte-order mark: lc_read_file transcodes it for reading, \
                 but editing would rewrite the file as UTF-8 and change its encoding. Convert \
                 the file to UTF-8 first, then edit.",
                kind.label()
            ),
            true,
        );
    }
    if let Some(reason) = super::fs_ops::classify_text(&original_bytes) {
        // `true`: the file exists and was just read. Reporting
        // `file_exists: false` would send the caller hunting for a bad
        // path instead of an encoding problem.
        return edit_err_entry(path, reason.remedy(), true);
    }
    let original = match String::from_utf8(original_bytes) {
        Ok(o) => o,
        Err(e) => return edit_err_entry(path, &e.to_string(), true),
    };

    // Detect line-ending style from the first line of the original file.
    // This is more precise than a global `.contains("\r\n")` because it
    // picks the dominant style at the start of the file rather than
    // relying on any CRLF appearing anywhere (which may be spurious).
    let first_crlf = original.find("\r\n");
    let first_lf = original.find('\n');
    let use_crlf = match (first_crlf, first_lf) {
        (Some(crlf), Some(lf)) => crlf < lf,
        (Some(_), None) => true,
        _ => false,
    };

    // Normalize both old and new strings to LF for matching.
    // This prevents CRLF double-conversion: when new_string contains
    // \r\n and the file uses CRLF, we normalize NEW to LF first so the
    // final CRLF restoration doesn't double the \r.
    let old_normalized = old_string.replace("\r\n", "\n");
    let content_normalized = original.replace("\r\n", "\n");

    // An empty old_string matches at every byte offset, which would always
    // report as "ambiguous". Say what the model actually did wrong.
    if old_normalized.is_empty() {
        return edit_err_entry(
            path,
            "old_string must not be empty for an existing file. Use lc_write_file to replace \
             the whole file.",
            true,
        );
    }

    let count = content_normalized.matches(&old_normalized).count();

    if count == 0 {
        // Failure stays a non-exception "silent success" so the model can
        // retry, but it now carries the reason instead of a bare zero.
        let (hint, near_match_lines) = diagnose_miss(&content_normalized, &old_normalized);
        return serde_json::json!({
            "path": path,
            "replaced": false, "occurrences": 0, "file_exists": true,
            "bytes_before": bytes_before, "bytes_after": bytes_before,
            "lines_added": 0, "lines_removed": 0,
            "hint": hint,
            "near_match_lines": near_match_lines,
        });
    }
    if count > 1 {
        // Report where the matches are so the model can pick disambiguating
        // context without rereading the file.
        let match_lines =
            match_line_numbers(&content_normalized, &old_normalized, MAX_REPORTED_LINES);
        return serde_json::json!({
            "path": path,
            "replaced": false, "occurrences": count, "file_exists": true,
            "bytes_before": bytes_before, "bytes_after": bytes_before,
            "lines_added": 0, "lines_removed": 0,
            "match_lines": match_lines,
            "hint": "old_string is ambiguous. Add surrounding lines until it appears exactly once.",
        });
    }

    let new_normalized = new_string.replace("\r\n", "\n");
    let new_content = content_normalized.replacen(&old_normalized, &new_normalized, 1);
    let final_content = if use_crlf {
        new_content.replace('\n', "\r\n")
    } else {
        new_content
    };

    // Use the shared FileTransaction for atomic write (stage → flush → replace).
    let mut tx = match FileTransaction::new(&target) {
        Ok(t) => t,
        Err(e) => return edit_err_entry(path, &e.to_string(), true),
    };
    if let Err(e) = tx.write_str(&final_content) {
        return edit_err_entry(path, &e.to_string(), true);
    }
    if let Err(e) = tx.commit() {
        return edit_err_entry(path, &e.to_string(), true);
    }

    serde_json::json!({
        "path": path,
        "replaced": true, "occurrences": 1, "file_exists": true,
        "bytes_before": bytes_before, "bytes_after": final_content.len() as u64,
        "lines_added": count_text_lines(&new_normalized),
        "lines_removed": count_text_lines(&old_normalized),
    })
}

fn edit_err_entry(path: &str, msg: &str, file_exists: bool) -> serde_json::Value {
    serde_json::json!({
        "path": path,
        "error": msg,
        "replaced": false,
        "occurrences": 0,
        "file_exists": file_exists,
        "bytes_before": 0,
        "bytes_after": 0,
        "lines_added": 0,
        "lines_removed": 0,
    })
}

#[cfg(test)]
mod tests {
    use super::{tool_edit, EditFileEntry, EditRequest};

    #[tokio::test]
    async fn native_edit_preserves_line_endings_and_meaningful_replacements() {
        let root = std::env::temp_dir().join(format!(
            "lc-edit-contract-{}-{}",
            std::process::id(),
            rand::random::<u64>()
        ));
        std::fs::create_dir(&root).unwrap();
        for (name, before, old, new, expected) in [
            ("lf.txt", "first\nneedle\n", "needle", "β", "first\nβ\n"),
            (
                "crlf.txt",
                "first\r\nneedle\r\n",
                "first\nneedle",
                "one\ntwo",
                "one\r\ntwo\r\n",
            ),
            (
                "bom.txt",
                "\u{feff}first\nneedle",
                "needle",
                "",
                "\u{feff}first\n",
            ),
            ("space.txt", "first  needle", "needle", " \t", "first   \t"),
        ] {
            let path = root.join(name);
            std::fs::write(&path, before).unwrap();
            let result = tool_edit(EditRequest {
                files: vec![EditFileEntry {
                    path: path.to_string_lossy().into_owned(),
                    old_string: old.into(),
                    new_string: new.into(),
                }],
                create_if_missing: None,
                allowed_roots: Some(vec![root.to_string_lossy().into_owned()]),
            })
            .await
            .unwrap();
            assert_eq!(result["results"][0]["replaced"], true, "{name}: {result}");
            assert_eq!(std::fs::read(&path).unwrap(), expected.as_bytes(), "{name}");
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn edit_batch_limit_rejects_cap_plus_one_before_io() {
        let error = tool_edit(EditRequest {
            files: (0..=super::super::fs_ops::FILESYSTEM_BATCH_MAX_ENTRIES)
                .map(|index| EditFileEntry {
                    path: format!("missing-{index}"),
                    old_string: "a".into(),
                    new_string: "b".into(),
                })
                .collect(),
            create_if_missing: None,
            allowed_roots: None,
        })
        .await
        .expect_err("edit cap + 1 must fail before I/O");
        assert!(error.to_string().contains("files contains 21 entries"));
        assert!(error.to_string().contains("batches of 20 or fewer"));
    }

    /// Helper: simulate the CRLF normalization logic from edit_single_file
    /// without touching the filesystem. Uses first-line detection for
    /// line-ending style (Phase 3.3).
    fn simulate_edit(old_string: &str, new_string: &str, original_content: &str) -> String {
        let old_normalized = old_string.replace("\r\n", "\n");
        let new_normalized = new_string.replace("\r\n", "\n");
        let content_normalized = original_content.replace("\r\n", "\n");
        let new_content = content_normalized.replacen(&old_normalized, &new_normalized, 1);
        // Detect CRLF from first line (Phase 3.3: per-file first-line detection).
        let first_crlf = original_content.find("\r\n");
        let first_lf = original_content.find('\n');
        let use_crlf = match (first_crlf, first_lf) {
            (Some(crlf), Some(lf)) => crlf < lf,
            (Some(_), None) => true,
            _ => false,
        };
        if use_crlf {
            new_content.replace('\n', "\r\n")
        } else {
            new_content
        }
    }

    // ── CRLF tests (Phase 0B.6 — GLM H3, GPT §4.6) ──────────────

    #[test]
    fn lf_file_lf_strings() {
        let result = simulate_edit("hello", "world", "hello\n");
        assert_eq!(result, "world\n");
    }

    #[test]
    fn crlf_file_crlf_old_lf_new() {
        // File uses CRLF, old and new strings use LF.
        let result = simulate_edit("hello", "world", "hello\r\n");
        assert_eq!(result, "world\r\n");
    }

    #[test]
    fn crlf_file_crlf_old_crlf_new() {
        // File uses CRLF, BOTH old_string and new_string contain \r\n.
        // This is the critical case — without normalization, \r\n in
        // new_string gets doubled to \r\r\n by the final replace().
        let result = simulate_edit("hello\r\n", "world\r\n", "hello\r\n");
        // Should produce "world\r\n" — NOT "world\r\r\n".
        assert_eq!(
            result, "world\r\n",
            "CRLF new_string must not double-convert"
        );
        assert!(!result.contains("\r\r"), "must not contain double CR");
    }

    #[test]
    fn crlf_file_lf_old_crlf_new() {
        // File uses CRLF, old_string is LF, new_string contains CRLF.
        // replacen("hello", "world\n", 1) on "hello\n" → "world\n\n"
        // (replacement \n + original trailing \n). CRLF restore → "world\r\n\r\n".
        let result = simulate_edit("hello", "world\r\n", "hello\r\n");
        assert_eq!(result, "world\r\n\r\n");
        assert!(!result.contains("\r\r"));
    }

    #[test]
    fn crlf_file_mixed_line_endings_in_new_string() {
        // new_string contains a mix of LF and CRLF line endings.
        // The normalization step converts all \r\n to \n first,
        // then the final CRLF restore applies uniformly.
        let original = "line1\r\nline2\r\n";
        let old = "line2";
        let new = "replaced\r\nwith\r\nCRLF";
        let result = simulate_edit(old, new, original);
        assert_eq!(result, "line1\r\nreplaced\r\nwith\r\nCRLF\r\n");
        assert!(!result.contains("\r\r"));
    }

    #[test]
    fn lf_file_crlf_new_string() {
        // File uses LF, new_string contains CRLF. The file stays LF
        // because the original had no \r\n.
        // replacen("hello", "world\n", 1) on "hello\n" produces "world\n\n"
        // because the replacement text includes \n AND the original trailing \n.
        let result = simulate_edit("hello", "world\r\n", "hello\n");
        assert_eq!(result, "world\n\n");
    }

    #[test]
    fn crlf_file_preserves_original_crlf_count() {
        // Multi-line CRLF file. Edit one line with CRLF new_string.
        // replacen("line2", "replaced\n", 1) on "line1\nline2\nline3\n"
        // gives "line1\nreplaced\n\nline3\n" — the replacement includes a \n
        // AND the original \n after line2 stays. CRLF restore doubles them.
        let original = "line1\r\nline2\r\nline3\r\n";
        let result = simulate_edit("line2", "replaced\r\n", original);
        assert_eq!(result, "line1\r\nreplaced\r\n\r\nline3\r\n");
        assert!(!result.contains("\r\r"));
    }

    // ── non-CRLF regression tests ───────────────────────────────

    #[test]
    fn lf_file_no_change_for_lf() {
        let result = simulate_edit("foo", "bar", "foo\nbaz\n");
        assert_eq!(result, "bar\nbaz\n");
    }

    #[test]
    fn single_occurrence_only() {
        // replacen replaces only the first occurrence.
        let result = simulate_edit("dup", "new", "dup\nkeep\n");
        assert_eq!(result, "new\nkeep\n");
    }

    // ── match line numbers (ambiguous edits) ────────────────────

    use super::{diagnose_miss, edit_single_file, match_line_numbers, MAX_REPORTED_LINES};

    #[test]
    fn concurrent_create_if_missing_calls_never_clobber_each_other() {
        let root = std::env::temp_dir().join(format!(
            "lc-edit-create-test-{:016x}",
            rand::random::<u64>()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let target = root.join("created.txt");
        let path = target.to_string_lossy().to_string();

        let spawn = |content: &'static str| {
            let path = path.clone();
            let roots = vec![root.clone()];
            std::thread::spawn(move || edit_single_file(&path, &roots, "", content, Some(true)))
        };
        let first = spawn("first");
        let second = spawn("second");
        let results = [first.join().unwrap(), second.join().unwrap()];

        assert_eq!(
            results
                .iter()
                .filter(|entry| entry["created"].as_bool() == Some(true))
                .count(),
            1
        );
        assert_eq!(
            results
                .iter()
                .filter(|entry| entry["error"].is_string())
                .count(),
            1
        );
        let content = std::fs::read_to_string(&target).unwrap();
        assert!(content == "first" || content == "second");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn match_lines_reports_every_occurrence() {
        let content = "a\ntarget\nb\ntarget\nc\ntarget\n";
        let lines = match_line_numbers(content, "target", MAX_REPORTED_LINES);
        assert_eq!(lines, vec![2, 4, 6]);
    }

    #[test]
    fn match_lines_handles_multiline_needle() {
        let content = "x\nfoo\nbar\ny\nfoo\nbar\n";
        let lines = match_line_numbers(content, "foo\nbar", MAX_REPORTED_LINES);
        assert_eq!(lines, vec![2, 5]);
    }

    #[test]
    fn match_lines_respects_limit() {
        let content = "dup\n".repeat(100);
        let lines = match_line_numbers(&content, "dup", 5);
        assert_eq!(lines, vec![1, 2, 3, 4, 5]);
    }

    #[test]
    fn match_lines_empty_needle_is_empty() {
        assert!(match_line_numbers("anything", "", MAX_REPORTED_LINES).is_empty());
    }

    // ── miss diagnosis ──────────────────────────────────────────

    #[test]
    fn diagnose_detects_trailing_whitespace_drift() {
        // File has a trailing space the model's old_string omits.
        let content = "fn main() {\n    let x = 1;   \n}\n";
        let (hint, lines) = diagnose_miss(content, "    let x = 1;");
        assert!(hint.contains("trailing whitespace"), "got: {hint}");
        assert_eq!(lines, vec![2]);
    }

    #[test]
    fn diagnose_detects_indentation_drift() {
        // Model guessed 2-space indent; the file uses 4.
        let content = "fn main() {\n    let x = 1;\n}\n";
        let (hint, lines) = diagnose_miss(content, "  let x = 1;");
        assert!(hint.contains("leading and trailing whitespace"), "got: {hint}");
        assert_eq!(lines, vec![2]);
    }

    #[test]
    fn diagnose_detects_stale_trailing_lines() {
        // First line still matches; the line after it has changed.
        let content = "fn main() {\n    let x = 1;\n}\n";
        let (hint, lines) = diagnose_miss(content, "fn main() {\n    let y = 2;");
        assert!(hint.contains("first line"), "got: {hint}");
        assert_eq!(lines, vec![1]);
    }

    #[test]
    fn diagnose_reports_absent_text() {
        let content = "fn main() {\n    let x = 1;\n}\n";
        let (hint, lines) = diagnose_miss(content, "totally absent line");
        assert!(hint.contains("first line of old_string was not found"), "got: {hint}");
        assert!(lines.is_empty());
    }

    #[test]
    fn diagnose_prefers_rstrip_over_trim() {
        // Both comparators would match; the more specific reason wins so the
        // model is not told to fix indentation that is already correct.
        let content = "    keep me   \n";
        let (hint, _) = diagnose_miss(content, "    keep me");
        assert!(hint.contains("trailing whitespace"), "got: {hint}");
        assert!(!hint.contains("indentation"), "got: {hint}");
    }

    /// `read_to_string` accepts a NUL byte, because NUL is valid UTF-8.
    /// That let this tool edit an unmarked UTF-16 file which `lc_read_file`
    /// refuses to show the caller and `lc_grep` skips as binary.
    #[tokio::test]
    async fn edit_refuses_content_the_read_tools_refuse() {
        let root = std::env::temp_dir().join(format!(
            "lc-edit-textpolicy-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let utf16 = root.join("utf16.txt");
        std::fs::write(&utf16, b"n\x00e\x00e\x00d\x00l\x00e\x00").unwrap();
        let latin1 = root.join("latin1.txt");
        std::fs::write(&latin1, b"caf\xe9 au lait\n").unwrap();

        let result = tool_edit(EditRequest {
            files: vec![
                EditFileEntry {
                    path: utf16.to_string_lossy().to_string(),
                    old_string: "needle".into(),
                    new_string: "replaced".into(),
                },
                EditFileEntry {
                    path: latin1.to_string_lossy().to_string(),
                    old_string: "lait".into(),
                    new_string: "creme".into(),
                },
            ],
            create_if_missing: None,
            allowed_roots: Some(vec![root.to_string_lossy().to_string()]),
        })
        .await
        .expect("per-file errors stay in band");

        let entries = result["results"].as_array().unwrap();
        assert!(entries[0]["error"]
            .as_str()
            .unwrap_or_default()
            .starts_with("binary_detected"));
        assert!(entries[1]["error"]
            .as_str()
            .unwrap_or_default()
            .starts_with("encoding_not_utf8"));

        // Neither file was touched.
        assert_eq!(
            std::fs::read(&utf16).unwrap(),
            b"n\x00e\x00e\x00d\x00l\x00e\x00"
        );
        assert_eq!(std::fs::read(&latin1).unwrap(), b"caf\xe9 au lait\n");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn oversized_edit_names_a_reachable_recovery() {
        let root = std::env::temp_dir().join(format!(
            "lc-edit-oversized-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let target = root.join("large.txt");
        let file = std::fs::File::create(&target).unwrap();
        file.set_len(super::MAX_TARGET_BYTES + 1).unwrap();

        let result = tool_edit(EditRequest {
            files: vec![EditFileEntry {
                path: target.to_string_lossy().to_string(),
                old_string: "old".into(),
                new_string: "new".into(),
            }],
            create_if_missing: None,
            allowed_roots: Some(vec![root.to_string_lossy().to_string()]),
        })
        .await
        .expect("oversized targets return a per-file error");

        let error = result["results"][0]["error"].as_str().unwrap_or_default();
        assert!(error.contains("external editor"), "got {error}");
        assert!(!error.contains("lc_apply_patch"), "got {error}");
        assert_eq!(
            std::fs::metadata(&target).unwrap().len(),
            super::MAX_TARGET_BYTES + 1
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    /// `lc_read_file` transcodes a marked UTF-16 file so a caller can
    /// read it. Editing through that transcode would write UTF-8 back
    /// and change the file's encoding, so the guard refuses. The guard
    /// existed with no test, which is how a guard quietly stops working.
    #[tokio::test]
    async fn edit_refuses_a_marked_utf16_target() {
        let root = std::env::temp_dir().join(format!(
            "lc-edit-utf16-{}-{}",
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

        let result = tool_edit(EditRequest {
            files: vec![EditFileEntry {
                path: target.to_string_lossy().to_string(),
                old_string: "needle".into(),
                new_string: "replaced".into(),
            }],
            create_if_missing: None,
            allowed_roots: Some(vec![root.to_string_lossy().to_string()]),
        })
        .await
        .expect("per-file errors stay in band");

        let error = result["results"][0]["error"].as_str().unwrap_or_default();
        assert!(
            error.contains("utf-16le") && error.contains("byte-order mark"),
            "edit must refuse and say why, got {error}"
        );
        assert_eq!(result["results"][0]["file_exists"], true);
        assert_eq!(
            std::fs::read(&target).unwrap(),
            original,
            "the file must be untouched"
        );
        std::fs::remove_dir_all(root).unwrap();
    }


    #[tokio::test]
    async fn edit_miss_remedies_replay_through_the_handler() {
        let root = std::env::temp_dir().join(format!("lc-edit-remedy-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("text.txt");
        let roots = Some(vec![root.to_string_lossy().to_string()]);
        let call = |old: &str| EditRequest {
            files: vec![EditFileEntry {
                path: path.to_string_lossy().to_string(),
                old_string: old.into(),
                new_string: "updated\n".into(),
            }],
            create_if_missing: None,
            allowed_roots: roots.clone(),
        };
        for (content, ineffective_retry, expected_hint) in [
            ("alpha  \nbeta\n", "alpha\r\nbeta\r\n",
             "No exact match. The text matches if trailing whitespace is ignored. Copy the file's trailing whitespace into old_string."),
            ("  alpha \nbeta\n", "  alpha\nbeta\n",
             "No exact match. The text matches if leading and trailing whitespace are ignored. Copy the file's leading and trailing whitespace into old_string."),
        ] {
            std::fs::write(&path, content).unwrap();
            let miss = tool_edit(call("alpha\nbeta\n")).await.unwrap();
            assert_eq!(miss["results"][0]["replaced"], false);
            assert_eq!(miss["results"][0]["near_match_lines"], serde_json::json!([1]));
            let repeated = tool_edit(call(ineffective_retry)).await.unwrap();
            assert_eq!(repeated["results"][0]["replaced"], false);
            assert_eq!(std::fs::read_to_string(&path).unwrap(), content);
            // Pin the full remedy, then replay it against the actual handler.
            assert_eq!(miss["results"][0]["hint"], expected_hint);
            let corrected = tool_edit(call(content)).await.unwrap();
            assert_eq!(corrected["results"][0]["replaced"], true);
            assert_eq!(std::fs::read_to_string(&path).unwrap(), "updated\n");
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn edit_missing_first_line_does_not_deny_a_later_line() {
        let root = std::env::temp_dir().join(format!("lc-edit-anchor-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("text.txt");
        let content = "alpha\nbeta\n";
        std::fs::write(&path, content).unwrap();
        let result = tool_edit(EditRequest {
            files: vec![EditFileEntry {
                path: path.to_string_lossy().to_string(),
                old_string: "absent\nbeta\n".into(),
                new_string: "updated\n".into(),
            }],
            create_if_missing: None,
            allowed_roots: Some(vec![root.to_string_lossy().to_string()]),
        }).await.unwrap();
        assert_eq!(result["results"][0]["replaced"], false);
        assert_eq!(result["results"][0]["hint"],
            "No exact match. The first line of old_string was not found. Reread the file and verify the path before you retry.");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), content);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn edit_ambiguity_reports_the_total_and_bounded_locations() {
        let root = std::env::temp_dir().join(format!("lc-edit-locations-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("text.txt");
        for count in [19, 20, 21] {
            let content = "needle\n".repeat(count);
            std::fs::write(&path, &content).unwrap();
            let result = tool_edit(EditRequest {
                files: vec![EditFileEntry {
                    path: path.to_string_lossy().to_string(),
                    old_string: "needle".into(),
                    new_string: "updated".into(),
                }],
                create_if_missing: None,
                allowed_roots: Some(vec![root.to_string_lossy().to_string()]),
            }).await.unwrap();
            assert_eq!(result["results"][0]["occurrences"], count);
            assert_eq!(result["results"][0]["match_lines"].as_array().unwrap().len(), count.min(20));
            assert_eq!(result["results"][0]["replaced"], false);
            assert_eq!(std::fs::read_to_string(&path).unwrap(), content);
        }
        std::fs::remove_dir_all(root).unwrap();
    }
}
