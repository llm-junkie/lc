//! File-system tools and the path-sandbox that backs them.
//!
//! The sandbox is the security-critical core — every path a
//! model can read or write must pass through `resolve_under_roots`.
//! See `docs/security.md` for the full design
//! covering symlink resolution, case-insensitivity, UNC-prefix
//! stripping, and sibling-folder attacks this design blocks.
//!
//! Implemented tools (this file):
//! - `resolve_under_roots` — canonicalize + containment check
//! - `tool_read_file` — sandboxed read with line slicing (including
//!   streamed ranges from large files), strict UTF-8 admission
//!   (`binary_detected` / `encoding_not_utf8`) with BOM-marked UTF-16
//!   transcoding for readers, and SHA-256 integrity hash
//! - `tool_read_image` — sandboxed image read with optional re-encode
//! - `tool_write_file` — atomic create/write/append
//! - `tool_list_dir` — sandboxed directory listing with glob filtering
//! - `tool_check_path` — fast stat/existence check (no content read)
//! - `tool_resolve_path` — canonical permission identity resolution
//! - `tool_stat` — sandboxed file/directory metadata lookup
//! - `tool_analyze_images` — sandboxed image preparation for model analysis

use super::file_tx::FileTransaction;
use super::glob::{build_glob_set, expand_braces};
use super::process_file_lock::ProcessFileLocks;
use super::{ToolError, ToolHandle, ToolOk};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::future::Future;
use std::io::{BufRead, BufReader, Read, Seek};
use std::path::{Component, Path, PathBuf};
use tokio_util::sync::CancellationToken;

const DEFAULT_IMAGE_INPUT_BYTES: u64 = 10 * 1024 * 1024;
const HARD_CAP_IMAGE_INPUT_BYTES: u64 = 50 * 1024 * 1024;
const MAX_DELIVERY_IMAGE_COUNT: usize = 20;
pub(crate) const FILESYSTEM_BATCH_MAX_ENTRIES: usize = 20;
const MAX_ANALYSIS_IMAGE_COUNT: usize = 10;
const MAX_IMAGE_PIXELS: u64 = 100_000_000;
const MAX_IMAGE_DIMENSION: u32 = 16_384;
const MAX_ANALYSIS_ENCODED_BYTES: u64 = 5 * 1024 * 1024;
const MAX_VISION_RESPONSE_BYTES: usize = 1024 * 1024;
const MAX_VISION_ERROR_BODY_BYTES: usize = 16 * 1024;
const MAX_VISION_DESCRIPTION_BYTES: usize = 64 * 1024;
const DEFAULT_READ_BYTES: u64 = 1024 * 1024;
const HARD_CAP_READ_BYTES: u64 = 32 * 1024 * 1024;
const MAX_WRITE_TARGET_BYTES: usize = 32 * 1024 * 1024;
const MAX_WRITE_REQUEST_BYTES: usize = 64 * 1024 * 1024;
/// Ranged reads from BOM-marked UTF-16 sources buffer the whole file to
/// transcode it (byte-level line scanning would split on the high half
/// of a character). This bounds that buffering. UTF-8 sources keep
/// streaming regardless of size.
const UTF16_RANGED_BUFFER_LIMIT: u64 = 64 * 1024 * 1024;
const DEFAULT_LIST_ENTRIES: u32 = 1000;
const HARD_CAP_LIST_ENTRIES: u32 = 5000;

pub(crate) fn enforce_filesystem_batch_limit(
    tool_name: &str,
    field: &str,
    count: usize,
) -> Result<(), ToolError> {
    if count > FILESYSTEM_BATCH_MAX_ENTRIES {
        return Err(ToolError::TooLarge(format!(
            "{} contains {} entries. {} accepts at most {} entries per call. Retry by splitting {} into batches of {} or fewer entries.",
            field,
            count,
            tool_name,
            FILESYSTEM_BATCH_MAX_ENTRIES,
            field,
            FILESYSTEM_BATCH_MAX_ENTRIES,
        )));
    }
    Ok(())
}
const MAX_STAT_PATHS: usize = 100;

/* ------------------------------------------------------------------ */
/*  Path sandbox helpers                                                 */
/* ------------------------------------------------------------------ */

/// Strip the Windows extended-length / UNC prefix that
/// `std::fs::canonicalize` prepends. Two flavors to handle:
///   - local extended paths: `\\?\C:\Users\me\file.txt` → `C:\Users\me\file.txt`
///   - UNC extended paths:   `\\?\UNC\host\share\dir`   → `\\host\share\dir`
///
/// Without this, a canonicalized path would never `starts_with` an
/// allowed root stored as a plain path — even though the OS treats
/// them as the same path. No-op on non-Windows.
fn strip_unc(p: &Path) -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        let s = p.to_string_lossy();
        if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
            // `\\?\UNC\host\share\...` → `\\host\share\...`
            return PathBuf::from(format!(r"\\{}", rest));
        }
        if let Some(rest) = s.strip_prefix(r"\\?\") {
            // `\\?\C:\...` → `C:\...`
            return PathBuf::from(rest);
        }
    }
    p.to_path_buf()
}

/// Component-wise, case-insensitive containment check.
///
/// SECURITY-CRITICAL (Gemini v2 §2 finding): the previous Windows
/// implementation used string `starts_with` on lowercased paths. That
/// is vulnerable to *path-prefix collision*: with allowed_root
/// `C:\Users\me\projects`, a string-prefix check on
/// `C:\Users\me\projects-secret\passwords.txt` would return **true**
/// even though `projects-secret` is a sibling directory, not a child
/// of `projects`. The model could read/write sibling folders it was
/// never authorized for.
///
/// `Path::starts_with` is component-aware — it splits on path
/// separators and compares component lists. By lowercasing the
/// string *and then re-parsing it into a PathBuf*, we keep component
/// semantics while getting case insensitivity. The sibling-folder
/// attack fails: `c:/users/me/projects-secret` is one component
/// (`projects-secret`), not a child of `c:/users/me/projects` (whose
/// last component is `projects`). Structural mismatch →
/// `starts_with` returns `false`.
fn path_starts_with_ci(a: &Path, b: &Path) -> bool {
    #[cfg(target_os = "windows")]
    {
        let al = PathBuf::from(a.to_string_lossy().to_lowercase());
        let bl = PathBuf::from(b.to_string_lossy().to_lowercase());
        al.starts_with(&bl)
    }
    #[cfg(not(target_os = "windows"))]
    {
        // Non-Windows: paths are case-sensitive. No transform needed.
        // `Path::starts_with` is component-aware natively.
        a.starts_with(b)
    }
}

/// Clean a user-supplied path by stripping whitespace adjacent to
/// path separators.  LLMs sometimes hallucinate spaces around `\\`
/// or `/` (e.g. `"C:\\temp\\what \\file.png"`).  This is the Rust
/// counterpart of the JS-side `sanitizePathSepWhitespace` in `pathSanitize.ts`.
///
/// Single-pass, no regex — O(n) with minimal allocations.
fn clean_path(raw: &str) -> String {
    let trimmed = raw.trim();
    let mut out = String::with_capacity(trimmed.len());
    let mut prev_sep = false;
    for ch in trimmed.chars() {
        if ch == '\\' || ch == '/' {
            // Drop whitespace between the last non-whitespace char
            // and this separator:  `what \\file` → `what\\file`
            while out.ends_with(|c: char| c.is_whitespace()) {
                out.pop();
            }
            out.push(ch);
            prev_sep = true;
        } else if prev_sep && ch.is_whitespace() {
            // Drop whitespace immediately after a separator:
            // `what\\ file` → `what\\file`
            continue;
        } else {
            out.push(ch);
            prev_sep = false;
        }
    }
    out
}

/// Resolve `raw` against the allowed roots. Returns the canonicalized
/// path if it's inside one of the roots, else `PathOutsideRoots`.
///
/// **Two cases:**
/// 1. `raw` exists: canonicalize resolves symlinks and `..`, then
///    the containment check fires against the canonical path.
///    `NotFound` only fires if even the deepest existing ancestor
///    isn't inside any root (i.e. the parent chain doesn't reach a
///    root).
/// 2. `raw` does not exist (about to be created): canonicalize the
///    deepest existing ancestor and run the containment check on
///    it. The returned path is the canonical ancestor + the missing
///    tail components. This is what makes `tool_write_file` with
///    `mode='create'` work — the file doesn't exist yet, but we
///    still need to verify its *parent* lives inside an allowed root.
///
/// Symlinks are followed (canonicalize resolves them), so a symlink
/// inside root pointing outside root is correctly rejected.
///
/// **Roots that don't yet exist** (the user pre-declared a folder
/// that hasn't been created) are handled by falling back to a
/// non-canonicalized prefix check — the symlink resolution is lost
/// in that edge case but the structural containment check still
/// works for honest input.
///
/// Before resolving, whitespace adjacent to path separators is
/// collapsed (models sometimes insert stray spaces, e.g.
/// `"C:\\temp\\what \\file.png"` → `"C:\\temp\\what\\file.png"`).
fn normalize_lexical(path: &Path, raw: &str) -> Result<PathBuf, ToolError> {
    let mut normalized = PathBuf::new();
    let mut normal_depth = 0usize;
    for component in path.components() {
        match component {
            Component::Prefix(_) | Component::RootDir => normalized.push(component.as_os_str()),
            Component::CurDir => {}
            Component::Normal(part) => {
                normalized.push(part);
                normal_depth += 1;
            }
            Component::ParentDir => {
                if normal_depth == 0 {
                    return Err(ToolError::NotFound(raw.to_string()));
                }
                normalized.pop();
                normal_depth -= 1;
            }
        }
    }
    Ok(normalized)
}

pub(crate) fn canonicalize_allow_missing(raw: &str) -> Result<PathBuf, ToolError> {
    let cleaned = clean_path(raw);
    let p = normalize_lexical(Path::new(&cleaned), raw)?;
    let mut current: PathBuf = p.clone();
    let mut suffix: PathBuf = PathBuf::new();
    let canon = loop {
        match std::fs::canonicalize(&current) {
            Ok(c) => break strip_unc(&c),
            Err(_) => {
                let Some(parent) = current.parent() else {
                    return Err(ToolError::NotFound(raw.to_string()));
                };
                let Some(name) = current.file_name() else {
                    return Err(ToolError::NotFound(raw.to_string()));
                };
                // Prepend `name` to whatever suffix we already have.
                if suffix.as_os_str().is_empty() {
                    suffix = PathBuf::from(name);
                } else {
                    suffix = PathBuf::from(name).join(&suffix);
                }
                current = parent.to_path_buf();
            }
        }
    };

    Ok(if suffix.as_os_str().is_empty() {
        canon
    } else {
        canon.join(suffix)
    })
}

pub fn resolve_under_roots(raw: &str, roots: &[PathBuf]) -> Result<PathBuf, ToolError> {
    // Collapse whitespace around path separators — the JS-side
    // sanitizePathSepWhitespace does this too, but defense-in-depth on the Rust
    // side guarantees we never pass a malformed path to the OS.
    let canon = canonicalize_allow_missing(raw)?;
    let stripped_roots: Vec<PathBuf> = roots
        .iter()
        .map(|r| {
            std::fs::canonicalize(r)
                .map(|p| strip_unc(&p))
                .unwrap_or_else(|_| strip_unc(r))
        })
        .collect();

    if !stripped_roots
        .iter()
        .any(|r| path_starts_with_ci(&canon, r))
    {
        // Include actionable context so the model can correct the request
        // instead of just the rejected path. Without the allowed
        // roots list, models tend to loop guessing (the same turn
        // can rack up 7-10 tool calls all hitting this branch).
        let allowed_roots = stripped_roots
            .iter()
            .map(|r| r.to_string_lossy().to_string())
            .collect::<Vec<_>>();
        return Err(ToolError::PathOutsideRoots {
            path: raw.to_string(),
            allowed_roots,
        });
    }
    Ok(canon)
}

/// Merge per-conversation roots from the JS side. No implicit
/// default — every root must be explicitly granted by the user
/// via the Workspace panel or the permission popup.
pub(crate) fn merged_roots(user_roots: &[String]) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    for r in user_roots {
        let p = PathBuf::from(r);
        if !roots.contains(&p) {
            roots.push(p);
        }
    }
    roots
}

/// Build the full API URL from a base URL and an endpoint path.
/// The base URL is used as-is — users are expected to include any
/// version prefix themselves (e.g. /v1, /v4, /api/paas/v4).
pub(super) fn build_api_url(server_url: &str, endpoint: &str) -> String {
    format!("{}/{}", server_url.trim_end_matches('/'), endpoint)
}

/* ------------------------------------------------------------------ */
/*  Tauri command: tool_read_file (Phase 2.1b — real impl)               */
/* ------------------------------------------------------------------ */

#[derive(Debug, Deserialize, Default)]
pub struct ReadFileRequest {
    pub paths: Vec<String>,
    pub start_line: Option<u32>,
    pub end_line: Option<u32>,
    pub max_bytes: Option<u64>,
    pub allowed_roots: Option<Vec<String>>,
    pub call_id: Option<String>,
    pub group_id: Option<String>,
}

/// Bytes examined when deciding whether content is text.
///
/// Every tool that reads file content uses this one window. Two tools
/// that sniff different amounts would call the same file text and
/// binary, which is the defect class this constant exists to prevent.
pub const TEXT_SNIFF_BYTES: usize = 8_192;

/// Why content is not editable, searchable text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotText {
    /// A NUL byte inside the sniff window. Real binary, and also UTF-16
    /// without a byte-order mark — with a mark the reader transcodes it
    /// instead (`read_text`); without one, UTF-16 cannot be told apart
    /// from binary with certainty.
    Binary,
    /// Not valid UTF-8 with no transcodable byte-order mark, or a malformed
    /// UTF-16 stream behind a mark. Latin-1 and friends land here. A lossy
    /// decode would hand back content whose bytes no longer match the file.
    NotUtf8,
}

impl NotText {
    pub fn code(self) -> &'static str {
        match self {
            NotText::Binary => "binary_detected",
            NotText::NotUtf8 => "encoding_not_utf8",
        }
    }

    /// A factual diagnostic for the native error entry. TypeScript owns
    /// the model-facing recovery action in the typed guidance catalog.
    pub fn remedy(self) -> &'static str {
        // `concat!` rather than a line continuation: a continuation that
        // loses its backslash silently becomes a run of spaces in the
        // middle of a model-facing sentence.
        match self {
            NotText::Binary => concat!(
                "binary_detected: the first 8 KiB contain a NUL byte. ",
                "UTF-16 without a byte-order mark lands here too (with a ",
                "mark it is transcoded). Use lc_read_image for an image, or ",
                "convert the file to UTF-8 first.",
            ),
            NotText::NotUtf8 => concat!(
                "encoding_not_utf8: LC cannot return this content without changing bytes. ",
                "The file has invalid UTF-8 without a transcodable byte-order mark, ",
                "or malformed UTF-16 behind one. ",
                "LC has no conversion tool. Ask the user to convert the file to UTF-8.",
            ),
        }
    }
}

/// The single text-admission policy, shared by `lc_read_file`,
/// `lc_edit_file`, and `lc_apply_patch`. Those three return content, or
/// write it, so returning bytes that do not match the file would let a
/// caller launder a lossy copy back over the original.
///
/// **`lc_grep` deliberately does not use this.** It shares
/// `TEXT_SNIFF_BYTES` and applies the identical NUL rule, so no file is
/// binary to one tool and text to another. For invalid UTF-8 it stays
/// permissive: a threshold heuristic rather than strict validity, so one
/// Latin-1 byte in a comment does not remove a whole source file from
/// search. Grep is read-only and returns single lines, so a match
/// containing a replacement character is a far weaker hazard than a
/// whole-file copy. That difference is documented in grep's own
/// description.
pub fn classify_text(bytes: &[u8]) -> Option<NotText> {
    let window = &bytes[..bytes.len().min(TEXT_SNIFF_BYTES)];
    if window.contains(&0u8) {
        return Some(NotText::Binary);
    }
    if std::str::from_utf8(bytes).is_err() {
        return Some(NotText::NotUtf8);
    }
    None
}

/// Which UTF-16 byte order a mark announced.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Utf16Kind {
    Le,
    Be,
}

impl Utf16Kind {
    pub fn label(self) -> &'static str {
        match self {
            Utf16Kind::Le => "utf-16le",
            Utf16Kind::Be => "utf-16be",
        }
    }
}

/// Sniff a UTF-16 byte-order mark. UTF-32 marks merely start like
/// UTF-16 ones (`FF FE 00 00`, `00 00 FE FF`), so they return `None`
/// and later fail the NUL rule as binary — honest, since there is no
/// UTF-32 transcoder.
/// The byte-order mark of a file already on disk, if it has one.
///
/// Reads only the first four bytes. A path that does not exist, or
/// cannot be opened, has no mark to report — `create` mode and a
/// missing target both land here and are not this check's business.
fn existing_utf16_bom(path: &Path) -> Option<Utf16Kind> {
    use std::io::Read;
    let mut head = [0u8; 4];
    let mut file = std::fs::File::open(path).ok()?;
    let read = file.read(&mut head).ok()?;
    utf16_bom(&head[..read])
}

/// UTF-16LE bytes with a byte-order mark, for tests in sibling tool
/// modules that need a marked source without duplicating the encoder.
#[cfg(test)]
pub fn utf16_bytes_for_test(text: &str) -> Vec<u8> {
    let mut bytes = vec![0xFF, 0xFE];
    for unit in text.encode_utf16() {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    bytes
}

pub fn utf16_bom(bytes: &[u8]) -> Option<Utf16Kind> {
    match bytes {
        [0xFF, 0xFE, 0x00, 0x00, ..] | [0x00, 0x00, 0xFE, 0xFF, ..] => None,
        [0xFF, 0xFE, ..] => Some(Utf16Kind::Le),
        [0xFE, 0xFF, ..] => Some(Utf16Kind::Be),
        _ => None,
    }
}

/// Decode a UTF-16 payload with the mark already stripped. `None` on an
/// odd trailing byte or an unpaired surrogate: the stream is malformed,
/// and patching it silently in place is how corrupt copies get written
/// back over good files.
pub(crate) fn decode_utf16(payload: &[u8], kind: Utf16Kind) -> Option<String> {
    match kind {
        Utf16Kind::Le => String::from_utf16le(payload).ok(),
        Utf16Kind::Be => String::from_utf16be(payload).ok(),
    }
}

/// How `read_text` produced its text. `Transcoded` files are not UTF-8
/// on disk; writing the returned text back would re-encode them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextOrigin {
    Utf8,
    Transcoded(Utf16Kind),
}

impl TextOrigin {
    pub fn label(self) -> &'static str {
        match self {
            TextOrigin::Utf8 => "utf-8",
            TextOrigin::Transcoded(kind) => kind.label(),
        }
    }
}

/// Read file bytes under the strict text policy. BOM-marked UTF-16 is
/// transcoded; everything else follows `classify_text` exactly.
/// `lc_read_file` uses this. `lc_grep` shares the BOM decoder and NUL window,
/// but permits other invalid UTF-8 because it returns only matching lines.
/// Mutating tools (`lc_edit_file`, `lc_apply_patch`) must NOT transcode:
/// saving their output would silently re-encode the file, so they keep
/// refusing with `classify_text` plus a BOM-specific message.
pub fn read_text(bytes: &[u8]) -> Result<(String, TextOrigin), NotText> {
    if let Some(kind) = utf16_bom(bytes) {
        return decode_utf16(&bytes[2..], kind)
            .map(|text| (text, TextOrigin::Transcoded(kind)))
            .ok_or(NotText::NotUtf8);
    }
    match classify_text(bytes) {
        Some(reason) => Err(reason),
        None => Ok((
            String::from_utf8(bytes.to_vec()).expect("classify_text proved valid UTF-8"),
            TextOrigin::Utf8,
        )),
    }
}

fn effective_read_limit(requested: Option<u64>) -> u64 {
    requested
        .unwrap_or(DEFAULT_READ_BYTES)
        .min(HARD_CAP_READ_BYTES)
}

#[tauri::command]
pub async fn tool_read_file(req: ReadFileRequest) -> Result<ToolOk, ToolError> {
    enforce_filesystem_batch_limit("lc_read_file", "paths", req.paths.len())?;
    let cancel_token = CancellationToken::new();
    let _guard = req.call_id.as_ref().map(|call_id| {
        super::registry::register_with_group(
            call_id.clone(),
            ToolHandle(cancel_token.clone()),
            req.group_id.clone(),
        )
    });
    let worker_token = cancel_token.clone();
    tokio::task::spawn_blocking(move || {
        let roots = merged_roots(req.allowed_roots.as_deref().unwrap_or(&[]));
        let mut results: Vec<serde_json::Value> = Vec::with_capacity(req.paths.len());

        for path in &req.paths {
            if worker_token.is_cancelled() {
                return Err(ToolError::Aborted);
            }
            let entry = read_single_file_cancellable(
                path,
                &roots,
                req.start_line,
                req.end_line,
                req.max_bytes,
                Some(&worker_token),
            );
            results.push(entry);
        }
        if worker_token.is_cancelled() {
            return Err(ToolError::Aborted);
        }

        Ok(serde_json::json!({ "results": results }))
    })
    .await
    .map_err(|e| ToolError::Io(format!("task join failed: {}", e)))?
}

#[cfg(test)]
fn read_single_file(
    path: &str,
    roots: &[PathBuf],
    start_line: Option<u32>,
    end_line: Option<u32>,
    max_bytes: Option<u64>,
) -> serde_json::Value {
    read_single_file_cancellable(path, roots, start_line, end_line, max_bytes, None)
}

fn read_cancellable(
    mut reader: impl Read,
    max_bytes: u64,
    cancel_token: Option<&CancellationToken>,
    mut after_chunk: impl FnMut(),
) -> std::io::Result<Vec<u8>> {
    let mut output = Vec::with_capacity(max_bytes.min(64 * 1024) as usize);
    let mut chunk = [0u8; 64 * 1024];
    while (output.len() as u64) < max_bytes {
        if cancel_token.is_some_and(CancellationToken::is_cancelled) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::Interrupted,
                "read cancelled",
            ));
        }
        let remaining = max_bytes.saturating_sub(output.len() as u64) as usize;
        let chunk_len = chunk.len();
        let read = reader.read(&mut chunk[..remaining.min(chunk_len)])?;
        if read == 0 {
            break;
        }
        output.extend_from_slice(&chunk[..read]);
        after_chunk();
    }
    Ok(output)
}

#[cfg(test)]
fn read_chunk_checkpoint_key(path: &Path) -> String {
    format!("native-read-chunk:{}", path.to_string_lossy())
}

fn read_single_file_cancellable(
    path: &str,
    roots: &[PathBuf],
    start_line: Option<u32>,
    end_line: Option<u32>,
    max_bytes: Option<u64>,
    cancel_token: Option<&CancellationToken>,
) -> serde_json::Value {
    if cancel_token.is_some_and(CancellationToken::is_cancelled) {
        return err_entry_with_code(path, "aborted", "read cancelled");
    }
    let canon = match resolve_under_roots(path, roots) {
        Ok(c) => c,
        Err(e) => return err_entry(path, &e.to_string()),
    };

    let meta = match std::fs::metadata(&canon) {
        Ok(m) => m,
        Err(e) => return err_entry(path, &e.to_string()),
    };
    if !meta.is_file() {
        return err_entry(path, "not a file");
    }

    let cap = effective_read_limit(max_bytes);
    let size_bytes = meta.len();

    let start = start_line.unwrap_or(1).max(1) as usize;
    let end_opt = end_line.map(|e| e as usize);

    // Reject invalid ranges before opening or reading the file.
    if let Some(end) = end_opt {
        if start > end {
            return err_entry(
                path,
                &format!(
                    "start_line ({}) > end_line ({}) — swap them or omit end_line",
                    start, end,
                ),
            );
        }
    }

    // A focused range can be read from a file larger than the normal
    // in-memory cap. The ranged implementation streams the source,
    // hashes it, and applies the cap to the selected content instead of
    // rejecting the whole source file before the range is considered.
    let has_range = start > 1 || end_opt.is_some();
    if has_range && size_bytes > cap {
        return read_ranged_file(&canon, path, size_bytes, cap, start, end_opt, cancel_token);
    }

    if size_bytes > cap {
        return err_entry_with_code(
            path,
            "too_large",
            &format!("{} bytes > max {} bytes", size_bytes, cap),
        );
    }

    let file = match std::fs::File::open(&canon) {
        Ok(f) => f,
        Err(e) => return err_entry(path, &e.to_string()),
    };
    let buf = match read_cancellable(file, cap.saturating_add(1), cancel_token, || {
        #[cfg(test)]
        super::registry::test_support::hit(&read_chunk_checkpoint_key(&canon));
    }) {
        Ok(buf) => buf,
        Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {
            return err_entry_with_code(path, "aborted", "read cancelled")
        }
        Err(error) => return err_entry(path, &error.to_string()),
    };
    if buf.len() as u64 > cap {
        return err_entry_with_code(
            path,
            "too_large",
            &format!("file grew beyond max {} bytes while it was read", cap),
        );
    }

    let (full_text, origin) = match read_text(&buf) {
        Ok((text, origin)) => (text, origin),
        Err(reason) => return err_entry_with_code(path, reason.code(), reason.remedy()),
    };

    // SHA-256 of the raw file bytes, transcoding included: the hash
    // describes the file as it is on disk, not LC's decoded copy of it,
    // and callers pass it back as `expected_sha256`.
    let sha256 = {
        let mut hasher = Sha256::new();
        hasher.update(&buf);
        hasher
            .finalize()
            .iter()
            .map(|b| format!("{:02x}", b))
            .collect::<String>()
    };

    let total_lines = full_text.lines().count() as u64;

    let content = if start <= 1 && end_opt.is_none() {
        full_text
    } else {
        full_text
            .lines()
            .enumerate()
            .filter(|(i, _)| {
                let one_based = *i + 1;
                one_based >= start && end_opt.is_none_or(|e| one_based <= e)
            })
            .map(|(_, line)| line)
            .collect::<Vec<_>>()
            .join("\n")
    };

    serde_json::json!({
        "path": path,
        "content": content,
        "total_lines": total_lines,
        "size_bytes": size_bytes,
        "truncated": false,
        "sha256": sha256,
        "encoding": origin.label(),
    })
}

/// Read a selected line range without buffering the whole source file.
///
/// The returned metadata still describes the complete file: `size_bytes`,
/// `total_lines`, and `sha256` are computed while streaming through it. The
/// byte cap applies to the selected content, so a focused range can be read
/// from a source file larger than the normal full-read cap without allowing
/// an unbounded result into the model context.
///
/// UTF-16 sources are the exception: line boundaries cannot be found by
/// scanning raw bytes (a `0A` can be the high half of a character), so a
/// marked file is transcoded in memory first, bounded by
/// `UTF16_RANGED_BUFFER_LIMIT`.
fn read_ranged_file(
    canon: &Path,
    path: &str,
    size_bytes: u64,
    cap: u64,
    start: usize,
    end_opt: Option<usize>,
    cancel_token: Option<&CancellationToken>,
) -> serde_json::Value {
    let mut file = match std::fs::File::open(canon) {
        Ok(f) => f,
        Err(e) => return err_entry(path, &e.to_string()),
    };

    // Probe the first bytes for a UTF-16 mark, then rewind.
    let mut probe = [0u8; 4];
    let probed = std::io::Read::read(&mut file, &mut probe).unwrap_or(0);
    let utf16 = utf16_bom(&probe[..probed]);
    if let Some(kind) = utf16 {
        return read_ranged_utf16(
            file,
            path,
            size_bytes,
            cap,
            start,
            end_opt,
            kind,
            cancel_token,
        );
    }
    if let Err(e) = file.seek(std::io::SeekFrom::Start(0)) {
        return err_entry(path, &e.to_string());
    }

    let mut reader = BufReader::new(file);
    let mut hasher = Sha256::new();
    let mut total_lines = 0u64;
    let mut selected = Vec::new();
    let mut binary_detected = false;
    let mut not_utf8 = false;
    let mut sniffed_bytes = 0usize;
    let cap_usize = cap.min(usize::MAX as u64) as usize;
    let mut utf8_tail = Vec::with_capacity(3);
    let mut selected_any = false;
    let mut current_line_has_bytes = false;
    let mut selected_line_started = false;

    loop {
        if cancel_token.is_some_and(CancellationToken::is_cancelled) {
            return err_entry_with_code(path, "aborted", "read cancelled");
        }
        let available = match reader.fill_buf() {
            Ok(bytes) => bytes,
            Err(error) => return err_entry(path, &error.to_string()),
        };
        if available.is_empty() {
            break;
        }
        let take = available
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(available.len(), |index| index + 1);
        let chunk = &available[..take];
        let ends_line = chunk.last() == Some(&b'\n');

        hasher.update(chunk);
        if sniffed_bytes < TEXT_SNIFF_BYTES {
            let sniff = (TEXT_SNIFF_BYTES - sniffed_bytes).min(chunk.len());
            binary_detected |= chunk[..sniff].contains(&0);
            sniffed_bytes += sniff;
        }
        if !not_utf8 {
            utf8_tail.extend_from_slice(chunk);
            match std::str::from_utf8(&utf8_tail) {
                Ok(_) => utf8_tail.clear(),
                Err(error) if error.error_len().is_none() => {
                    let valid = error.valid_up_to();
                    utf8_tail.drain(..valid);
                    if utf8_tail.len() > 3 {
                        not_utf8 = true;
                    }
                }
                Err(_) => not_utf8 = true,
            }
        }

        let line_number = total_lines as usize + 1;
        let selected_line = line_number >= start && end_opt.is_none_or(|end| line_number <= end);
        if selected_line {
            if !selected_line_started {
                if selected_any {
                    selected.push(b'\n');
                }
                selected_any = true;
                selected_line_started = true;
            }
            let content = if ends_line {
                &chunk[..chunk.len().saturating_sub(1)]
            } else {
                chunk
            };
            selected.extend_from_slice(content);
            if ends_line && selected.last() == Some(&b'\r') {
                selected.pop();
            }
            if selected.len() > cap_usize {
                return err_entry_with_code(
                    path,
                    "too_large",
                    &format!(
                        "Selected line range exceeds max {} bytes. Narrow the range or increase max_bytes.",
                        cap
                    ),
                );
            }
        }
        current_line_has_bytes |= if ends_line {
            chunk.len() > 1
        } else {
            !chunk.is_empty()
        };
        if ends_line {
            total_lines += 1;
            current_line_has_bytes = false;
            selected_line_started = false;
        }
        reader.consume(take);
    }

    if current_line_has_bytes {
        total_lines += 1;
    }

    if binary_detected {
        return err_entry_with_code(path, NotText::Binary.code(), NotText::Binary.remedy());
    }
    if not_utf8 || !utf8_tail.is_empty() {
        return err_entry_with_code(path, NotText::NotUtf8.code(), NotText::NotUtf8.remedy());
    }

    let sha256 = hasher
        .finalize()
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect::<String>();
    let selected = String::from_utf8(selected)
        .expect("streaming UTF-8 validation accepted the selected bytes");

    serde_json::json!({
        "path": path,
        "content": selected,
        "total_lines": total_lines,
        "size_bytes": size_bytes,
        "truncated": false,
        "sha256": sha256,
        "encoding": "utf-8",
    })
}

/// Ranged read for a BOM-marked UTF-16 source: buffer (bounded), decode,
/// select lines from the transcoded text, hash the raw bytes.
fn read_ranged_utf16(
    mut file: std::fs::File,
    path: &str,
    size_bytes: u64,
    cap: u64,
    start: usize,
    end_opt: Option<usize>,
    kind: Utf16Kind,
    cancel_token: Option<&CancellationToken>,
) -> serde_json::Value {
    if size_bytes > UTF16_RANGED_BUFFER_LIMIT {
        return err_entry_with_code(
            path,
            "too_large",
            &format!(
                "UTF-16 source is {} bytes. Ranged reads from transcoded files are buffered in memory and limited to {} bytes. Convert the file to UTF-8 first.",
                size_bytes, UTF16_RANGED_BUFFER_LIMIT
            ),
        );
    }
    if let Err(e) = file.seek(std::io::SeekFrom::Start(0)) {
        return err_entry(path, &e.to_string());
    }
    let buf = match read_cancellable(
        file,
        UTF16_RANGED_BUFFER_LIMIT.saturating_add(1),
        cancel_token,
        || {},
    ) {
        Ok(buf) => buf,
        Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {
            return err_entry_with_code(path, "aborted", "read cancelled")
        }
        Err(error) => return err_entry(path, &error.to_string()),
    };
    if buf.len() as u64 > UTF16_RANGED_BUFFER_LIMIT {
        return err_entry_with_code(
            path,
            "too_large",
            "UTF-16 source grew beyond the 64 MiB ranged-read limit",
        );
    }
    let (full_text, origin) = match read_text(&buf) {
        Ok((text, origin)) => (text, origin),
        Err(reason) => return err_entry_with_code(path, reason.code(), reason.remedy()),
    };
    debug_assert_eq!(origin, TextOrigin::Transcoded(kind));

    let sha256 = {
        let mut hasher = Sha256::new();
        hasher.update(&buf);
        hasher
            .finalize()
            .iter()
            .map(|b| format!("{:02x}", b))
            .collect::<String>()
    };

    let total_lines = full_text.lines().count() as u64;
    let selected: Vec<&str> = full_text
        .lines()
        .enumerate()
        .filter(|(i, _)| {
            let one_based = *i + 1;
            one_based >= start && end_opt.is_none_or(|e| one_based <= e)
        })
        .map(|(_, line)| line)
        .collect();
    let selected_len: usize = selected
        .iter()
        .map(|line| line.len() + 1)
        .sum::<usize>()
        .saturating_sub(1);
    if selected_len as u64 > cap {
        return err_entry_with_code(
            path,
            "too_large",
            &format!(
                "Selected line range exceeds max {} bytes. Narrow the range or increase max_bytes.",
                cap
            ),
        );
    }

    serde_json::json!({
        "path": path,
        "content": selected.join("\n"),
        "total_lines": total_lines,
        "size_bytes": size_bytes,
        "truncated": false,
        "sha256": sha256,
        "encoding": origin.label(),
    })
}

fn err_entry(path: &str, msg: &str) -> serde_json::Value {
    err_entry_with_code(path, "read_failed", msg)
}

fn err_entry_with_code(path: &str, code: &str, msg: &str) -> serde_json::Value {
    serde_json::json!({
        "path": path,
        "error_code": code,
        "error": msg,
        "content": "",
        "total_lines": 0,
        "size_bytes": 0,
        "truncated": false,
    })
}

/// Error entry for `tool_list_dir`. Carries the tool's own declared result
/// shape - `entries` present and empty - rather than read_file's error
/// fields, so every entry a caller receives has the same keys.
fn list_err_entry(path: &str, msg: &str) -> serde_json::Value {
    serde_json::json!({
        "path": path,
        "error": msg,
        "entries": [],
        "truncated": false,
    })
}

/* ------------------------------------------------------------------ */
/*  Tauri commands: write_file, list_dir                                 */
/* ------------------------------------------------------------------ */

#[derive(Debug, Deserialize)]
pub struct WriteFileEntry {
    pub path: String,
    pub content: String,
    /// Optional expected SHA-256 of the current file content.
    /// When provided, write is rejected if the file's current hash
    /// doesn't match (optimistic concurrency control).
    #[serde(default)]
    pub expected_sha256: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct WriteFileRequest {
    pub files: Vec<WriteFileEntry>,
    pub mode: Option<String>,
    pub allowed_roots: Option<Vec<String>>,
}

fn enforce_write_request_limits(files: &[WriteFileEntry]) -> Result<(), ToolError> {
    let mut total = 0usize;
    for file in files {
        let bytes = file.content.len();
        if bytes > MAX_WRITE_TARGET_BYTES {
            return Err(ToolError::TooLarge(format!(
                "write content for '{}' is {} bytes. The per-file limit is {} bytes.",
                file.path, bytes, MAX_WRITE_TARGET_BYTES
            )));
        }
        total = total.saturating_add(bytes);
        if total > MAX_WRITE_REQUEST_BYTES {
            return Err(ToolError::TooLarge(format!(
                "write content is {} bytes in total. The per-call limit is {} bytes.",
                total, MAX_WRITE_REQUEST_BYTES
            )));
        }
    }
    Ok(())
}

/// Count logical UTF-8 text lines for the file-change summary. A trailing
/// newline terminates the preceding line; it does not create an extra line.
fn count_text_lines(content: &str) -> usize {
    content.lines().count()
}

/// Largest existing file scanned to populate the `lines_removed` summary
/// field. Streaming makes the scan O(1) in memory but it is still O(n) in
/// I/O, and the value is informational only — past this size the field is
/// omitted rather than paying to compute it.
const MAX_LINE_COUNT_SCAN_BYTES: u64 = 32 * 1024 * 1024;

/// Size of the reusable buffer for the streaming file scans below.
const STREAM_CHUNK_BYTES: usize = 64 * 1024;

/// Count logical text lines without holding the file in memory.
///
/// Matches `count_text_lines` semantics: a trailing newline terminates the
/// preceding line rather than starting a new one. Returns `None` when the file
/// is too large to be worth scanning or cannot be read — callers omit the
/// field rather than reporting a count they did not measure.
fn count_file_lines_streaming(path: &Path, size_bytes: u64) -> Option<usize> {
    if size_bytes > MAX_LINE_COUNT_SCAN_BYTES {
        return None;
    }
    let file = std::fs::File::open(path).ok()?;
    let mut reader = BufReader::with_capacity(STREAM_CHUNK_BYTES, file);
    let mut lines = 0usize;
    let mut last_byte = None;
    loop {
        let (consumed, newlines, last) = {
            let chunk = reader.fill_buf().ok()?;
            if chunk.is_empty() {
                break;
            }
            (
                chunk.len(),
                chunk.iter().filter(|&&b| b == b'\n').count(),
                chunk.last().copied(),
            )
        };
        lines += newlines;
        last_byte = last;
        reader.consume(consumed);
    }
    match last_byte {
        None => Some(0),
        Some(b'\n') => Some(lines),
        Some(_) => Some(lines + 1),
    }
}

/// SHA-256 of a file's raw bytes, streamed in fixed-size chunks.
///
/// Produces the same digest `tool_read_file` reports, so a hash the model
/// received from a read compares equal here. Streaming keeps the check usable
/// on files far larger than the read cap without buffering them.
fn hash_file_streaming(path: &Path) -> std::io::Result<String> {
    let file = std::fs::File::open(path)?;
    let mut reader = BufReader::with_capacity(STREAM_CHUNK_BYTES, file);
    let mut hasher = Sha256::new();
    loop {
        let consumed = {
            let chunk = reader.fill_buf()?;
            if chunk.is_empty() {
                break;
            }
            hasher.update(chunk);
            chunk.len()
        };
        reader.consume(consumed);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect())
}

#[derive(Debug, Deserialize)]
pub struct ListDirRequest {
    pub paths: Vec<String>,
    pub pattern: Option<String>,
    pub include_hidden: Option<bool>,
    pub max_entries: Option<u32>,
    pub allowed_roots: Option<Vec<String>>,
}

fn effective_list_limit(requested: Option<u32>) -> u32 {
    requested
        .unwrap_or(DEFAULT_LIST_ENTRIES)
        .min(HARD_CAP_LIST_ENTRIES)
}

#[tauri::command]
pub async fn tool_list_dir(req: ListDirRequest) -> Result<ToolOk, ToolError> {
    enforce_filesystem_batch_limit("lc_list_dir", "paths", req.paths.len())?;
    tokio::task::spawn_blocking(move || {
        let roots = merged_roots(req.allowed_roots.as_deref().unwrap_or(&[]));
        // The pattern is call-wide, so it is compiled once. An invalid
        // pattern fails the whole call rather than silently matching
        // nothing. Matched against the entry basename only — the same
        // convention `ls *.ts` follows.
        let pattern_set = req
            .pattern
            .as_deref()
            .filter(|pattern| !pattern.trim().is_empty())
            .map(|pattern| build_glob_set(&expand_braces(pattern)))
            .transpose()?;
        let mut results: Vec<serde_json::Value> = Vec::with_capacity(req.paths.len());

        for path in &req.paths {
            let entry = list_single_dir(
                path,
                &roots,
                pattern_set.as_ref(),
                req.include_hidden,
                req.max_entries,
            );
            results.push(entry);
        }

        Ok(serde_json::json!({ "results": results }))
    })
    .await
    .map_err(|e| ToolError::Io(format!("task join failed: {}", e)))?
}

fn list_single_dir(
    path: &str,
    roots: &[PathBuf],
    pattern: Option<&globset::GlobSet>,
    include_hidden: Option<bool>,
    max_entries: Option<u32>,
) -> serde_json::Value {
    let include_hidden = include_hidden.unwrap_or(false);
    let max_entries = effective_list_limit(max_entries);

    let canon = match resolve_under_roots(path, roots) {
        Ok(c) => c,
        Err(e) => return list_err_entry(path, &e.to_string()),
    };

    let meta = match std::fs::metadata(&canon) {
        Ok(m) => m,
        Err(e) => return list_err_entry(path, &e.to_string()),
    };
    if !meta.is_dir() {
        return list_err_entry(path, "not a directory");
    }

    let mut entries: Vec<serde_json::Value> = Vec::new();
    let mut truncated = false;

    let read = match std::fs::read_dir(&canon) {
        Ok(r) => r,
        Err(e) => return list_err_entry(path, &e.to_string()),
    };
    for entry in read {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let name = entry.file_name().to_string_lossy().into_owned();

        if !include_hidden && name.starts_with('.') {
            continue;
        }

        if let Some(pat) = pattern {
            if !pat.is_match(&name) {
                continue;
            }
        }

        let entry_meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let kind = if entry_meta.is_symlink() {
            "symlink"
        } else if entry_meta.is_dir() {
            "dir"
        } else if entry_meta.is_file() {
            "file"
        } else {
            "other"
        };

        let mut obj = serde_json::json!({
            "name": name,
            "kind": kind,
        });
        if entry_meta.is_file() || entry_meta.is_symlink() {
            obj["size"] = serde_json::json!(entry_meta.len());
        }
        if let Ok(mtime) = entry_meta.modified() {
            if let Ok(dur) = mtime.duration_since(std::time::UNIX_EPOCH) {
                obj["mtime"] = serde_json::json!(dur.as_millis());
            }
        }
        if entries.len() as u32 >= max_entries {
            truncated = true;
            break;
        }
        entries.push(obj);
    }

    serde_json::json!({
        "path": path,
        "entries": entries,
        "truncated": truncated,
    })
}

#[derive(Debug, Deserialize)]
pub struct CheckPathRequest {
    pub path: String,
    #[serde(default)]
    pub allowed_roots: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
pub struct StatRequest {
    pub paths: Vec<String>,
    #[serde(default)]
    pub allowed_roots: Option<Vec<String>>,
}

/// Lightweight path validator used by the JS WorkspaceManager before
/// it adds a path to `allowed_roots`. Without this, pasting a string
/// like `D:\foo (not inside allowed roots: [...])` (e.g. an error
/// message) into the input would slip past the JS regex check (the
/// prefix matches `^[A-Za-z]:[\\/]`) and get added as a bogus root —
/// the Rust side then keeps rejecting the *real* path because the
/// trailing junk made it a different string. This command runs the
/// same canonicalize + metadata checks the real tool commands use,
/// so a non-existent path or non-directory is caught up front with a
/// clean error instead of slipping into the allowed-roots list.
///
/// Returns `{ exists: bool, is_dir: bool, canonical: string | null }`
/// so the JS side can show the user exactly what went wrong.
#[tauri::command]
pub fn tool_check_path(req: CheckPathRequest) -> Result<ToolOk, ToolError> {
    // If allowed_roots is provided, resolve the path under the sandbox.
    let p = if let Some(ref roots) = req.allowed_roots {
        let roots = merged_roots(roots);
        match resolve_under_roots(&req.path, &roots) {
            Ok(c) => c,
            Err(_) => {
                return Ok(serde_json::json!({
                    "exists": false,
                    "is_dir": false,
                    "canonical": null,
                    "size_bytes": null,
                    "mtime_ms": null,
                }));
            }
        }
    } else {
        PathBuf::from(&req.path)
    };
    let canon = match std::fs::canonicalize(&p) {
        Ok(c) => strip_unc(&c).to_string_lossy().to_string(),
        Err(_) => {
            return Ok(serde_json::json!({
                "exists": false,
                "is_dir": false,
                "canonical": null,
                "size_bytes": null,
                "mtime_ms": null,
            }));
        }
    };
    let meta = std::fs::metadata(&p).map_err(|e| ToolError::Io(e.to_string()))?;
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64);
    Ok(serde_json::json!({
        "exists": true,
        "is_dir": meta.is_dir(),
        "canonical": canon,
        "size_bytes": if meta.is_dir() { serde_json::Value::Null } else { serde_json::json!(meta.len()) },
        "mtime_ms": mtime_ms,
    }))
}

/// Return the OS-canonical identity used for permission admission.
/// Missing create targets are reconstructed from their nearest existing
/// canonical ancestor, matching `resolve_under_roots` execution behavior.
#[tauri::command]
pub fn tool_resolve_path(req: CheckPathRequest) -> Result<ToolOk, ToolError> {
    let cleaned = clean_path(&req.path);
    let input = PathBuf::from(&cleaned);
    if !input.is_absolute() {
        return Err(ToolError::NotFound(req.path));
    }
    let exists = input.exists();
    let canonical = canonicalize_allow_missing(&cleaned)?;
    Ok(serde_json::json!({
        "exists": exists,
        "is_dir": exists && canonical.is_dir(),
        "canonical": canonical.to_string_lossy(),
    }))
}

/// Batch stat command — processes multiple paths in a single IPC call.
/// Returns structured results including outside-root errors (distinct
/// from `exists: false` which means the path simply doesn't exist on disk).
/// Respects the same sandbox rules as `tool_check_path`.
#[tauri::command]
pub fn tool_stat(req: StatRequest) -> Result<ToolOk, ToolError> {
    if req.paths.len() > MAX_STAT_PATHS {
        return Err(ToolError::TooLarge(format!(
            "too many paths: {} requested, max {} (use multiple calls)",
            req.paths.len(),
            MAX_STAT_PATHS
        )));
    }
    let roots = req
        .allowed_roots
        .as_deref()
        .map(merged_roots)
        .unwrap_or_default();
    let results: Vec<serde_json::Value> = req
        .paths
        .iter()
        .map(|path| {
            let p = match resolve_under_roots(path, &roots) {
                Ok(c) => c,
                Err(e) => {
                    return serde_json::json!({
                        "path": path,
                        "exists": false,
                        "is_dir": false,
                        "is_file": false,
                        "canonical": null,
                        "size_bytes": null,
                        "mtime_ms": null,
                        "error": e.to_string(),
                    });
                }
            };
            let canon = match std::fs::canonicalize(&p) {
                Ok(c) => strip_unc(&c).to_string_lossy().to_string(),
                Err(_) => {
                    return serde_json::json!({
                        "path": path,
                        "exists": false,
                        "is_dir": false,
                        "is_file": false,
                        "canonical": null,
                        "size_bytes": null,
                        "mtime_ms": null,
                        "error": null,
                    });
                }
            };
            let meta = match std::fs::metadata(&p) {
                Ok(m) => m,
                Err(e) => {
                    return serde_json::json!({
                        "path": path,
                        "exists": false,
                        "is_dir": false,
                        "is_file": false,
                        "canonical": canon,
                        "size_bytes": null,
                        "mtime_ms": null,
                        "error": e.to_string(),
                    });
                }
            };
            let mtime_ms = meta.modified().ok().and_then(|t| {
                t.duration_since(std::time::UNIX_EPOCH).ok()
            }).map(|d| d.as_millis() as i64);
            serde_json::json!({
                "path": path,
                "exists": true,
                "is_dir": meta.is_dir(),
                "is_file": !meta.is_dir(),
                "canonical": canon,
                "size_bytes": if meta.is_dir() { serde_json::Value::Null } else { serde_json::json!(meta.len()) },
                "mtime_ms": mtime_ms,
                "error": null,
            })
        })
        .collect();
    Ok(serde_json::json!({ "results": results }))
}

#[tauri::command]
pub async fn tool_write_file(req: WriteFileRequest) -> Result<ToolOk, ToolError> {
    enforce_filesystem_batch_limit("lc_write_file", "files", req.files.len())?;
    enforce_write_request_limits(&req.files)?;
    tokio::task::spawn_blocking(move || {
    let roots = merged_roots(req.allowed_roots.as_deref().unwrap_or(&[]));
    let mode = req.mode.as_deref().unwrap_or("create");
    let mut results: Vec<serde_json::Value> = Vec::with_capacity(req.files.len());

    for file in &req.files {
        let canon = match resolve_under_roots(&file.path, &roots) {
            Ok(c) => c,
            Err(e) => {
                results.push(write_err_entry(&file.path, &e.to_string(), mode));
                continue;
            }
        };

        // Serialize with other LC executables before reading any state used to
        // decide or prepare this mutation. The JS lock only covers one process.
        let _process_lock = match ProcessFileLocks::acquire(std::slice::from_ref(&canon)) {
            Ok(lock) => lock,
            Err(error) => {
                results.push(write_err_entry(
                    &file.path,
                    &format!("could not acquire cross-process file lock: {}", error),
                    mode,
                ));
                continue;
            }
        };

        // `lc_read_file` transcodes BOM-marked UTF-16 so the caller can
        // read it. Writing that text back stores UTF-8 and silently
        // changes the file's encoding. `expected_sha256` cannot catch
        // it: the file has not changed, only the caller's copy of it
        // has. `lc_edit_file` and `lc_apply_patch` already refuse the
        // same shape, so refusing here keeps one rule across all three
        // writers instead of leaving this one advisory.
        if let Some(kind) = existing_utf16_bom(&canon) {
            results.push(write_err_entry(
                &file.path,
                &format!(
                    "file on disk is {} behind a byte-order mark: writing would store UTF-8 \
                     and change its encoding. Convert the file to UTF-8 first, then write.",
                    kind.label()
                ),
                mode,
            ));
            continue;
        }

        let bytes = file.content.as_bytes();
        // `lines_removed` is summary metadata only. Stream the count so a
        // large existing file is not pulled into memory just to populate one
        // integer in the response.
        let lines_before = match std::fs::metadata(&canon) {
            Ok(meta) if meta.is_file() => count_file_lines_streaming(&canon, meta.len()),
            _ => Some(0),
        };

        // If expected_sha256 is provided, verify current file content
        // matches before writing (optimistic concurrency control).
        if let Some(ref expected) = file
            .expected_sha256
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            if canon.exists() {
                // Fail closed: if the current content cannot be hashed, the
                // guarantee the caller asked for cannot be given, so the
                // write must not proceed.
                match hash_file_streaming(&canon) {
                    Ok(actual) => {
                        if !actual.eq_ignore_ascii_case(expected) {
                            results.push(serde_json::json!({
                                "path": file.path,
                                "error": format!(
                                    "expected_sha256 mismatch: expected {}, got {}. File was modified concurrently.",
                                    expected, actual
                                ),
                                "bytes_written": 0,
                                "mode": mode,
                                "lines_added": 0,
                                "lines_removed": 0,
                            }));
                            continue;
                        }
                    }
                    Err(e) => {
                        results.push(write_err_entry(
                            &file.path,
                            &format!(
                                "could not read current content to verify expected_sha256: {}",
                                e
                            ),
                            mode,
                        ));
                        continue;
                    }
                }
            } else if mode == "append" {
                // If file doesn't exist and expected_sha256 is given,
                // only allow if creating (mode=create or overwrite).
                results.push(write_err_entry(
                    &file.path,
                    "expected_sha256 provided but file does not exist",
                    mode,
                ));
                continue;
            }
        }

        let bytes_written = match mode {
            "create" => {
                // Phase 3.2: Restore the existence check — create mode
                // must fail if the file already exists (like create_new(true)).
                if canon.exists() {
                    results.push(serde_json::json!({
                        "path": file.path,
                        "error": format!("already exists: {}", file.path),
                        "bytes_written": 0,
                        "mode": mode,
                        "lines_added": 0,
                        "lines_removed": 0,
                    }));
                    continue;
                }
                // Use FileTransaction for atomic create with preflight
                // (creates parent dirs, stages temp, flushes, atomically renames).
                let mut tx = match FileTransaction::new(&canon) {
                    Ok(t) => t,
                    Err(e) => {
                        results.push(write_err_entry(&file.path, &e.to_string(), mode));
                        continue;
                    }
                };
                if let Err(e) = tx.write_all(bytes) {
                    results.push(write_err_entry(&file.path, &e.to_string(), mode));
                    continue;
                }
                if let Err(e) = tx.commit_create() {
                    results.push(write_err_entry(&file.path, &e.to_string(), mode));
                    continue;
                }
                bytes.len()
            }
            "overwrite" => {
                // Use FileTransaction for atomic overwrite.
                let mut tx = match FileTransaction::new(&canon) {
                    Ok(t) => t,
                    Err(e) => {
                        results.push(write_err_entry(&file.path, &e.to_string(), mode));
                        continue;
                    }
                };
                if let Err(e) = tx.write_all(bytes) {
                    results.push(write_err_entry(&file.path, &e.to_string(), mode));
                    continue;
                }
                if let Err(e) = tx.commit() {
                    results.push(write_err_entry(&file.path, &e.to_string(), mode));
                    continue;
                }
                bytes.len()
            }
            "append" => {
                // Append mode: read existing, append, write back atomically.
                // This preserves FileTransaction semantics for the final write.
                let existing = match std::fs::metadata(&canon) {
                    Ok(metadata) if !metadata.is_file() => {
                        results.push(write_err_entry(
                            &file.path,
                            "append target is not a file",
                            mode,
                        ));
                        continue;
                    }
                    Ok(metadata) if metadata.len() > MAX_WRITE_TARGET_BYTES as u64 => {
                        results.push(write_err_entry(
                            &file.path,
                            &format!(
                                "append target is {} bytes. The final-file limit is {} bytes.",
                                metadata.len(), MAX_WRITE_TARGET_BYTES
                            ),
                            mode,
                        ));
                        continue;
                    }
                    Ok(_) => match std::fs::File::open(&canon).and_then(|opened| {
                        read_cancellable(
                            opened,
                            (MAX_WRITE_TARGET_BYTES as u64).saturating_add(1),
                            None,
                            || {},
                        )
                    }) {
                        Ok(existing) if existing.len() <= MAX_WRITE_TARGET_BYTES => existing,
                        Ok(_) => {
                            results.push(write_err_entry(
                                &file.path,
                                "append target grew beyond the 32 MiB final-file limit",
                                mode,
                            ));
                            continue;
                        }
                        Err(error) => {
                            results.push(write_err_entry(
                                &file.path,
                                &format!("could not read append target: {}", error),
                                mode,
                            ));
                            continue;
                        }
                    },
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
                    Err(error) => {
                        results.push(write_err_entry(
                            &file.path,
                            &format!("could not inspect append target: {}", error),
                            mode,
                        ));
                        continue;
                    }
                };
                if existing.len().saturating_add(bytes.len()) > MAX_WRITE_TARGET_BYTES {
                    results.push(write_err_entry(
                        &file.path,
                        &format!(
                            "append result exceeds the {}-byte final-file limit",
                            MAX_WRITE_TARGET_BYTES
                        ),
                        mode,
                    ));
                    continue;
                }
                let mut combined = existing;
                combined.extend_from_slice(bytes);

                let mut tx = match FileTransaction::new(&canon) {
                    Ok(t) => t,
                    Err(e) => {
                        results.push(write_err_entry(&file.path, &e.to_string(), mode));
                        continue;
                    }
                };
                if let Err(e) = tx.write_all(&combined) {
                    results.push(write_err_entry(&file.path, &e.to_string(), mode));
                    continue;
                }
                if let Err(e) = tx.commit() {
                    results.push(write_err_entry(&file.path, &e.to_string(), mode));
                    continue;
                }
                bytes.len()
            }
            other => {
                results.push(write_err_entry(&file.path, &format!("unknown mode '{}'", other), mode));
                continue;
            }
        };
        let mut entry = serde_json::json!({
            "path": file.path,
            "bytes_written": bytes_written,
            "mode": mode,
            "lines_added": count_text_lines(&file.content),
        });
        // Append never removes lines. Otherwise report the measured count, and
        // omit the field entirely when the prior content was too large to
        // scan — no number is better than a wrong one.
        if mode == "append" {
            entry["lines_removed"] = serde_json::json!(0);
        } else if let Some(before) = lines_before {
            entry["lines_removed"] = serde_json::json!(before);
        }
        results.push(entry);
    }

    Ok(serde_json::json!({ "results": results }))
    }).await.map_err(|e| ToolError::Io(format!("task join failed: {}", e)))?
}

fn write_err_entry(path: &str, msg: &str, mode: &str) -> serde_json::Value {
    serde_json::json!({
        "path": path,
        "error": msg,
        "bytes_written": 0,
        "mode": mode,
        "lines_added": 0,
        "lines_removed": 0,
    })
}

/* ------------------------------------------------------------------ */
/*  Tauri command: tool_read_image                                      */
/* ------------------------------------------------------------------ */

#[derive(Debug, Deserialize)]
pub struct ReadImageRequest {
    pub paths: Vec<String>,
    pub max_bytes: Option<u64>,
    pub encoding: Option<String>,
    /// Downscale factor [0.1–1.0], default 1.0 (no resize).
    /// Applied before JPEG encoding.  0.5 = half width & height.
    #[serde(default = "default_downscale")]
    pub downscale: f32,
    pub allowed_roots: Option<Vec<String>>,
}

fn default_downscale() -> f32 {
    1.0
}

fn effective_image_input_limit(requested: Option<u64>) -> u64 {
    requested
        .unwrap_or(DEFAULT_IMAGE_INPUT_BYTES)
        .min(HARD_CAP_IMAGE_INPUT_BYTES)
}

fn analysis_paths(paths: &[String]) -> &[String] {
    &paths[..paths.len().min(MAX_ANALYSIS_IMAGE_COUNT)]
}

/// Pure truncation meta for `tool_analyze_images` — factored for unit testing
/// without a live vision service.
pub(crate) fn analyze_truncation_counts(total_requested: usize) -> (bool, usize, usize) {
    let truncated = total_requested > MAX_ANALYSIS_IMAGE_COUNT;
    let processed_count = total_requested.min(MAX_ANALYSIS_IMAGE_COUNT);
    let dropped_count = total_requested.saturating_sub(processed_count);
    (truncated, processed_count, dropped_count)
}

pub(crate) fn build_analyze_warning(
    total_requested: usize,
    processed_count: usize,
    dropped_count: usize,
    analyzed_count: usize,
) -> Option<String> {
    if dropped_count == 0 {
        return None;
    }
    if analyzed_count == processed_count {
        Some(format!(
            "Only {} of {} requested images were processed ({} dropped due to the {}-image analyze limit). All {} processed images were successfully encoded and admitted to analysis requests. Re-issue with the remaining {} paths to analyze the rest.",
            processed_count, total_requested, dropped_count, MAX_ANALYSIS_IMAGE_COUNT, processed_count, dropped_count
        ))
    } else if analyzed_count == 0 {
        Some(format!(
            "Only {} of {} requested images were processed ({} dropped due to the {}-image analyze limit). None of the {} processed images were successfully encoded — see per-image errors. Re-issue with the remaining {} paths to analyze the rest.",
            processed_count, total_requested, dropped_count, MAX_ANALYSIS_IMAGE_COUNT, processed_count, dropped_count
        ))
    } else {
        Some(format!(
            "Only {} of {} requested images were processed ({} dropped due to the {}-image analyze limit). Only {} of the {} processed images were successfully encoded for analysis ({} failed — see per-image errors). Re-issue with the remaining {} paths to analyze the rest.",
            processed_count, total_requested, dropped_count, MAX_ANALYSIS_IMAGE_COUNT, analyzed_count, processed_count, processed_count - analyzed_count, dropped_count
        ))
    }
}

/// Read one or more image files inside allowed roots and return
/// base64-encoded data the model can pass as `data:` URLs to a
/// vision endpoint.  All images in the batch share the same
/// `encoding` and `max_bytes` settings.
///
/// Phase 3.4: per-image partial failures (one bad image doesn't
/// fail the batch), dimension/pixel limits, rejects truncated
/// images, returns only ONE representation (data_url, not both
/// data_url and base64).
///
/// `encoding` controls output format / quality:
///   - "original" (default) — raw bytes, no conversion.
///   - "low_jpeg"  — decode & re-encode as JPEG quality 30 (3/10).
///   - "medium_jpeg" — decode & re-encode as JPEG quality 60 (6/10).
#[tauri::command]
pub async fn tool_read_image(req: ReadImageRequest) -> Result<ToolOk, ToolError> {
    tokio::task::spawn_blocking(move || {
        let roots = merged_roots(req.allowed_roots.as_deref().unwrap_or(&[]));
        let encoding = req.encoding.as_deref().unwrap_or("original");
        let max_bytes = effective_image_input_limit(req.max_bytes);

        // Phase 3.4: cap image count.
        if req.paths.len() > MAX_DELIVERY_IMAGE_COUNT {
            return Err(ToolError::Io(format!(
                "too many images: {} requested, max {}",
                req.paths.len(),
                MAX_DELIVERY_IMAGE_COUNT
            )));
        }

        // Clamp downscale to [0.1, 1.0].
        let downscale = req.downscale.clamp(0.1, 1.0);

        let mut images: Vec<serde_json::Value> = Vec::with_capacity(req.paths.len());

        for path in &req.paths {
            // Phase 3.4: per-image errors don't fail the batch.
            let entry = match read_single_image(
                path,
                &roots,
                max_bytes,
                encoding,
                downscale,
                MAX_IMAGE_PIXELS,
                MAX_IMAGE_DIMENSION,
            ) {
                Ok(e) => e,
                Err(e) => serde_json::json!({
                    "path": path,
                    "error": e.to_string(),
                    "mime": null,
                    "data_url": null,
                    "size_bytes": 0,
                    "original_size_bytes": 0,
                    "original_wh": null,
                    "wh_downscale": downscale,
                    "encoding": encoding,
                    "truncated": false,
                }),
            };
            images.push(entry);
        }

        Ok(serde_json::json!({ "images": images }))
    })
    .await
    .map_err(|e| ToolError::Io(format!("task join failed: {}", e)))?
}

/// Process a single image: resolve, read, optionally downscale,
/// optionally re-encode, base64-encode, and return as a JSON value.
///
/// Phase 3.4: rejects truncated images (returns error), enforces
/// dimension/pixel limits, returns only `data_url` (not base64).
fn read_single_image(
    path: &str,
    roots: &[PathBuf],
    max_bytes: u64,
    encoding: &str,
    downscale: f32,
    max_pixels: u64,
    max_dimension: u32,
) -> Result<serde_json::Value, ToolError> {
    let canon = resolve_under_roots(path, roots)?;

    let meta = std::fs::metadata(&canon).map_err(|e| ToolError::Io(e.to_string()))?;
    if !meta.is_file() {
        return Err(ToolError::NotAFile(path.to_string()));
    }

    let original_size = meta.len();

    // Phase 3.4: reject oversized images before reading.
    if original_size > max_bytes {
        return Err(ToolError::Io(format!(
            "image too large: {} bytes > max {} bytes. Use a smaller max_bytes or re-encode.",
            original_size, max_bytes
        )));
    }

    let file = std::fs::File::open(&canon).map_err(|e| ToolError::Io(e.to_string()))?;
    let mut raw = Vec::with_capacity(original_size as usize);
    file.take(max_bytes)
        .read_to_end(&mut raw)
        .map_err(|e| ToolError::Io(e.to_string()))?;

    // Phase 3.4: detect truncation and reject.
    if raw.len() as u64 != original_size {
        return Err(ToolError::Io(format!(
            "image truncated: read {} of {} bytes",
            raw.len(),
            original_size
        )));
    }

    let (out_bytes, out_mime, original_wh) = {
        // Decode once — capture original dimensions before any resize.
        // Format comes from the bytes, not the filename. The decoder
        // already sniffs magic bytes, so reporting the extension meant
        // a PNG named `.jpg` was announced as JPEG, and a correct file
        // with no extension as `application/octet-stream`.
        let detected = image::guess_format(&raw).ok();
        let img = image::load_from_memory(&raw)
            .map_err(|e| ToolError::Io(unreadable_image_message(&raw, &e.to_string())))?;
        let orig_w = img.width();
        let orig_h = img.height();

        // Dimension / pixel checks against original.
        if orig_w > max_dimension || orig_h > max_dimension {
            return Err(ToolError::Io(format!(
                "image dimensions {}x{} exceed max dimension {}",
                orig_w, orig_h, max_dimension
            )));
        }
        if (orig_w as u64) * (orig_h as u64) > max_pixels {
            return Err(ToolError::Io(format!(
                "image pixels {} ({}x{}) exceed max {}",
                (orig_w as u64) * (orig_h as u64),
                orig_w,
                orig_h,
                max_pixels
            )));
        }

        // Downscale: resize if factor < 1.0 (before any encoding).
        let working = if downscale < 1.0 {
            let new_w = ((orig_w as f32) * downscale).round() as u32;
            let new_h = ((orig_h as f32) * downscale).round() as u32;
            let new_w = new_w.max(1);
            let new_h = new_h.max(1);
            image::imageops::resize(&img, new_w, new_h, image::imageops::FilterType::Lanczos3)
        } else {
            img.to_rgba8() // No resize — just convert to RGBA for uniform handling.
        };

        let orig_wh = [orig_w, orig_h];

        if encoding == "original" {
            if downscale < 1.0 {
                // Downscaled — can't return raw bytes; re-encode as PNG.
                let mut png_bytes = Vec::new();
                image::DynamicImage::ImageRgba8(working)
                    .write_to(
                        &mut std::io::Cursor::new(&mut png_bytes),
                        image::ImageFormat::Png,
                    )
                    .map_err(|e| ToolError::Io(format!("PNG encode failed: {}", e)))?;
                (png_bytes, "image/png", orig_wh)
            } else {
                // No downscale, no re-encode — return raw bytes as-is.
                (
                    raw,
                    detected
                        .map(|format| format.to_mime_type())
                        .unwrap_or("application/octet-stream"),
                    orig_wh,
                )
            }
        } else {
            let quality: u8 = match encoding {
                "low_jpeg" => 30,
                "medium_jpeg" => 60,
                other => {
                    return Err(ToolError::Io(format!(
                        "unknown encoding '{}'. Use original, low_jpeg, or medium_jpeg.",
                        other
                    )));
                }
            };
            let mut jpeg_bytes = Vec::new();
            {
                let mut enc =
                    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg_bytes, quality);
                enc.encode_image(&image::DynamicImage::ImageRgba8(working))
                    .map_err(|e| ToolError::Io(format!("JPEG encode failed: {}", e)))?;
            }
            (jpeg_bytes, "image/jpeg", orig_wh)
        }
    };

    let out_size = out_bytes.len() as u64;

    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&out_bytes);
    let data_url = format!("data:{};base64,{}", out_mime, b64);

    // Phase 3.4: return ONLY data_url (not separate base64 field).
    Ok(serde_json::json!({
        "path": path,
        "data_url": data_url,
        "mime": out_mime,
        "size_bytes": out_size,
        "original_size_bytes": original_size,
        "original_wh": original_wh,
        "wh_downscale": downscale,
        "encoding": encoding,
        "truncated": false,
    }))
}

/* ------------------------------------------------------------------ */
/*  Tauri command: tool_analyze_images                                  */
/* ------------------------------------------------------------------ */

#[derive(Debug, Deserialize)]
pub struct AnalyzeImagesRequest {
    pub paths: Vec<String>,
    pub encoding: Option<String>,
    pub max_bytes: Option<u64>,
    /// Operation/group identity for native cancellation registration.
    #[serde(default)]
    pub call_id: Option<String>,
    #[serde(default)]
    pub group_id: Option<String>,
    /// Downscale factor [0.1–1.0], default 1.0 (no resize).
    /// Applied before encoding.  0.5 = half width & height.
    #[serde(default = "default_downscale")]
    pub downscale: f32,
    pub allowed_roots: Option<Vec<String>>,
    /// Base URL of the OpenAI-compat / LLM server (e.g. LM Studio, vLLM, etc.).
    pub server_url: String,
    /// Model name to use for vision (e.g. "gemma-3-12b-it").
    pub model: String,
    /// API key (may be empty for local servers).
    pub api_key: Option<String>,
    /// API protocol variant: "openai", "anthropic", or "lm-studio".
    /// Defaults to "openai".
    pub api_variant: Option<String>,
    /// API style: "chat" for /chat/completions, "responses" for /responses.
    /// Only meaningful when api_variant is "openai".  The /responses
    /// endpoint is ignored for "anthropic" and "lm-studio" variants
    /// (they have their own protocol paths).
    pub api_style: Option<String>,
    /// Fully resolved extra headers supplied by the owning LC profile.
    #[serde(default)]
    pub request_headers: Vec<(String, String)>,
    /// System prompt for the vision call.
    pub system_prompt: String,
    /// User's custom instruction (without image labels).
    /// Used for per-image calls so each image gets the user's intent.
    pub user_instruction: Option<String>,
    /// Optional token cap.
    pub max_tokens: Option<u32>,
}

fn ensure_analysis_not_cancelled(
    cancel_token: Option<&CancellationToken>,
) -> Result<(), ToolError> {
    if cancel_token.is_some_and(CancellationToken::is_cancelled) {
        Err(ToolError::Aborted)
    } else {
        Ok(())
    }
}

async fn await_analysis_or_cancel<T, F>(
    cancel_token: Option<&CancellationToken>,
    work: F,
) -> Result<T, ToolError>
where
    F: Future<Output = T>,
{
    if let Some(token) = cancel_token {
        tokio::select! {
            result = work => Ok(result),
            _ = token.cancelled() => Err(ToolError::Aborted),
        }
    } else {
        Ok(work.await)
    }
}

/// Send a single vision API request and return the model's text response.
/// The `user_content` Vec must already contain text + image parts in the
/// OpenAI Chat Completions format — this function translates to the
/// target variant's wire format, sends the request, and parses the response.
async fn send_vision_request(
    client: &reqwest::Client,
    req: &AnalyzeImagesRequest,
    user_content: Vec<serde_json::Value>,
    _image_index: usize,
    _total_images: usize,
) -> Result<String, ToolError> {
    let variant = req.api_variant.as_deref().unwrap_or("openai");
    let is_anthropic = variant == "anthropic";
    let is_responses =
        variant == "openai" && req.api_style.as_deref().unwrap_or("chat") == "responses";
    let is_lm_studio_rest = variant == "lm-studio";

    let config = super::model_request::NativeModelConfig {
        server_url: req.server_url.clone(),
        model: req.model.clone(),
        api_key: req.api_key.clone(),
        api_variant: req.api_variant.clone(),
        api_style: req.api_style.clone(),
        request_headers: req.request_headers.clone(),
    };
    let (chat_url, body) = super::model_request::request_body(
        &config, &req.system_prompt, user_content, req.max_tokens, None,
    );

    // Send the request.
    let mut request = client
        .post(&chat_url)
        .header("Content-Type", "application/json");
    if let Some(ref key) = req.api_key {
        if !key.is_empty() {
            if is_anthropic {
                request = request
                    .header("x-api-key", key.as_str())
                    .header("anthropic-version", "2023-06-01");
            } else {
                request = request.header("Authorization", format!("Bearer {}", key));
            }
        }
    }
    if !req.request_headers.is_empty() {
        let mut headers = reqwest::header::HeaderMap::new();
        for (name, value) in &req.request_headers {
            if let (Ok(name), Ok(value)) = (
                reqwest::header::HeaderName::from_bytes(name.as_bytes()),
                reqwest::header::HeaderValue::from_bytes(value.as_bytes()),
            ) {
                headers.insert(name, value);
            }
        }
        request = request.headers(headers);
    }

    const DEFAULT_VISION_TIMEOUT_SECS: u64 = 120;
    const ANTHROPIC_VISION_TIMEOUT_SECS: u64 = 180;
    let timeout_secs = if is_anthropic {
        ANTHROPIC_VISION_TIMEOUT_SECS
    } else {
        DEFAULT_VISION_TIMEOUT_SECS
    };
    let response = tokio::time::timeout(
        std::time::Duration::from_secs(timeout_secs),
        request.json(&body).send(),
    )
    .await
    .map_err(|_| {
        ToolError::Io(format!(
            "Vision request timed out after {}s for image {}/{}.",
            timeout_secs,
            _image_index + 1,
            _total_images,
        ))
    })?
    .map_err(|e| ToolError::Io(format!("Vision model request failed: {}", e)))?;

    if !response.status().is_success() {
        let status = response.status();
        let text = read_bounded_vision_body(response, MAX_VISION_ERROR_BODY_BYTES)
            .await
            .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
            .unwrap_or_else(|error| error.to_string());
        return Err(ToolError::Io(format!(
            "Vision model returned HTTP {} for image {}/{}: {}",
            status.as_u16(),
            _image_index + 1,
            _total_images,
            text
        )));
    }

    let response_bytes = read_bounded_vision_body(response, MAX_VISION_RESPONSE_BYTES).await?;
    let json: serde_json::Value = serde_json::from_slice(&response_bytes)
        .map_err(|e| ToolError::Io(format!("Vision model response parse failed: {}", e)))?;

    let description =
        extract_vision_response_text(&json, is_anthropic, is_responses, is_lm_studio_rest)
            .ok_or_else(|| {
                ToolError::Io(format!(
                    "Vision model response contained no text for image {}/{}.",
                    _image_index + 1,
                    _total_images,
                ))
            })?;

    bounded_vision_description(description, _image_index, _total_images)
}

fn bounded_vision_description(
    description: String,
    image_index: usize,
    total_images: usize,
) -> Result<String, ToolError> {
    let measured_bytes = description.len();
    if measured_bytes > MAX_VISION_DESCRIPTION_BYTES {
        return Err(ToolError::TooLarge(format!(
            "Vision model description for image {}/{} is {} UTF-8 bytes. The per-image limit is {} bytes. Narrow the instruction or select another model.",
            image_index + 1,
            total_images,
            measured_bytes,
            MAX_VISION_DESCRIPTION_BYTES,
        )));
    }
    Ok(description)
}

pub(super) async fn read_bounded_vision_body(
    mut response: reqwest::Response,
    max_bytes: usize,
) -> Result<Vec<u8>, ToolError> {
    if response
        .content_length()
        .is_some_and(|length| length > max_bytes as u64)
    {
        return Err(ToolError::TooLarge(format!(
            "Vision model response exceeds the {}-byte body limit.",
            max_bytes
        )));
    }

    let mut bytes =
        Vec::with_capacity(response.content_length().unwrap_or(0).min(max_bytes as u64) as usize);
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| ToolError::Io(format!("Vision model response read failed: {}", error)))?
    {
        if bytes.len().saturating_add(chunk.len()) > max_bytes {
            return Err(ToolError::TooLarge(format!(
                "Vision model response exceeds the {}-byte body limit.",
                max_bytes
            )));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

/// Extract only real model text from one supported vision response shape.
fn extract_vision_response_text(
    json: &serde_json::Value,
    is_anthropic: bool,
    is_responses: bool,
    is_lm_studio_rest: bool,
) -> Option<String> {
    let description = if is_anthropic {
        json["content"].as_array().and_then(|parts| {
            parts.iter().find_map(|p| {
                if p["type"].as_str() == Some("text") {
                    p["text"].as_str()
                } else {
                    None
                }
            })
        })
    } else if is_responses {
        json["output"].as_array().and_then(|items| {
            items.iter().find_map(|item| {
                if item["type"].as_str() == Some("message") {
                    item["content"].as_array().and_then(|parts| {
                        parts.iter().find_map(|p| {
                            if p["type"].as_str() == Some("output_text") {
                                p["text"].as_str()
                            } else {
                                None
                            }
                        })
                    })
                } else {
                    None
                }
            })
        })
    } else if is_lm_studio_rest {
        json["output"].as_array().and_then(|items| {
            items.iter().find_map(|item| {
                if item["type"].as_str() == Some("message") {
                    item["content"].as_str()
                } else {
                    None
                }
            })
        })
    } else {
        json["choices"][0]["message"]["content"].as_str()
    };

    description
        .filter(|text| !text.trim().is_empty())
        .map(ToOwned::to_owned)
}

/// Read images from disk, encode them, and send each to a vision model
/// in its own dedicated API call.  This avoids the model confusing
/// image ordering when two or more images are visually identical.
///
/// Images are processed 2 at a time (concurrent within each pair,
/// sequential across pairs) to balance speed against server load.
#[tauri::command]
pub async fn tool_analyze_images(req: AnalyzeImagesRequest) -> Result<ToolOk, ToolError> {
    // Register before image preparation so Stop covers the whole native call,
    // including the potentially long vision-model request.
    let (cancel_token, _guard) = if let Some(ref call_id) = req.call_id {
        let token = CancellationToken::new();
        let guard = super::registry::register_with_group(
            call_id.clone(),
            ToolHandle(token.clone()),
            req.group_id.clone(),
        );
        (Some(token), Some(guard))
    } else {
        (None, None)
    };

    ensure_analysis_not_cancelled(cancel_token.as_ref())?;
    let roots = merged_roots(req.allowed_roots.as_deref().unwrap_or(&[]));
    let encoding = req.encoding.as_deref().unwrap_or("medium_jpeg");
    let max_bytes = effective_image_input_limit(req.max_bytes);
    let downscale = req.downscale.clamp(0.1, 1.0);

    let total_requested = req.paths.len();
    let (truncated, processed_count, dropped_count) = analyze_truncation_counts(total_requested);
    let paths = analysis_paths(&req.paths);

    // 1. Encode all images.  Collect (path, data_url, metadata) for
    //    valid images; collect error-only metadata for failures.
    struct ImageToAnalyze {
        path: String,
        data_url: String,
        original_index: usize,
    }
    let mut to_analyze: Vec<ImageToAnalyze> = Vec::with_capacity(paths.len());
    let mut all_metadata: Vec<serde_json::Value> = Vec::with_capacity(paths.len());

    for (original_index, path) in paths.iter().enumerate() {
        ensure_analysis_not_cancelled(cancel_token.as_ref())?;
        match read_single_image(
            path,
            &roots,
            max_bytes,
            encoding,
            downscale,
            MAX_IMAGE_PIXELS,
            MAX_IMAGE_DIMENSION,
        ) {
            Ok(entry) => {
                let data_url = entry["data_url"].as_str().unwrap_or("").to_string();
                let size_bytes = entry["size_bytes"].as_u64().unwrap_or(0);

                let meta = serde_json::json!({
                    "path": entry["path"],
                    "mime": entry["mime"],
                    "size_bytes": entry["size_bytes"],
                    "original_size_bytes": entry["original_size_bytes"],
                    "original_wh": entry["original_wh"],
                    "wh_downscale": entry["wh_downscale"],
                    "encoding": entry["encoding"],
                    "truncated": entry["truncated"],
                });

                if size_bytes > MAX_ANALYSIS_ENCODED_BYTES {
                    let mut err_meta = meta.clone();
                    err_meta["error"] = serde_json::json!(format!(
                        "Image is {:.1} MiB after encoding (max 5 MiB per image). \
                         Try: encoding='low_jpeg', downscale=0.5, or both.",
                        size_bytes as f64 / 1_048_576.0
                    ));
                    all_metadata.push(err_meta);
                    continue;
                }

                all_metadata.push(meta.clone());
                to_analyze.push(ImageToAnalyze {
                    path: entry["path"].as_str().unwrap_or(path).to_string(),
                    data_url,
                    original_index,
                });
            }
            Err(e) => {
                all_metadata.push(serde_json::json!({
                    "path": path,
                    "error": e.to_string(),
                    "size_bytes": 0,
                    "original_size_bytes": 0,
                    "original_wh": null,
                    "wh_downscale": downscale,
                    "encoding": encoding,
                    "truncated": false,
                }));
            }
        }
        ensure_analysis_not_cancelled(cancel_token.as_ref())?;
    }

    let analyzed_count = to_analyze.len();
    let warning = build_analyze_warning(
        total_requested,
        processed_count,
        dropped_count,
        analyzed_count,
    );

    if to_analyze.is_empty() {
        ensure_analysis_not_cancelled(cancel_token.as_ref())?;
        let mut result = serde_json::json!({
            "images": all_metadata,
            "analyzed": false,
            "description": null,
            "truncated": truncated,
            "total_requested": total_requested,
            "processed_count": processed_count,
            "analyzed_count": 0,
            "described_count": 0,
            "dropped_count": dropped_count,
        });
        if let Some(warning) = warning {
            result["warning"] = serde_json::json!(warning);
        }
        return Ok(result);
    }

    // 2. Build HTTP client (shared across all requests).
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| ToolError::Io(format!("HTTP client build failed: {}", e)))?;

    let mut descriptions: Vec<Option<String>> = Vec::with_capacity(analyzed_count);

    // 3. Process images 2 at a time.
    for chunk in to_analyze.chunks(2) {
        ensure_analysis_not_cancelled(cancel_token.as_ref())?;
        let chunk_work = async {
            if chunk.len() == 2 {
                let f0 = send_vision_request_single(
                    &client,
                    &req,
                    &chunk[0].data_url,
                    chunk[0].original_index,
                    total_requested,
                );
                let f1 = send_vision_request_single(
                    &client,
                    &req,
                    &chunk[1].data_url,
                    chunk[1].original_index,
                    total_requested,
                );
                let (r0, r1) = tokio::join!(f0, f1);
                (r0, Some(r1))
            } else {
                let r0 = send_vision_request_single(
                    &client,
                    &req,
                    &chunk[0].data_url,
                    chunk[0].original_index,
                    total_requested,
                )
                .await;
                (r0, None)
            }
        };
        let (desc0, desc1): (Result<String, ToolError>, Option<Result<String, ToolError>>) =
            await_analysis_or_cancel(cancel_token.as_ref(), chunk_work).await?;

        match desc0 {
            Ok(d) if !d.trim().is_empty() => descriptions.push(Some(d)),
            Ok(_) => {
                all_metadata[chunk[0].original_index]["error"] =
                    serde_json::json!("image analysis returned no description");
                descriptions.push(None);
            }
            Err(e) => {
                all_metadata[chunk[0].original_index]["error"] =
                    serde_json::json!(format!("image analysis failed: {}", e));
                descriptions.push(None);
            }
        }
        if let Some(d1) = desc1 {
            match d1 {
                Ok(d) if !d.trim().is_empty() => descriptions.push(Some(d)),
                Ok(_) => {
                    all_metadata[chunk[1].original_index]["error"] =
                        serde_json::json!("image analysis returned no description");
                    descriptions.push(None);
                }
                Err(e) => {
                    all_metadata[chunk[1].original_index]["error"] =
                        serde_json::json!(format!("image analysis failed: {}", e));
                    descriptions.push(None);
                }
            }
        }
    }

    ensure_analysis_not_cancelled(cancel_token.as_ref())?;

    // 4. Label each description for unambiguous mapping.
    let labeled: Vec<String> = to_analyze
        .iter()
        .enumerate()
        .filter_map(|(description_index, img)| {
            let desc = descriptions.get(description_index)?.as_deref()?;
            Some(format!(
                "Image {} of {} ({}):\n{}",
                img.original_index + 1,
                total_requested,
                img.path,
                desc
            ))
        })
        .collect();

    let analyzed = !labeled.is_empty();
    let described_count = labeled.len();
    let description = if analyzed {
        serde_json::Value::String(labeled.join("\n\n"))
    } else {
        serde_json::Value::Null
    };

    let mut result = serde_json::json!({
        "images": all_metadata,
        "analyzed": analyzed,
        "description": description,
        "truncated": truncated,
        "total_requested": total_requested,
        "processed_count": processed_count,
        "analyzed_count": analyzed_count,
        "described_count": described_count,
        "dropped_count": dropped_count,
    });
    if let Some(warning) = warning {
        result["warning"] = serde_json::json!(warning);
    }
    Ok(result)
}

/// Build a per-image instruction and send it to the vision API.
async fn send_vision_request_single(
    client: &reqwest::Client,
    req: &AnalyzeImagesRequest,
    data_url: &str,
    index: usize,
    total: usize,
) -> Result<String, ToolError> {
    let base = req.user_instruction.as_deref().unwrap_or(
        "Describe what you see in detail. Cover layout, text, colours, UI elements, errors, etc.",
    );
    // The provider needs the image's request position, not the local path.
    // Paths can disclose usernames and project names to a separate service.
    let image_instruction = format!("{}\n\nImage {} of {}.", base, index + 1, total);

    let mut user_content: Vec<serde_json::Value> = Vec::new();
    user_content.push(serde_json::json!({
        "type": "text",
        "text": image_instruction
    }));
    user_content.push(serde_json::json!({
        "type": "image_url",
        "image_url": { "url": data_url }
    }));

    send_vision_request(client, req, user_content, index, total).await
}

/// Best-effort MIME type from file extension.  Image formats the
/// typical vision model understands.
/// Why a byte sequence could not be opened as a raster image.
///
/// The decoder's own message is "format could not be determined",
/// which is true and unhelpful: it does not say that the file is SVG,
/// or that this build has no decoder for it. An error message is
/// control input, so it names the format and the tool that can read it.
fn unreadable_image_message(raw: &[u8], decoder_error: &str) -> String {
    let head = &raw[..raw.len().min(512)];
    let text = String::from_utf8_lossy(head);
    let looks_like_svg = text.contains("<svg") || (text.contains("<?xml") && text.contains("svg"));
    if looks_like_svg {
        return "svg is vector markup, not a raster image: read it as text with lc_read_file"
            .to_string();
    }
    if head.starts_with(b"II* ") || head.starts_with(b"MM *") {
        return "tiff is not supported by this build: convert the image to png or jpeg first"
            .to_string();
    }
    if head.starts_with(&[0x00, 0x00, 0x01, 0x00]) {
        return "ico is not supported by this build: convert the image to png first".to_string();
    }
    format!(
        "image decode failed ({}). Supported formats are png, jpeg, gif, webp, and bmp.",
        decoder_error
    )
}

/* ------------------------------------------------------------------ */
/*  Tests: resolve_under_roots and canonical permission identity          */
/* ------------------------------------------------------------------ */

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    /// Per-process unique tempdir so parallel test runs don't collide.
    fn tempdir() -> PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let id = COUNTER.fetch_add(1, Ordering::Relaxed);
        let p = std::env::temp_dir().join(format!(
            "lc-fs-ops-test-{}-{}-{}",
            std::process::id(),
            id,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    /// Wrap a tempdir path in the `allowed_roots` vec that the tools require.
    fn roots_from(dir: &Path) -> Vec<String> {
        vec![dir.to_string_lossy().into_owned()]
    }

    #[test]
    fn image_contract_limits_are_shared_across_delivery_and_analysis() {
        assert_eq!(effective_image_input_limit(None), 10 * 1024 * 1024);
        assert_eq!(effective_image_input_limit(Some(1)), 1);
        assert_eq!(
            effective_image_input_limit(Some(60 * 1024 * 1024)),
            50 * 1024 * 1024
        );
        assert_eq!(MAX_DELIVERY_IMAGE_COUNT, 20);
        assert_eq!(MAX_ANALYSIS_IMAGE_COUNT, 10);
        assert_eq!(MAX_IMAGE_PIXELS, 100_000_000);
        assert_eq!(MAX_IMAGE_DIMENSION, 16_384);
        assert_eq!(MAX_ANALYSIS_ENCODED_BYTES, 5 * 1024 * 1024);

        let paths = (0..12)
            .map(|index| format!("{index}.png"))
            .collect::<Vec<_>>();
        assert_eq!(analysis_paths(&paths).len(), 10);
        assert_eq!(analysis_paths(&paths)[9], "9.png");
    }

    #[test]
    fn caller_resource_limits_default_and_clamp_at_native_boundary() {
        assert_eq!(effective_read_limit(None), DEFAULT_READ_BYTES);
        assert_eq!(
            effective_read_limit(Some(HARD_CAP_READ_BYTES)),
            HARD_CAP_READ_BYTES
        );
        assert_eq!(
            effective_read_limit(Some(HARD_CAP_READ_BYTES + 1)),
            HARD_CAP_READ_BYTES
        );

        assert_eq!(effective_list_limit(None), DEFAULT_LIST_ENTRIES);
        assert_eq!(
            effective_list_limit(Some(HARD_CAP_LIST_ENTRIES)),
            HARD_CAP_LIST_ENTRIES
        );
        assert_eq!(
            effective_list_limit(Some(HARD_CAP_LIST_ENTRIES + 1)),
            HARD_CAP_LIST_ENTRIES
        );
    }

    #[tokio::test]
    async fn filesystem_batch_limits_reject_cap_plus_one_before_io() {
        assert!(enforce_filesystem_batch_limit(
            "lc_read_file",
            "paths",
            FILESYSTEM_BATCH_MAX_ENTRIES,
        )
        .is_ok());

        let read_error = tool_read_file(ReadFileRequest {
            paths: vec!["missing".into(); FILESYSTEM_BATCH_MAX_ENTRIES + 1],
            ..Default::default()
        })
        .await
        .expect_err("read_file cap + 1 must fail before I/O");
        assert!(read_error.to_string().contains("paths contains 21 entries"));
        assert!(read_error.to_string().contains("batches of 20 or fewer"));

        let list_error = tool_list_dir(ListDirRequest {
            paths: vec!["missing".into(); FILESYSTEM_BATCH_MAX_ENTRIES + 1],
            pattern: None,
            include_hidden: None,
            max_entries: None,
            allowed_roots: None,
        })
        .await
        .expect_err("list_dir cap + 1 must fail before I/O");
        assert!(list_error.to_string().contains("lc_list_dir"));
        assert!(list_error.to_string().contains("paths"));

        let write_error = tool_write_file(WriteFileRequest {
            files: (0..=FILESYSTEM_BATCH_MAX_ENTRIES)
                .map(|index| WriteFileEntry {
                    path: format!("missing-{index}"),
                    content: String::new(),
                    expected_sha256: None,
                })
                .collect(),
            mode: None,
            allowed_roots: None,
        })
        .await
        .expect_err("write_file cap + 1 must fail before I/O");
        assert!(write_error.to_string().contains("lc_write_file"));
        assert!(write_error.to_string().contains("files"));
    }

    #[test]
    fn stat_rejects_more_than_one_hundred_paths_at_native_boundary() {
        let at_cap = tool_stat(StatRequest {
            paths: (0..MAX_STAT_PATHS)
                .map(|index| format!("missing-{index}"))
                .collect(),
            allowed_roots: Some(Vec::new()),
        })
        .expect("the exact stat cap must be accepted");
        assert_eq!(at_cap["results"].as_array().unwrap().len(), MAX_STAT_PATHS);

        let error = tool_stat(StatRequest {
            paths: (0..=MAX_STAT_PATHS)
                .map(|index| format!("missing-{index}"))
                .collect(),
            allowed_roots: Some(Vec::new()),
        })
        .expect_err("stat cap + 1 must fail at the native boundary");
        assert!(matches!(error, ToolError::TooLarge(_)));
        assert!(error.to_string().contains("max 100"));
    }

    #[test]
    fn analyze_warning_distinguishes_processed_from_analyzed_images() {
        assert_eq!(analyze_truncation_counts(11), (true, 10, 1));
        let warning = build_analyze_warning(11, 10, 1, 0).unwrap();
        assert!(warning.contains("10 of 11 requested images were processed"));
        assert!(warning.contains("None of the 10 processed images"));
        assert!(!warning.contains("10 images were successfully"));
        assert!(build_analyze_warning(10, 10, 0, 10).is_none());
    }

    #[test]
    fn vision_response_text_requires_real_text_for_every_supported_shape() {
        let cases = [
            (
                serde_json::json!({"content": [{"type": "text", "text": "Anthropic text"}]}),
                true,
                false,
                false,
                "Anthropic text",
            ),
            (
                serde_json::json!({
                    "output": [{
                        "type": "message",
                        "content": [{"type": "output_text", "text": "Responses text"}],
                    }],
                }),
                false,
                true,
                false,
                "Responses text",
            ),
            (
                serde_json::json!({
                    "output": [{"type": "message", "content": "LM Studio text"}],
                }),
                false,
                false,
                true,
                "LM Studio text",
            ),
            (
                serde_json::json!({
                    "choices": [{"message": {"content": "Chat Completions text"}}],
                }),
                false,
                false,
                false,
                "Chat Completions text",
            ),
        ];

        for (json, is_anthropic, is_responses, is_lm_studio_rest, expected) in cases {
            assert_eq!(
                extract_vision_response_text(&json, is_anthropic, is_responses, is_lm_studio_rest,)
                    .as_deref(),
                Some(expected),
            );
        }

        for (is_anthropic, is_responses, is_lm_studio_rest) in [
            (true, false, false),
            (false, true, false),
            (false, false, true),
            (false, false, false),
        ] {
            assert_eq!(
                extract_vision_response_text(
                    &serde_json::json!({}),
                    is_anthropic,
                    is_responses,
                    is_lm_studio_rest,
                ),
                None,
            );
        }

        assert_eq!(
            extract_vision_response_text(
                &serde_json::json!({"choices": [{"message": {"content": "  "}}]}),
                false,
                false,
                false,
            ),
            None,
        );
    }

    #[test]
    fn vision_description_byte_cap_accepts_exact_and_rejects_plus_one() {
        let exact = "x".repeat(MAX_VISION_DESCRIPTION_BYTES);
        assert_eq!(
            bounded_vision_description(exact.clone(), 0, 1).unwrap(),
            exact
        );

        let oversized = format!("{}x", exact);
        let error = bounded_vision_description(oversized, 0, 1)
            .expect_err("description cap plus one must fail");
        assert!(matches!(error, ToolError::TooLarge(_)));
        assert!(error
            .to_string()
            .contains(&format!("{} UTF-8 bytes", MAX_VISION_DESCRIPTION_BYTES + 1)));
    }

    #[tokio::test]
    async fn bounded_vision_body_accepts_the_cap_and_rejects_cap_plus_one() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::TcpListener;

        for length in [32_usize, 33] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}", listener.local_addr().unwrap());
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = [0_u8; 1024];
                let _ = socket.read(&mut request).await.unwrap();
                let header = format!(
                    "HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                    length
                );
                socket.write_all(header.as_bytes()).await.unwrap();
                socket.write_all(&vec![b'x'; length]).await.unwrap();
            });

            let response = reqwest::get(url).await.unwrap();
            let result = read_bounded_vision_body(response, 32).await;
            server.await.unwrap();
            if length == 32 {
                assert_eq!(result.unwrap().len(), 32);
            } else {
                let error = result.expect_err("cap plus one must fail");
                assert!(matches!(error, ToolError::TooLarge(_)));
                assert!(error.to_string().contains("32-byte body limit"));
            }
        }
    }

    #[tokio::test]
    async fn bounded_vision_body_rejects_chunked_cap_plus_one_without_content_length() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::TcpListener;

        let length = MAX_VISION_RESPONSE_BYTES + 1;
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 1024];
            let _ = socket.read(&mut request).await.unwrap();
            socket
                .write_all(
                    b"HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\nconnection: close\r\n\r\n",
                )
                .await
                .unwrap();
            socket
                .write_all(format!("{:x}\r\n", length).as_bytes())
                .await
                .unwrap();
            socket.write_all(&vec![b'x'; length]).await.unwrap();
            socket.write_all(b"\r\n0\r\n\r\n").await.unwrap();
        });

        let response = reqwest::get(url).await.unwrap();
        assert_eq!(response.content_length(), None);
        let result = read_bounded_vision_body(response, MAX_VISION_RESPONSE_BYTES).await;
        server.await.unwrap();
        let error = result.expect_err("chunked cap plus one must fail while streaming");
        assert!(matches!(error, ToolError::TooLarge(_)));
        assert!(error
            .to_string()
            .contains(&format!("{}-byte body limit", MAX_VISION_RESPONSE_BYTES)));
    }

    #[tokio::test]
    async fn analyze_images_reports_a_successful_response_without_text_as_an_image_error() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::TcpListener;

        let root = tempdir();
        let image_path = root.join("no-text.png");
        image::RgbImage::new(2, 2).save(&image_path).unwrap();

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let server_url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 8192];
            let _ = socket.read(&mut request).await.unwrap();
            socket
                .write_all(
                    b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{}",
                )
                .await
                .unwrap();
        });

        let result = tool_analyze_images(AnalyzeImagesRequest {
            paths: vec![image_path.to_string_lossy().into_owned()],
            encoding: None,
            max_bytes: None,
            call_id: None,
            group_id: None,
            downscale: 1.0,
            allowed_roots: Some(roots_from(&root)),
            server_url,
            model: "vision-model".to_string(),
            api_key: None,
            api_variant: Some("openai".to_string()),
            api_style: Some("chat".to_string()),
            request_headers: Vec::new(),
            system_prompt: "Describe the image.".to_string(),
            user_instruction: None,
            max_tokens: None,
        })
        .await
        .expect("missing model text must remain an in-band per-image failure");

        server.await.unwrap();
        assert_eq!(result["analyzed"], false);
        assert!(result["description"].is_null());
        assert_eq!(result["analyzed_count"], 1);
        assert_eq!(result["described_count"], 0);
        assert!(result.get("warning").is_none());
        assert!(result["images"][0]["error"]
            .as_str()
            .unwrap()
            .contains("Vision model response contained no text"));

        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn analyze_images_does_not_send_local_paths_to_the_vision_provider() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::TcpListener;

        let root = tempdir().join("PRIVATE_VISION_PARENT");
        std::fs::create_dir_all(&root).unwrap();
        let image_path = root.join("PRIVATE_VISION_IMAGE.png");
        image::RgbImage::new(2, 2).save(&image_path).unwrap();
        let private_path = image_path.to_string_lossy().into_owned();

        let body = serde_json::json!({
            "choices": [{"message": {"content": "A small test image."}}]
        })
        .to_string();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let server_url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut chunk = [0_u8; 2048];
            loop {
                let bytes_read = socket.read(&mut chunk).await.unwrap();
                if bytes_read == 0 {
                    break;
                }
                request.extend_from_slice(&chunk[..bytes_read]);
                let Some(header_end) = request.windows(4).position(|window| window == b"\r\n\r\n")
                else {
                    continue;
                };
                let headers = String::from_utf8_lossy(&request[..header_end]);
                let content_length = headers.lines().find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().ok())
                        .flatten()
                });
                if content_length.is_some_and(|length| request.len() >= header_end + 4 + length) {
                    break;
                }
            }
            let request = String::from_utf8_lossy(&request).into_owned();
            let header = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                body.len()
            );
            socket.write_all(header.as_bytes()).await.unwrap();
            socket.write_all(body.as_bytes()).await.unwrap();
            request
        });

        let result = tool_analyze_images(AnalyzeImagesRequest {
            paths: vec![private_path.clone()],
            encoding: None,
            max_bytes: None,
            call_id: None,
            group_id: None,
            downscale: 1.0,
            allowed_roots: Some(roots_from(&root)),
            server_url,
            model: "vision-model".to_string(),
            api_key: None,
            api_variant: Some("openai".to_string()),
            api_style: Some("chat".to_string()),
            request_headers: Vec::new(),
            system_prompt: "Describe the image.".to_string(),
            user_instruction: Some("Inspect this image.".to_string()),
            max_tokens: None,
        })
        .await
        .expect("the provider response should produce a description");

        let request = server.await.unwrap();
        assert_eq!(result["analyzed"], true);
        assert!(request.contains("Inspect this image."));
        assert!(!request.contains(&private_path));
        assert!(!request.contains("PRIVATE_VISION_PARENT"));
        assert!(!request.contains("PRIVATE_VISION_IMAGE.png"));
        assert!(request.contains("Image 1 of 1"));

        std::fs::remove_dir_all(root.parent().unwrap()).unwrap();
    }

    #[tokio::test]
    async fn analyze_images_rejects_description_above_the_local_byte_cap() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::TcpListener;

        let root = tempdir();
        let image_path = root.join("oversized-description.png");
        image::RgbImage::new(2, 2).save(&image_path).unwrap();

        let text = "x".repeat(MAX_VISION_DESCRIPTION_BYTES + 1);
        let body = serde_json::json!({
            "choices": [{"message": {"content": text}}]
        })
        .to_string();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let server_url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 8192];
            let _ = socket.read(&mut request).await.unwrap();
            let header = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                body.len()
            );
            socket.write_all(header.as_bytes()).await.unwrap();
            socket.write_all(body.as_bytes()).await.unwrap();
        });

        let result = tool_analyze_images(AnalyzeImagesRequest {
            paths: vec![image_path.to_string_lossy().into_owned()],
            encoding: None,
            max_bytes: None,
            call_id: None,
            group_id: None,
            downscale: 1.0,
            allowed_roots: Some(roots_from(&root)),
            server_url,
            model: "vision-model".to_string(),
            api_key: None,
            api_variant: Some("openai".to_string()),
            api_style: Some("chat".to_string()),
            request_headers: Vec::new(),
            system_prompt: "Describe the image.".to_string(),
            user_instruction: None,
            max_tokens: Some(4_000),
        })
        .await
        .expect("an oversized description must remain an in-band image failure");

        server.await.unwrap();
        assert_eq!(result["analyzed"], false);
        assert_eq!(result["analyzed_count"], 1);
        assert_eq!(result["described_count"], 0);
        assert!(result["description"].is_null());
        let error = result["images"][0]["error"].as_str().unwrap();
        assert!(error.contains(&format!(
            "per-image limit is {} bytes",
            MAX_VISION_DESCRIPTION_BYTES
        )));
        assert!(error.len() < 512);

        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn analyze_images_reports_truncation_when_all_admitted_images_fail() {
        let root = tempdir();
        let result = tool_analyze_images(AnalyzeImagesRequest {
            paths: (0..11)
                .map(|index| {
                    root.join(format!("missing-{index}.png"))
                        .to_string_lossy()
                        .into_owned()
                })
                .collect(),
            encoding: None,
            max_bytes: None,
            call_id: None,
            group_id: None,
            downscale: 1.0,
            allowed_roots: Some(roots_from(&root)),
            server_url: "http://127.0.0.1:1".to_string(),
            model: "unused".to_string(),
            api_key: None,
            api_variant: None,
            api_style: None,
            request_headers: Vec::new(),
            system_prompt: "unused".to_string(),
            user_instruction: None,
            max_tokens: None,
        })
        .await
        .expect("encoding failures should remain in-band and avoid HTTP");

        assert_eq!(result["truncated"], true);
        assert_eq!(result["total_requested"], 11);
        assert_eq!(result["processed_count"], 10);
        assert_eq!(result["analyzed_count"], 0);
        assert_eq!(result["described_count"], 0);
        assert_eq!(result["dropped_count"], 1);
        assert_eq!(result["images"].as_array().unwrap().len(), 10);
        let warning = result["warning"].as_str().unwrap();
        assert!(warning.contains("None of the 10 processed images"));
        assert_eq!(result["analyzed"], false);
        assert!(result["description"].is_null());

        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn analyze_images_stops_while_the_vision_request_is_in_flight() {
        use tokio::net::TcpListener;
        use tokio::sync::oneshot;

        let root = tempdir();
        let image_path = root.join("cancel.png");
        image::RgbImage::new(2, 2).save(&image_path).unwrap();

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let server_url = format!("http://{}", listener.local_addr().unwrap());
        let (accepted_tx, accepted_rx) = oneshot::channel();
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let _ = accepted_tx.send(());
            std::future::pending::<()>().await;
            drop(socket);
        });

        let call_id = format!("analyze-cancel-call-{}", std::process::id());
        let group_id = format!("analyze-cancel-group-{}", std::process::id());
        let analysis = tokio::spawn(tool_analyze_images(AnalyzeImagesRequest {
            paths: vec![image_path.to_string_lossy().into_owned()],
            encoding: None,
            max_bytes: None,
            call_id: Some(call_id),
            group_id: Some(group_id.clone()),
            downscale: 1.0,
            allowed_roots: Some(roots_from(&root)),
            server_url,
            model: "test-vision-model".to_string(),
            api_key: None,
            api_variant: None,
            api_style: None,
            request_headers: Vec::new(),
            system_prompt: "test".to_string(),
            user_instruction: None,
            max_tokens: None,
        }));

        tokio::time::timeout(std::time::Duration::from_secs(5), accepted_rx)
            .await
            .expect("vision request did not reach the test server")
            .expect("test server closed before accepting the request");
        assert_eq!(
            super::super::registry::abort_group(group_id).await.unwrap(),
            1
        );

        let result = tokio::time::timeout(std::time::Duration::from_secs(1), analysis)
            .await
            .expect("cancelled image analysis did not settle promptly")
            .expect("image analysis task panicked");
        assert!(matches!(result, Err(ToolError::Aborted)));

        server.abort();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn image_delivery_rejects_more_than_twenty_paths() {
        let error = tool_read_image(ReadImageRequest {
            paths: (0..21).map(|index| format!("{index}.png")).collect(),
            max_bytes: None,
            encoding: None,
            downscale: 1.0,
            allowed_roots: Some(Vec::new()),
        })
        .await
        .expect_err("delivery cardinality must fail the call");
        assert!(error.to_string().contains("max 20"));
    }

    #[test]
    fn decoded_image_dimensions_are_checked_before_downscale() {
        let root = tempdir();
        let path = root.join("two-by-two.png");
        image::RgbImage::new(2, 2).save(&path).unwrap();
        let result = read_single_image(
            path.to_str().unwrap(),
            std::slice::from_ref(&root),
            DEFAULT_IMAGE_INPUT_BYTES,
            "original",
            0.1,
            MAX_IMAGE_PIXELS,
            1,
        );
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("exceed max dimension"));
        std::fs::remove_dir_all(root).unwrap();
    }

    /* ============================================================ */

    fn resolve_ok(child: &str, roots: &[PathBuf]) -> PathBuf {
        resolve_under_roots(child, roots).expect("expected Ok")
    }

    fn resolve_err(child: &str, roots: &[PathBuf]) -> ToolError {
        resolve_under_roots(child, roots).expect_err("expected Err")
    }

    /* ---------------- 1. Normal path inside root ------------------- */

    #[test]
    fn normal_path_inside_root_succeeds() {
        let root = tempdir();
        let file = root.join("a.txt");
        std::fs::write(&file, "hello").unwrap();
        let p = resolve_ok(file.to_str().unwrap(), std::slice::from_ref(&root));
        assert_eq!(p.file_name().unwrap(), "a.txt");
    }

    #[tokio::test]
    async fn read_file_streams_large_source_for_focused_range() {
        let root = tempdir();
        let file = root.join("large.txt");
        let mut content = String::new();
        for _ in 0..200_000 {
            content.push_str("padding\n");
        }
        content.push_str("target\n");
        assert!(content.len() > 1024 * 1024);
        std::fs::write(&file, &content).unwrap();

        let result = tool_read_file(ReadFileRequest {
            paths: vec![file.to_string_lossy().into_owned()],
            start_line: Some(200_001),
            end_line: Some(200_001),
            // The source is larger than this cap, but the selected range fits.
            max_bytes: Some(64),
            allowed_roots: Some(roots_from(&root)),
            call_id: None,
            group_id: None,
        })
        .await
        .expect("expected Ok");
        let entry = &result["results"][0];

        assert_eq!(entry["content"], "target");
        assert_eq!(entry["total_lines"], 200_001);
        assert_eq!(entry["size_bytes"], content.len());
        assert!(entry["sha256"]
            .as_str()
            .is_some_and(|hash| hash.len() == 64));
        assert!(entry.get("error").is_none());

        let full_read = tool_read_file(ReadFileRequest {
            paths: vec![file.to_string_lossy().into_owned()],
            start_line: None,
            end_line: None,
            max_bytes: Some(64),
            allowed_roots: Some(roots_from(&root)),
            call_id: None,
            group_id: None,
        })
        .await
        .expect("expected Ok");
        assert!(full_read["results"][0]["error"]
            .as_str()
            .is_some_and(|error| error.contains("bytes > max 64 bytes")));
    }

    #[test]
    fn cancellable_reader_stops_at_the_next_fixed_size_chunk() {
        struct CancelReader {
            token: CancellationToken,
            emitted: bool,
        }

        impl Read for CancelReader {
            fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
                if self.emitted {
                    return Ok(0);
                }
                self.emitted = true;
                let count = output.len().min(1024);
                output[..count].fill(b'x');
                self.token.cancel();
                Ok(count)
            }
        }

        let token = CancellationToken::new();
        let error = read_cancellable(
            CancelReader {
                token: token.clone(),
                emitted: false,
            },
            128 * 1024,
            Some(&token),
            || {},
        )
        .unwrap_err();

        assert_eq!(error.kind(), std::io::ErrorKind::Interrupted);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn abort_group_stops_an_active_native_file_read() {
        let root = tempdir();
        let file = root.join("multi-chunk.txt");
        std::fs::write(&file, vec![b'x'; 3 * 64 * 1024]).unwrap();
        let canonical = canonicalize_allow_missing(&file.to_string_lossy()).unwrap();
        let checkpoint = super::super::registry::test_support::BlockingCheckpoint::install(
            read_chunk_checkpoint_key(&canonical),
        );

        let call_id = format!("test-read-abort-{:016x}", rand::random::<u64>());
        let group_id = format!("test-read-group-{:016x}", rand::random::<u64>());
        let requested_path = file.to_string_lossy().into_owned();
        let task = tokio::spawn(tool_read_file(ReadFileRequest {
            paths: vec![requested_path],
            start_line: None,
            end_line: None,
            max_bytes: Some(HARD_CAP_READ_BYTES),
            allowed_roots: Some(roots_from(&root)),
            call_id: Some(call_id.clone()),
            group_id: Some(group_id.clone()),
        }));

        assert!(
            checkpoint.wait_for_hits(1, std::time::Duration::from_secs(5)),
            "native read never completed its first 64 KiB chunk"
        );
        assert_eq!(
            super::super::registry::abort_group(group_id).await.unwrap(),
            1,
            "active read was not registered under its execution group"
        );
        checkpoint.release();

        let outcome = tokio::time::timeout(std::time::Duration::from_secs(5), task)
            .await
            .expect("cancelled file read should settle promptly")
            .expect("file read task should not panic");
        assert!(
            matches!(outcome, Err(ToolError::Aborted)),
            "got {outcome:?}"
        );
        assert_eq!(
            checkpoint.hits(),
            1,
            "native read continued into another chunk after group abort"
        );
        assert!(
            !super::super::registry::registry()
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .contains_key(&call_id),
            "settled read left a registry entry behind"
        );
    }

    #[test]
    fn ranged_reader_keeps_utf8_across_chunks_and_bounds_one_hostile_line() {
        let root = tempdir();
        let file = root.join("chunk-boundary.txt");
        let first_line = format!("{}😀", "a".repeat(8191));
        let content = format!("{first_line}\n{}\n", "tail".repeat(5000));
        std::fs::write(&file, content).unwrap();

        let entry = read_single_file(
            file.to_str().unwrap(),
            std::slice::from_ref(&root),
            Some(1),
            Some(1),
            Some(9_000),
        );
        assert_eq!(entry["content"], first_line);

        let hostile = root.join("hostile-line.txt");
        std::fs::write(&hostile, vec![b'x'; 4 * 1024 * 1024]).unwrap();
        let rejected = read_single_file(
            hostile.to_str().unwrap(),
            std::slice::from_ref(&root),
            Some(1),
            Some(1),
            Some(64),
        );
        assert_eq!(rejected["error_code"], "too_large");
    }

    #[test]
    fn read_file_default_cap_errors_without_partial_content() {
        let root = tempdir();
        let file = root.join("over-default.txt");
        std::fs::write(&file, vec![b'x'; 1024 * 1024 + 1]).unwrap();
        let entry = read_single_file(
            file.to_str().unwrap(),
            std::slice::from_ref(&root),
            None,
            None,
            None,
        );
        assert!(entry["error"]
            .as_str()
            .unwrap()
            .contains("max 1048576 bytes"));
        assert_eq!(entry["error_code"], "too_large");
        assert_eq!(entry["content"], "");
        assert_eq!(entry["truncated"], false);
        std::fs::remove_dir_all(root).unwrap();
    }

    // ── UTF-16 transcoding ──────────────────────────────────────────

    fn utf16_bytes(text: &str, kind: Utf16Kind) -> Vec<u8> {
        let mut bytes = match kind {
            Utf16Kind::Le => vec![0xFF, 0xFE],
            Utf16Kind::Be => vec![0xFE, 0xFF],
        };
        for unit in text.encode_utf16() {
            match kind {
                Utf16Kind::Le => bytes.extend_from_slice(&unit.to_le_bytes()),
                Utf16Kind::Be => bytes.extend_from_slice(&unit.to_be_bytes()),
            }
        }
        bytes
    }

    /// UTF-32 marks start with the same bytes as UTF-16 ones; only a
    /// length check separates them, and they must stay binary.
    #[test]
    fn utf16_bom_detection_distinguishes_utf32() {
        assert_eq!(utf16_bom(&utf16_bytes("x", Utf16Kind::Le)), Some(Utf16Kind::Le));
        assert_eq!(utf16_bom(&utf16_bytes("x", Utf16Kind::Be)), Some(Utf16Kind::Be));
        assert_eq!(utf16_bom(&[0xFF, 0xFE, 0x00, 0x00, 0x31]), None);
        assert_eq!(utf16_bom(&[0x00, 0x00, 0xFE, 0xFF, 0x00]), None);
        assert_eq!(utf16_bom(b"plain utf-8"), None);
    }

    #[test]
    fn utf16_decode_roundtrip_including_surrogate_pairs() {
        let text = "needle caf\u{e9} \u{10437} end";
        for kind in [Utf16Kind::Le, Utf16Kind::Be] {
            let bytes = utf16_bytes(text, kind);
            let decoded =
                decode_utf16(&bytes[2..], kind).expect("valid stream must decode");
            assert_eq!(decoded, text, "{kind:?}");
        }
    }

    /// A malformed stream must be refused, not silently patched: an odd
    /// trailing byte or an unpaired surrogate would corrupt on write-back.
    #[test]
    fn utf16_decode_rejects_malformed_streams() {
        let mut odd = utf16_bytes("abc", Utf16Kind::Le);
        odd.push(b'x');
        assert_eq!(decode_utf16(&odd[2..], Utf16Kind::Le), None);
        // High surrogate with no low surrogate after it.
        let lone = vec![0x00, 0xD8, 0x41, 0x00];
        assert_eq!(decode_utf16(&lone, Utf16Kind::Le), None);
    }

    #[test]
    fn read_text_transcodes_bom_marked_utf16_and_refuses_the_rest() {
        let (text, origin) = read_text(&utf16_bytes("héllo", Utf16Kind::Le)).unwrap();
        assert_eq!(text, "héllo");
        assert_eq!(origin, TextOrigin::Transcoded(Utf16Kind::Le));

        let (text, origin) = read_text(b"plain").unwrap();
        assert_eq!(text, "plain");
        assert_eq!(origin, TextOrigin::Utf8);

        assert_eq!(read_text(b"caf\xe9"), Err(NotText::NotUtf8));
        // BOM-less UTF-16: NULs in the window, no mark to transcode.
        assert_eq!(read_text(&utf16_bytes("x", Utf16Kind::Le)[2..]), Err(NotText::Binary));
    }

    #[test]
    fn read_single_file_transcodes_utf16le_and_hashes_raw_bytes() {
        let root = tempdir();
        let file = root.join("log.txt");
        let raw = utf16_bytes("one needle\ntwo\n", Utf16Kind::Le);
        std::fs::write(&file, &raw).unwrap();

        let entry = read_single_file(
            file.to_str().unwrap(),
            std::slice::from_ref(&root),
            None,
            None,
            None,
        );

        assert!(entry.get("error").is_none(), "{entry}");
        assert_eq!(entry["content"].as_str().unwrap(), "one needle\ntwo\n");
        assert_eq!(entry["encoding"].as_str().unwrap(), "utf-16le");
        assert_eq!(entry["total_lines"].as_u64().unwrap(), 2);
        // The hash describes the file on disk, transcoding included.
        let expected = {
            let mut hasher = Sha256::new();
            hasher.update(&raw);
            hasher.finalize().iter().map(|b| format!("{:02x}", b)).collect::<String>()
        };
        assert_eq!(entry["sha256"].as_str().unwrap(), expected);
        std::fs::remove_dir_all(root).unwrap();
    }

    /// A ranged read from a UTF-16 source larger than the in-memory cap
    /// transcodes and selects lines by their transcoded numbering.
    #[test]
    fn ranged_read_from_large_utf16_file_transcodes() {
        let root = tempdir();
        let file = root.join("big.log");
        let body: String = (0..60_000).map(|i| format!("line {i:05}\n")).collect();
        let raw = utf16_bytes(&body, Utf16Kind::Be);
        assert!(raw.len() as u64 > DEFAULT_READ_BYTES, "source must exceed the cap");
        std::fs::write(&file, &raw).unwrap();

        let entry = read_single_file(
            file.to_str().unwrap(),
            std::slice::from_ref(&root),
            Some(3),
            Some(4),
            None,
        );

        assert!(entry.get("error").is_none(), "{entry}");
        assert_eq!(entry["content"].as_str().unwrap(), "line 00002\nline 00003");
        assert_eq!(entry["encoding"].as_str().unwrap(), "utf-16be");
        assert_eq!(entry["total_lines"].as_u64().unwrap(), 60_000);
        assert_eq!(entry["size_bytes"].as_u64().unwrap(), raw.len() as u64);
        std::fs::remove_dir_all(root).unwrap();
    }

    /* ---------------- 2. Path outside root ------------------------- */

    #[test]
    fn path_outside_root_fails() {
        let root = tempdir();
        let outside =
            std::env::temp_dir().join(format!("lc-fs-ops-outside-{}.txt", std::process::id()));
        std::fs::write(&outside, "x").unwrap();
        let err = resolve_err(outside.to_str().unwrap(), &[root]);
        assert!(
            matches!(err, ToolError::PathOutsideRoots { .. }),
            "got {:?}",
            err
        );
        std::fs::remove_file(&outside).ok();
    }

    /* ---------------- 3. Sibling-folder hijack --------------------- */

    /// The famous attack from Gemini v2 §2. The naive Windows
    /// implementation used string `starts_with` on lowercased paths
    /// and would have succeeded for `projects-secret/...` against
    /// root `projects`. The component-aware `path_starts_with_ci`
    /// must reject it.
    #[test]
    #[cfg(target_os = "windows")]
    fn sibling_folder_hijack_windows() {
        // Clean up any leftover from previous runs.
        let base = std::env::temp_dir();
        let root = base.join(format!("lc-fs-root-{}", std::process::id()));
        let sibling = base.join(format!("lc-fs-sibling-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&sibling).unwrap();
        let target = sibling.join("passwords.txt");
        std::fs::write(&target, "secret").unwrap();

        let err = resolve_err(target.to_str().unwrap(), std::slice::from_ref(&root));
        assert!(
            matches!(err, ToolError::PathOutsideRoots { .. }),
            "sibling-folder attack must be rejected, got {:?}",
            err
        );

        std::fs::remove_dir_all(&root).ok();
        std::fs::remove_dir_all(&sibling).ok();
    }

    /* ---------------- 4. `..` traversal that resolves INSIDE root -- */

    #[test]
    fn dotdot_inside_root_succeeds() {
        let root = tempdir();
        let sub = root.join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        let file = root.join("a.txt");
        std::fs::write(&file, "x").unwrap();
        // `sub/../a.txt` resolves to `a.txt` which is inside root.
        let traversal = sub.join("..").join("a.txt");
        let p = resolve_ok(traversal.to_str().unwrap(), std::slice::from_ref(&root));
        assert_eq!(p.file_name().unwrap(), "a.txt");
    }

    /* ---------------- 5. `..` traversal that resolves OUTSIDE root -- */

    #[test]
    fn dotdot_outside_root_fails() {
        let root = tempdir();
        let outside =
            std::env::temp_dir().join(format!("lc-fs-ops-dotdot-out-{}.txt", std::process::id()));
        std::fs::write(&outside, "x").unwrap();
        let traversal = root.join("..").join(outside.file_name().unwrap());
        let err = resolve_err(traversal.to_str().unwrap(), &[root]);
        assert!(
            matches!(err, ToolError::PathOutsideRoots { .. }),
            "got {:?}",
            err
        );
        std::fs::remove_file(&outside).ok();
    }

    #[test]
    fn dotdot_after_missing_component_cannot_escape_root() {
        let root = tempdir();
        let traversal = root
            .join("missing")
            .join("..")
            .join("..")
            .join("outside")
            .join("file.txt");
        let err = resolve_err(traversal.to_str().unwrap(), &[root]);
        assert!(
            matches!(err, ToolError::PathOutsideRoots { .. }),
            "missing-tail traversal must be rejected, got {:?}",
            err
        );
    }

    /* ---------------- 6. Symlink escape ---------------------------- */

    #[cfg(target_os = "windows")]
    fn local_path_as_admin_unc(path: &Path) -> PathBuf {
        let canonical = strip_unc(&std::fs::canonicalize(path).unwrap());
        let raw = canonical.to_string_lossy();
        let mut chars = raw.chars();
        let drive = chars.next().expect("Windows path must have a drive");
        assert_eq!(chars.next(), Some(':'));
        assert_eq!(chars.next(), Some('\\'));
        let tail: String = chars.collect();
        PathBuf::from(format!(r"\\localhost\{}$\{}", drive, tail))
    }

    #[cfg(target_os = "windows")]
    fn as_extended_unc(path: &Path) -> PathBuf {
        let raw = path.to_string_lossy();
        let tail = raw
            .strip_prefix(r"\\")
            .expect("normal UNC path must start with two separators");
        PathBuf::from(format!(r"\\?\UNC\{}", tail))
    }

    #[cfg(unix)]
    #[test]
    fn symlink_escape_fails_unix() {
        let root = tempdir();
        let outside =
            std::env::temp_dir().join(format!("lc-fs-ops-sym-out-{}.txt", std::process::id()));
        std::fs::write(&outside, "x").unwrap();
        let link = root.join("link");
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        let identity = tool_resolve_path(CheckPathRequest {
            path: link.to_string_lossy().to_string(),
            allowed_roots: None,
        })
        .unwrap();
        assert_eq!(
            PathBuf::from(identity["canonical"].as_str().unwrap()),
            std::fs::canonicalize(&outside).unwrap()
        );
        let err = resolve_err(link.to_str().unwrap(), &[root]);
        assert!(
            matches!(err, ToolError::PathOutsideRoots { .. }),
            "symlink must be followed, got {:?}",
            err
        );
        std::fs::remove_file(&outside).ok();
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn symlink_escape_fails_windows() {
        let root = tempdir();
        let outside =
            std::env::temp_dir().join(format!("lc-fs-ops-sym-out-{}.txt", std::process::id()));
        std::fs::write(&outside, "x").unwrap();
        let local_link = root.join("link");
        let (link, allowed_root) = match std::os::windows::fs::symlink_file(&outside, &local_link) {
            Ok(()) => (local_link, root),
            Err(local_error) => {
                let unc_root = local_path_as_admin_unc(&root);
                let unc_outside = local_path_as_admin_unc(&outside);
                let unc_link = unc_root.join("link");
                std::os::windows::fs::symlink_file(&unc_outside, &unc_link).unwrap_or_else(
                    |unc_error| {
                        std::fs::remove_file(&outside).ok();
                        std::fs::remove_dir(&root).ok();
                        panic!(
                            "required Windows symlink setup failed locally ({local_error}) and through the administrative UNC share ({unc_error})"
                        )
                    },
                );
                (unc_link, unc_root)
            }
        };
        let identity = tool_resolve_path(CheckPathRequest {
            path: link.to_string_lossy().to_string(),
            allowed_roots: None,
        })
        .unwrap();
        assert_eq!(
            PathBuf::from(identity["canonical"].as_str().unwrap()),
            strip_unc(&std::fs::canonicalize(&outside).unwrap())
        );
        let err = resolve_err(link.to_str().unwrap(), &[allowed_root]);
        assert!(
            matches!(err, ToolError::PathOutsideRoots { .. }),
            "symlink must be followed, got {:?}",
            err
        );
        std::fs::remove_file(&link).unwrap();
        std::fs::remove_file(&outside).ok();
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn junction_escape_fails_windows() {
        let root = tempdir();
        let outside = std::env::temp_dir().join(format!(
            "lc-fs-ops-junction-out-{}-{:016x}",
            std::process::id(),
            rand::random::<u64>()
        ));
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret.txt"), "secret").unwrap();
        let junction = root.join("junction");
        let status = std::process::Command::new("cmd")
            .args(["/d", "/c", "mklink", "/J"])
            .arg(&junction)
            .arg(&outside)
            .status()
            .unwrap();
        assert!(status.success(), "could not create a test junction");

        let err = resolve_err(
            junction.join("secret.txt").to_str().unwrap(),
            std::slice::from_ref(&root),
        );
        assert!(matches!(err, ToolError::PathOutsideRoots { .. }));

        std::fs::remove_dir(&junction).unwrap();
        std::fs::remove_dir_all(&outside).unwrap();
    }

    /* ---------------- 7. Non-existent path with no resolvable ancestor ---- */

    /// `tool_write_file` in `mode='create'` is allowed to write to a
    /// path whose file doesn't exist yet, as long as its parent is
    /// inside a root. So we test the *real* NotFound case: a
    /// relative-style path with no existing ancestor anywhere on
    /// disk (or only the FS root, which isn't in any allowed root).
    #[test]
    fn nonexistent_with_no_existing_ancestor_fails() {
        let root = tempdir();
        let err = resolve_err(
            "this-relative-path-has-no-existing-ancestor-anywhere/file.txt",
            &[root],
        );
        assert!(matches!(err, ToolError::NotFound(_)), "got {:?}", err);
    }

    /* ---------------- 7b. Non-existing file in existing dir SUCCEEDS ---- */

    /// `tool_write_file mode='create'` needs this: resolve a path
    /// whose file doesn't exist yet but whose parent is inside root.
    /// The function walks up to the deepest existing ancestor and
    /// returns the canonical ancestor + the missing tail components.
    #[test]
    fn nonexistent_file_in_existing_dir_succeeds() {
        let root = tempdir();
        let future = root.join("about-to-be-created.txt");
        assert!(!future.exists());
        let p = resolve_ok(future.to_str().unwrap(), std::slice::from_ref(&root));
        assert_eq!(p.file_name().unwrap(), "about-to-be-created.txt");
        // We didn't actually create the file — resolve is read-only.
        assert!(!p.exists());
    }

    #[test]
    fn permission_identity_rebuilds_missing_create_target() {
        let root = tempdir();
        let future = root.join("missing").join("nested").join("file.txt");
        let result = tool_resolve_path(CheckPathRequest {
            path: future.to_string_lossy().to_string(),
            allowed_roots: None,
        })
        .unwrap();
        let expected = strip_unc(&std::fs::canonicalize(&root).unwrap())
            .join("missing")
            .join("nested")
            .join("file.txt");
        assert_eq!(
            PathBuf::from(result["canonical"].as_str().unwrap()),
            expected
        );
        assert_eq!(result["exists"], false);
    }

    /* ---------------- 8. Windows: mixed case ------------------------ */

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_mixed_case_succeeds() {
        let root = tempdir();
        let file = root.join("A.txt");
        std::fs::write(&file, "x").unwrap();
        // Mixed case: a.TXT vs A.txt.
        let mixed = root.join("a.TXT");
        let p = resolve_ok(mixed.to_str().unwrap(), &[root]);
        assert_eq!(p.file_name().unwrap().to_ascii_lowercase(), "a.txt");
    }

    /* ---------------- 9. Windows: UNC prefix `\\?\C:\...` ---------- */

    /// `std::fs::canonicalize` always prepends `\\?\` on Windows. The
    /// post-canonicalize path must round-trip cleanly through
    /// `strip_unc` so containment checks against plain-C:-style roots
    /// actually match.
    #[cfg(target_os = "windows")]
    #[test]
    fn windows_unc_prefix_succeeds() {
        let raw = PathBuf::from(r"\\?\C:\Users\me\file.txt");
        let stripped = strip_unc(&raw);
        assert_eq!(stripped, PathBuf::from(r"C:\Users\me\file.txt"));
    }

    /* ---------------- 10. Windows: UNC network `\\?\UNC\...` ------- */

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_unc_network_succeeds() {
        let raw = PathBuf::from(r"\\?\UNC\host\share\dir");
        let stripped = strip_unc(&raw);
        assert_eq!(stripped, PathBuf::from(r"\\host\share\dir"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_unc_paths_cross_the_production_resolver() {
        let root = tempdir();
        let inside = root.join("inside.txt");
        std::fs::write(&inside, "inside").unwrap();
        let outside = root.parent().unwrap().join(format!(
            "lc-fs-ops-unc-out-{}-{:016x}.txt",
            std::process::id(),
            rand::random::<u64>()
        ));
        std::fs::write(&outside, "outside").unwrap();

        let unc_root = local_path_as_admin_unc(&root);
        let unc_inside = local_path_as_admin_unc(&inside);
        let unc_outside = local_path_as_admin_unc(&outside);
        assert!(
            unc_root.exists(),
            "required local administrative UNC share is unavailable: {}",
            unc_root.display()
        );

        let normal = resolve_ok(
            &unc_inside.to_string_lossy(),
            std::slice::from_ref(&unc_root),
        );
        assert_eq!(
            normal,
            strip_unc(&std::fs::canonicalize(&unc_inside).unwrap())
        );

        let extended_root = as_extended_unc(&unc_root);
        let extended_inside = as_extended_unc(&unc_inside);
        let extended = resolve_ok(
            &extended_inside.to_string_lossy(),
            std::slice::from_ref(&extended_root),
        );
        assert_eq!(extended, normal);

        for (path, roots) in [
            (unc_outside.clone(), vec![unc_root]),
            (as_extended_unc(&unc_outside), vec![extended_root]),
        ] {
            let error = resolve_err(&path.to_string_lossy(), &roots);
            assert!(
                matches!(error, ToolError::PathOutsideRoots { .. }),
                "UNC sibling escaped its granted root: {error:?}"
            );
        }

        std::fs::remove_file(outside).unwrap();
    }

    /* ---------------- 11. Empty roots list (handoff notes M3-4.5) -- */

    #[test]
    fn empty_roots_rejects_everything() {
        let root = tempdir();
        let file = root.join("a.txt");
        std::fs::write(&file, "x").unwrap();
        let err = resolve_err(file.to_str().unwrap(), &[]);
        assert!(
            matches!(err, ToolError::PathOutsideRoots { .. }),
            "empty roots must reject every existing path, got {:?}",
            err
        );
    }

    /* ============================================================ */
    /*  list_dir pattern matching unit tests                        */
    /* ============================================================ */

    /// Compile a `list_dir` pattern the same way `tool_list_dir` does.
    fn pat(pattern: &str) -> globset::GlobSet {
        build_glob_set(&expand_braces(pattern)).expect("valid pattern")
    }

    #[test]
    fn glob_star_matches_zero_or_more_chars() {
        assert!(pat("*.txt").is_match("foo.txt"));
        assert!(pat("*.txt").is_match(".txt")); // `*` matches empty too
        assert!(pat("a*").is_match("abc"));
        assert!(pat("a*").is_match("a"));
        assert!(!pat("*.txt").is_match("foo.rs"));
    }

    #[test]
    fn glob_question_matches_exactly_one_char() {
        assert!(pat("a?c").is_match("abc"));
        assert!(!pat("a?c").is_match("ac")); // 0 chars
        assert!(!pat("a?c").is_match("abbc")); // 2 chars
    }

    #[test]
    fn glob_literal_chars() {
        assert!(pat("README.md").is_match("README.md"));
        assert!(!pat("README.md").is_match("readme.md"));
        assert!(!pat("README.md").is_match("README.tx"));
    }

    /// The documented `"*.{py,js}"` form must actually work — it used to
    /// be treated as literal braces and silently matched nothing.
    #[test]
    fn glob_supports_brace_expansion() {
        let p = pat("*.{py,js}");
        assert!(p.is_match("setup.py"));
        assert!(p.is_match("app.js"));
        assert!(!p.is_match("notes.md"));
    }

    #[test]
    fn glob_supports_character_classes() {
        let p = pat("*.[jt]s");
        assert!(p.is_match("app.ts"));
        assert!(p.is_match("app.js"));
        assert!(!p.is_match("app.rs"));
    }

    #[test]
    fn invalid_pattern_is_rejected_not_silently_empty() {
        assert!(build_glob_set(&expand_braces("[")).is_err());
    }

    #[tokio::test]
    async fn list_dir_brace_pattern_matches_both_extensions() {
        let root = tempdir();
        std::fs::write(root.join("a.py"), "x").unwrap();
        std::fs::write(root.join("b.js"), "x").unwrap();
        std::fs::write(root.join("c.md"), "x").unwrap();

        let r = tool_list_dir(ListDirRequest {
            paths: vec![root.to_str().unwrap().to_string()],
            pattern: Some("*.{py,js}".to_string()),
            include_hidden: None,
            max_entries: None,
            allowed_roots: Some(vec![root.to_str().unwrap().to_string()]),
        })
        .await
        .expect("expected Ok");
        let names: Vec<String> = r["results"][0]["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["name"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(names.len(), 2, "got {:?}", names);
        assert!(names.contains(&"a.py".to_string()), "got {:?}", names);
        assert!(names.contains(&"b.js".to_string()), "got {:?}", names);
    }

    #[tokio::test]
    async fn list_dir_invalid_pattern_errors() {
        let root = tempdir();
        std::fs::write(root.join("a.py"), "x").unwrap();

        let r = tool_list_dir(ListDirRequest {
            paths: vec![root.to_str().unwrap().to_string()],
            pattern: Some("[".to_string()),
            include_hidden: None,
            max_entries: None,
            allowed_roots: Some(vec![root.to_str().unwrap().to_string()]),
        })
        .await;
        assert!(r.is_err(), "invalid glob must fail the call");
    }

    #[tokio::test]
    async fn list_dir_whitespace_pattern_is_treated_as_unfiltered() {
        let root = tempdir();
        std::fs::write(root.join("a.py"), "x").unwrap();
        std::fs::write(root.join("b.js"), "x").unwrap();

        let r = tool_list_dir(ListDirRequest {
            paths: vec![root.to_str().unwrap().to_string()],
            pattern: Some("   ".to_string()),
            include_hidden: None,
            max_entries: None,
            allowed_roots: Some(vec![root.to_str().unwrap().to_string()]),
        })
        .await
        .expect("expected Ok");
        let names: Vec<String> = r["results"][0]["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["name"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(names.len(), 2, "whitespace pattern must not filter entries");
    }

    /* ============================================================ */
    /*  tool_list_dir tests                                         */
    /* ============================================================ */

    async fn list(
        path: &std::path::Path,
        roots: Vec<String>,
        pattern: Option<&str>,
        hidden: Option<bool>,
        max: Option<u32>,
    ) -> serde_json::Value {
        let r = tool_list_dir(ListDirRequest {
            paths: vec![path.to_str().unwrap().to_string()],
            pattern: pattern.map(String::from),
            include_hidden: hidden,
            max_entries: max,
            allowed_roots: Some(roots),
        })
        .await
        .expect("expected Ok");
        // Batch format: {"results": [...]}. Extract the first (only) entry.
        r["results"][0].clone()
    }

    #[tokio::test]
    async fn list_dir_empty_returns_no_entries() {
        let root = tempdir();
        let r = list(&root, roots_from(&root), None, None, None).await;
        assert_eq!(r["entries"].as_array().unwrap().len(), 0);
        assert_eq!(r["truncated"], false);
    }

    #[tokio::test]
    async fn list_dir_lists_files_and_dirs_with_kinds_and_sizes() {
        let root = tempdir();
        std::fs::write(root.join("a.txt"), "hi").unwrap();
        std::fs::create_dir(root.join("sub")).unwrap();

        let r = list(&root, roots_from(&root), None, None, None).await;
        let entries = r["entries"].as_array().unwrap();
        assert_eq!(entries.len(), 2);

        let a = entries.iter().find(|e| e["name"] == "a.txt").unwrap();
        assert_eq!(a["kind"], "file");
        assert_eq!(a["size"], 2);
        assert!(a["mtime"].is_number(), "mtime should be present for files");

        let sub = entries.iter().find(|e| e["name"] == "sub").unwrap();
        assert_eq!(sub["kind"], "dir");
        assert!(sub.get("size").is_none(), "dirs should not report size");
    }

    #[tokio::test]
    async fn list_dir_excludes_hidden_by_default() {
        let root = tempdir();
        std::fs::write(root.join("visible.txt"), "v").unwrap();
        std::fs::write(root.join(".hidden"), "h").unwrap();

        let r = list(&root, roots_from(&root), None, None, None).await;
        let entries = r["entries"].as_array().unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["name"], "visible.txt");
    }

    #[tokio::test]
    async fn list_dir_includes_hidden_when_requested() {
        let root = tempdir();
        std::fs::write(root.join("visible.txt"), "v").unwrap();
        std::fs::write(root.join(".hidden"), "h").unwrap();

        let r = list(&root, roots_from(&root), None, Some(true), None).await;
        let entries = r["entries"].as_array().unwrap();
        assert_eq!(entries.len(), 2);
    }

    #[tokio::test]
    async fn list_dir_filters_by_glob_pattern() {
        let root = tempdir();
        std::fs::write(root.join("a.ts"), "").unwrap();
        std::fs::write(root.join("b.txt"), "").unwrap();
        std::fs::write(root.join("c.tsx"), "").unwrap();

        let r = list(&root, roots_from(&root), Some("*.ts"), None, None).await;
        let entries = r["entries"].as_array().unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["name"], "a.ts");
    }

    #[tokio::test]
    async fn list_dir_truncates_at_max_entries() {
        let root = tempdir();
        for i in 0..10 {
            std::fs::write(root.join(format!("f{}.txt", i)), "").unwrap();
        }

        let r = list(&root, roots_from(&root), None, None, Some(3)).await;
        assert_eq!(r["entries"].as_array().unwrap().len(), 3);
        assert_eq!(r["truncated"], true);
    }

    #[tokio::test]
    async fn list_dir_exact_max_is_not_truncated() {
        let root = tempdir();
        for i in 0..3 {
            std::fs::write(root.join(format!("f{}.txt", i)), "").unwrap();
        }

        let r = list(&root, roots_from(&root), None, None, Some(3)).await;
        assert_eq!(r["entries"].as_array().unwrap().len(), 3);
        assert_eq!(r["truncated"], false);
    }

    #[tokio::test]
    async fn list_dir_rejects_file_path() {
        let root = tempdir();
        let file = root.join("not-a-dir.txt");
        std::fs::write(&file, "x").unwrap();

        // Batch API: errors are in-band inside results[0].error.
        let r = tool_list_dir(ListDirRequest {
            paths: vec![file.to_str().unwrap().to_string()],
            pattern: None,
            include_hidden: None,
            max_entries: None,
            allowed_roots: Some(roots_from(&root)),
        })
        .await
        .expect("expected Ok");
        let err = r["results"][0]["error"].as_str().unwrap();
        assert!(err.contains("not a directory"), "got {}", err);
        // Error entries carry the tool's declared shape: `entries` present
        // and empty, no read_file-only fields.
        let entry = &r["results"][0];
        assert!(entry["entries"].is_array(), "got {}", entry);
        assert_eq!(entry["entries"].as_array().unwrap().len(), 0);
        assert!(entry.get("content").is_none(), "got {}", entry);
        assert!(entry.get("total_lines").is_none(), "got {}", entry);
        assert_eq!(entry["truncated"], false);
    }

    #[tokio::test]
    async fn list_dir_rejects_path_outside_default_roots() {
        let root = tempdir();
        let file = root.join("not-a-dir.txt");
        std::fs::write(&file, "x").unwrap();

        // Empty roots → path_outside_roots error in-band.
        let r = tool_list_dir(ListDirRequest {
            paths: vec![file.to_str().unwrap().to_string()],
            pattern: None,
            include_hidden: None,
            max_entries: None,
            allowed_roots: None,
        })
        .await
        .expect("expected Ok");
        let err = r["results"][0]["error"].as_str().unwrap();
        assert!(err.contains("path_outside_roots"), "got {}", err);
        // Error entries carry the tool's declared shape: `entries` present
        // and empty, no read_file-only fields.
        let entry = &r["results"][0];
        assert!(entry["entries"].is_array(), "got {}", entry);
        assert_eq!(entry["entries"].as_array().unwrap().len(), 0);
        assert!(entry.get("content").is_none(), "got {}", entry);
        assert!(entry.get("total_lines").is_none(), "got {}", entry);
        assert_eq!(entry["truncated"], false);
    }

    /* ============================================================ */
    /*  tool_write_file tests                                       */
    /* ============================================================ */

    #[tokio::test]
    async fn write_file_create_new_succeeds() {
        let root = tempdir();
        let target = root.join("new.txt");
        let r = tool_write_file(WriteFileRequest {
            files: vec![WriteFileEntry {
                path: target.to_str().unwrap().to_string(),
                content: "hello".to_string(),
                expected_sha256: None,
            }],
            mode: Some("create".to_string()),
            allowed_roots: Some(roots_from(&root)),
        })
        .await
        .expect("expected Ok");
        let entry = &r["results"][0];
        assert_eq!(entry["bytes_written"], 5);
        assert_eq!(entry["mode"], "create");
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "hello");
    }

    #[tokio::test]
    async fn write_file_create_on_existing_returns_already_exists() {
        let root = tempdir();
        let target = root.join("exists.txt");
        std::fs::write(&target, "original").unwrap();

        let r = tool_write_file(WriteFileRequest {
            files: vec![WriteFileEntry {
                path: target.to_str().unwrap().to_string(),
                content: "new".to_string(),
                expected_sha256: None,
            }],
            mode: Some("create".to_string()),
            allowed_roots: Some(roots_from(&root)),
        })
        .await
        .expect("expected Ok");
        let entry = &r["results"][0];
        assert!(
            entry["error"].as_str().unwrap().contains("already exists"),
            "got {:?}",
            entry
        );
        // Original content preserved.
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "original");
    }

    #[tokio::test]
    async fn concurrent_create_calls_never_clobber_each_other() {
        let root = tempdir();
        let target = root.join("concurrent-create.txt");
        let request = |content: &str| WriteFileRequest {
            files: vec![WriteFileEntry {
                path: target.to_str().unwrap().to_string(),
                content: content.to_string(),
                expected_sha256: None,
            }],
            mode: Some("create".to_string()),
            allowed_roots: Some(roots_from(&root)),
        };

        let (first, second) = tokio::join!(
            tool_write_file(request("first")),
            tool_write_file(request("second")),
        );
        let first = first.unwrap();
        let second = second.unwrap();
        let entries = [&first["results"][0], &second["results"][0]];
        assert_eq!(
            entries
                .iter()
                .filter(|entry| entry["bytes_written"].as_u64().unwrap_or(0) > 0)
                .count(),
            1
        );
        assert_eq!(
            entries
                .iter()
                .filter(|entry| entry["error"].is_string())
                .count(),
            1
        );
        let content = std::fs::read_to_string(&target).unwrap();
        assert!(content == "first" || content == "second");
    }

    #[tokio::test]
    async fn write_file_overwrite_replaces_content() {
        let root = tempdir();
        let target = root.join("e.txt");
        std::fs::write(&target, "original").unwrap();

        let r = tool_write_file(WriteFileRequest {
            files: vec![WriteFileEntry {
                path: target.to_str().unwrap().to_string(),
                content: "replaced".to_string(),
                expected_sha256: None,
            }],
            mode: Some("overwrite".to_string()),
            allowed_roots: Some(roots_from(&root)),
        })
        .await
        .expect("expected Ok");
        assert_eq!(r["results"][0]["bytes_written"], 8);
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "replaced");
    }

    // ── streaming line count ────────────────────────────────────

    #[test]
    fn streaming_line_count_matches_in_memory_count() {
        let root = tempdir();
        // Each case is (contents, expected count) per `count_text_lines`.
        for (index, body) in [
            "",
            "\n",
            "one",
            "one\n",
            "one\ntwo",
            "one\ntwo\n",
            "a\n\nb\n",
            "crlf\r\nlines\r\n",
        ]
        .iter()
        .enumerate()
        {
            let target = root.join(format!("lines-{index}.txt"));
            std::fs::write(&target, body).unwrap();
            let size = std::fs::metadata(&target).unwrap().len();
            assert_eq!(
                count_file_lines_streaming(&target, size),
                Some(count_text_lines(body)),
                "streaming count diverged for {body:?}",
            );
        }
    }

    #[test]
    fn streaming_line_count_spans_multiple_chunks() {
        let root = tempdir();
        let target = root.join("big.txt");
        // Comfortably larger than STREAM_CHUNK_BYTES so the loop iterates.
        let body = "line\n".repeat(40_000);
        std::fs::write(&target, &body).unwrap();
        let size = std::fs::metadata(&target).unwrap().len();
        assert!(size > STREAM_CHUNK_BYTES as u64);
        assert_eq!(count_file_lines_streaming(&target, size), Some(40_000));
    }

    #[test]
    fn streaming_line_count_declines_oversized_files() {
        let root = tempdir();
        let target = root.join("small.txt");
        std::fs::write(&target, "one\n").unwrap();
        // The budget is checked against the reported size, not the real file.
        assert_eq!(
            count_file_lines_streaming(&target, MAX_LINE_COUNT_SCAN_BYTES + 1),
            None,
        );
    }

    #[test]
    fn write_file_omits_lines_removed_when_unmeasured() {
        // The field is present for a normal overwrite...
        let root = tempdir();
        let target = root.join("measured.txt");
        std::fs::write(&target, "a\nb\n").unwrap();
        let size = std::fs::metadata(&target).unwrap().len();
        assert_eq!(count_file_lines_streaming(&target, size), Some(2));
        // ...and absent when the scan declines, which is what the write path
        // turns into an omitted key rather than a fabricated zero.
        assert!(count_file_lines_streaming(&target, MAX_LINE_COUNT_SCAN_BYTES + 1).is_none());
    }

    // ── streaming hash / expected_sha256 ────────────────────────

    #[test]
    fn streaming_hash_matches_read_file_digest() {
        let root = tempdir();
        let target = root.join("hashed.txt");
        let body = "content to hash\nsecond line\n";
        std::fs::write(&target, body).unwrap();

        // Same construction tool_read_file uses over the raw bytes.
        let mut hasher = Sha256::new();
        hasher.update(body.as_bytes());
        let expected: String = hasher
            .finalize()
            .iter()
            .map(|b| format!("{:02x}", b))
            .collect();

        assert_eq!(hash_file_streaming(&target).unwrap(), expected);
    }

    #[test]
    fn streaming_hash_spans_multiple_chunks() {
        let root = tempdir();
        let target = root.join("big-hash.bin");
        let body = vec![7u8; STREAM_CHUNK_BYTES * 3 + 17];
        std::fs::write(&target, &body).unwrap();

        let mut hasher = Sha256::new();
        hasher.update(&body);
        let expected: String = hasher
            .finalize()
            .iter()
            .map(|b| format!("{:02x}", b))
            .collect();

        assert_eq!(hash_file_streaming(&target).unwrap(), expected);
    }

    #[tokio::test]
    async fn write_file_accepts_matching_expected_sha256() {
        let root = tempdir();
        let target = root.join("cas-ok.txt");
        std::fs::write(&target, "original").unwrap();
        let current = hash_file_streaming(&target).unwrap();

        let r = tool_write_file(WriteFileRequest {
            files: vec![WriteFileEntry {
                path: target.to_str().unwrap().to_string(),
                content: "replaced".to_string(),
                expected_sha256: Some(current),
            }],
            mode: Some("overwrite".to_string()),
            allowed_roots: Some(roots_from(&root)),
        })
        .await
        .expect("expected Ok");

        assert!(r["results"][0]["error"].is_null());
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "replaced");
    }

    #[tokio::test]
    async fn write_file_whitespace_expected_sha256_is_treated_as_omitted() {
        let root = tempdir();
        let target = root.join("cas-ws.txt");
        std::fs::write(&target, "original").unwrap();

        let r = tool_write_file(WriteFileRequest {
            files: vec![WriteFileEntry {
                path: target.to_str().unwrap().to_string(),
                content: "replaced".to_string(),
                expected_sha256: Some("   ".to_string()),
            }],
            mode: Some("overwrite".to_string()),
            allowed_roots: Some(roots_from(&root)),
        })
        .await
        .expect("expected Ok");

        assert!(r["results"][0]["error"].is_null());
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "replaced");
    }

    #[tokio::test]
    async fn write_file_rejects_stale_expected_sha256() {
        let root = tempdir();
        let target = root.join("cas-stale.txt");
        std::fs::write(&target, "original").unwrap();
        let stale = hash_file_streaming(&target).unwrap();
        // Someone else writes between the model's read and its write.
        std::fs::write(&target, "changed underneath").unwrap();

        let r = tool_write_file(WriteFileRequest {
            files: vec![WriteFileEntry {
                path: target.to_str().unwrap().to_string(),
                content: "replaced".to_string(),
                expected_sha256: Some(stale),
            }],
            mode: Some("overwrite".to_string()),
            allowed_roots: Some(roots_from(&root)),
        })
        .await
        .expect("expected Ok");

        assert!(r["results"][0]["error"]
            .as_str()
            .unwrap()
            .contains("modified concurrently"));
        assert_eq!(r["results"][0]["bytes_written"], 0);
        // The concurrent write must survive untouched.
        assert_eq!(
            std::fs::read_to_string(&target).unwrap(),
            "changed underneath",
        );
    }

    #[tokio::test]
    async fn write_file_expected_sha256_is_case_insensitive() {
        let root = tempdir();
        let target = root.join("cas-case.txt");
        std::fs::write(&target, "original").unwrap();
        let upper = hash_file_streaming(&target).unwrap().to_uppercase();

        let r = tool_write_file(WriteFileRequest {
            files: vec![WriteFileEntry {
                path: target.to_str().unwrap().to_string(),
                content: "replaced".to_string(),
                expected_sha256: Some(upper),
            }],
            mode: Some("overwrite".to_string()),
            allowed_roots: Some(roots_from(&root)),
        })
        .await
        .expect("expected Ok");

        assert!(r["results"][0]["error"].is_null());
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "replaced");
    }

    #[tokio::test]
    async fn write_file_expected_sha256_allows_create_of_missing_file() {
        let root = tempdir();
        let target = root.join("cas-new.txt");

        let r = tool_write_file(WriteFileRequest {
            files: vec![WriteFileEntry {
                path: target.to_str().unwrap().to_string(),
                content: "fresh".to_string(),
                expected_sha256: Some("0".repeat(64)),
            }],
            mode: Some("create".to_string()),
            allowed_roots: Some(roots_from(&root)),
        })
        .await
        .expect("expected Ok");

        assert!(r["results"][0]["error"].is_null());
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "fresh");
    }

    #[tokio::test]
    async fn write_file_append_rejects_expected_sha256_on_missing_file() {
        let root = tempdir();
        let target = root.join("cas-absent.txt");

        let r = tool_write_file(WriteFileRequest {
            files: vec![WriteFileEntry {
                path: target.to_str().unwrap().to_string(),
                content: "tail".to_string(),
                expected_sha256: Some("0".repeat(64)),
            }],
            mode: Some("append".to_string()),
            allowed_roots: Some(roots_from(&root)),
        })
        .await
        .expect("expected Ok");

        assert!(r["results"][0]["error"]
            .as_str()
            .unwrap()
            .contains("does not exist"));
        assert!(!target.exists());
    }

    #[tokio::test]
    async fn write_file_append_extends_existing() {
        let root = tempdir();
        let target = root.join("a.txt");
        std::fs::write(&target, "first").unwrap();

        tool_write_file(WriteFileRequest {
            files: vec![WriteFileEntry {
                path: target.to_str().unwrap().to_string(),
                content: "second".to_string(),
                expected_sha256: None,
            }],
            mode: Some("append".to_string()),
            allowed_roots: Some(roots_from(&root)),
        })
        .await
        .expect("expected Ok");
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "firstsecond");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_device_unicode_trailing_dot_and_ads_stay_scoped() {
        let root = tempdir();
        let unicode = root.join("naïve-文件.txt");
        std::fs::write(&unicode, "inside").unwrap();
        assert_eq!(
            resolve_ok(unicode.to_str().unwrap(), std::slice::from_ref(&root)),
            unicode
        );

        let ordinary = root.join("ordinary.txt");
        std::fs::write(&ordinary, "inside").unwrap();
        let trailing_dot = root.join("ordinary.txt.");
        let trailing = resolve_ok(trailing_dot.to_str().unwrap(), std::slice::from_ref(&root));
        assert_eq!(
            trailing.file_name().unwrap().to_ascii_lowercase(),
            "ordinary.txt"
        );

        let ads = root.join("ordinary.txt:lc-a11");
        std::fs::write(&ads, "stream").unwrap();
        let ads_resolved = resolve_ok(ads.to_str().unwrap(), std::slice::from_ref(&root));
        assert!(ads_resolved.starts_with(&root));

        let outside = std::env::temp_dir().join(format!(
            "lc-fs-device-out-{}-{:016x}.txt",
            std::process::id(),
            rand::random::<u64>()
        ));
        std::fs::write(&outside, "outside").unwrap();
        let device = format!(r"\\?\{}", outside.display());
        let err = resolve_err(&device, &[root]);
        assert!(matches!(err, ToolError::PathOutsideRoots { .. }));
        std::fs::remove_file(outside).unwrap();
    }

    #[test]
    fn write_request_accepts_the_per_file_limit_and_rejects_limit_plus_one() {
        let exact = WriteFileEntry {
            path: "exact.txt".into(),
            content: "x".repeat(MAX_WRITE_TARGET_BYTES),
            expected_sha256: None,
        };
        assert!(enforce_write_request_limits(std::slice::from_ref(&exact)).is_ok());

        let oversized = WriteFileEntry {
            path: "oversized.txt".into(),
            content: "x".repeat(MAX_WRITE_TARGET_BYTES + 1),
            expected_sha256: None,
        };
        assert!(matches!(
            enforce_write_request_limits(&[oversized]),
            Err(ToolError::TooLarge(_))
        ));
    }

    #[tokio::test]
    async fn write_file_rejects_an_oversized_append_target_before_reading_it() {
        let root = tempdir();
        let target = root.join("oversized.txt");
        let file = std::fs::File::create(&target).unwrap();
        file.set_len(MAX_WRITE_TARGET_BYTES as u64 + 1).unwrap();

        let result = tool_write_file(WriteFileRequest {
            files: vec![WriteFileEntry {
                path: target.to_string_lossy().into_owned(),
                content: "tail".into(),
                expected_sha256: None,
            }],
            mode: Some("append".into()),
            allowed_roots: Some(roots_from(&root)),
        })
        .await
        .unwrap();

        assert!(result["results"][0]["error"]
            .as_str()
            .is_some_and(|error| error.contains("final-file limit")));
        assert_eq!(
            std::fs::metadata(target).unwrap().len(),
            MAX_WRITE_TARGET_BYTES as u64 + 1
        );
    }

    #[tokio::test]
    async fn write_file_append_creates_if_missing() {
        let root = tempdir();
        let target = root.join("new.txt");
        assert!(!target.exists());

        tool_write_file(WriteFileRequest {
            files: vec![WriteFileEntry {
                path: target.to_str().unwrap().to_string(),
                content: "fresh".to_string(),
                expected_sha256: None,
            }],
            mode: Some("append".to_string()),
            allowed_roots: Some(roots_from(&root)),
        })
        .await
        .expect("expected Ok");
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "fresh");
    }

    #[tokio::test]
    async fn write_file_default_mode_is_create() {
        let root = tempdir();
        let target = root.join("d.txt");
        let r = tool_write_file(WriteFileRequest {
            files: vec![WriteFileEntry {
                path: target.to_str().unwrap().to_string(),
                content: "x".to_string(),
                expected_sha256: None,
            }],
            mode: None,
            allowed_roots: Some(roots_from(&root)),
        })
        .await
        .expect("expected Ok");
        assert_eq!(r["results"][0]["mode"], "create");
    }

    #[tokio::test]
    async fn write_file_rejects_unknown_mode() {
        let root = tempdir();
        let target = root.join("u.txt");
        let r = tool_write_file(WriteFileRequest {
            files: vec![WriteFileEntry {
                path: target.to_str().unwrap().to_string(),
                content: "x".to_string(),
                expected_sha256: None,
            }],
            mode: Some("garbage".to_string()),
            allowed_roots: Some(roots_from(&root)),
        })
        .await
        .expect("expected Ok");
        assert!(
            r["results"][0]["error"]
                .as_str()
                .unwrap()
                .contains("unknown mode"),
            "got {:?}",
            r
        );
    }

    /// The shared text-admission policy. Every tool that reads file
    /// content routes through this, so the rules are pinned here once.
    #[test]
    fn text_policy_applies_both_rules_over_one_window() {
        assert_eq!(classify_text(b"plain ascii\n"), None);
        assert_eq!(classify_text("cafe\u{301} utf-8\n".as_bytes()), None);

        // A NUL inside the window is binary. UTF-16 lands here, because
        // it decodes as valid UTF-8 and no other rule would catch it.
        let mut utf16 = vec![0xFFu8, 0xFE];
        for unit in "needle".encode_utf16() {
            utf16.extend_from_slice(&unit.to_le_bytes());
        }
        assert_eq!(classify_text(&utf16), Some(NotText::Binary));

        // Latin-1: decodable bytes, no NUL, not valid UTF-8.
        assert_eq!(classify_text(b"caf\xe9\n"), Some(NotText::NotUtf8));

        // A NUL past the window is accepted as text. NUL is valid
        // UTF-8, so neither rule fires, and the window is what bounds
        // the binary check. `lc_grep` has to agree on this exact
        // boundary or the two tools classify the same file differently.
        let mut late_nul = vec![b'x'; TEXT_SNIFF_BYTES + 10];
        late_nul.push(0);
        assert_eq!(classify_text(&late_nul), None);

        // The diagnostic names the code too. Read-file callers select
        // recovery from the separate error_code field.
        assert!(NotText::Binary.remedy().starts_with("binary_detected:"));
        assert!(NotText::NotUtf8
            .remedy()
            .starts_with("encoding_not_utf8:"));
    }

    /// A lossy decode used to return text whose bytes no longer matched
    /// the file, with nothing in the result saying so. Writing that text
    /// back destroyed the original bytes.
    #[tokio::test]
    async fn read_file_refuses_content_it_cannot_return_faithfully() {
        let root = std::env::temp_dir().join(format!(
            "lc-textpolicy-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let latin1 = root.join("latin1.txt");
        std::fs::write(&latin1, b"caf\xe9 au lait\n").unwrap();
        let utf16 = root.join("utf16.txt");
        std::fs::write(&utf16, b"n\x00e\x00e\x00d\x00l\x00e\x00").unwrap();

        let result = tool_read_file(ReadFileRequest {
            paths: vec![
                latin1.to_string_lossy().to_string(),
                utf16.to_string_lossy().to_string(),
            ],
            start_line: None,
            end_line: None,
            max_bytes: None,
            allowed_roots: Some(vec![root.to_string_lossy().to_string()]),
            call_id: None,
            group_id: None,
        })
        .await
        .expect("per-path errors stay in band");

        let entries = result["results"].as_array().unwrap();
        let first = entries[0]["error"].as_str().unwrap_or_default();
        assert_eq!(entries[0]["error_code"], "encoding_not_utf8");
        assert!(
            first.starts_with("encoding_not_utf8"),
            "latin-1 must be refused, got {first}"
        );
        assert!(entries[0]["content"].as_str().unwrap().is_empty());
        let second = entries[1]["error"].as_str().unwrap_or_default();
        assert_eq!(entries[1]["error_code"], "binary_detected");
        assert!(
            second.starts_with("binary_detected"),
            "utf-16 must be refused, got {second}"
        );
        std::fs::remove_dir_all(root).unwrap();
    }


    /// `lc_read_file` transcodes BOM-marked UTF-16 for reading. Writing
    /// that text back stored UTF-8 and changed the file's encoding, and
    /// `expected_sha256` matched because the file itself had not
    /// changed. `lc_edit_file` and `lc_apply_patch` already refused this
    /// shape; the third writer must too.
    #[tokio::test]
    async fn write_file_refuses_to_re_encode_a_utf16_file() {
        let root = std::env::temp_dir().join(format!(
            "lc-write-utf16-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let target = root.join("log.txt");
        let original = utf16_bytes("needle here\n", Utf16Kind::Le);
        std::fs::write(&target, &original).unwrap();

        let read = tool_read_file(ReadFileRequest {
            paths: vec![target.to_string_lossy().to_string()],
            start_line: None,
            end_line: None,
            max_bytes: None,
            allowed_roots: Some(vec![root.to_string_lossy().to_string()]),
            call_id: None,
            group_id: None,
        })
        .await
        .unwrap();
        let entry = &read["results"][0];
        assert_eq!(entry["encoding"].as_str().unwrap(), "utf-16le");
        let content = entry["content"].as_str().unwrap().to_string();
        let sha = entry["sha256"].as_str().unwrap().to_string();

        let wrote = tool_write_file(WriteFileRequest {
            files: vec![WriteFileEntry {
                path: target.to_string_lossy().to_string(),
                content,
                expected_sha256: Some(sha),
            }],
            mode: Some("overwrite".into()),
            allowed_roots: Some(vec![root.to_string_lossy().to_string()]),
        })
        .await
        .unwrap();

        let error = wrote["results"][0]["error"].as_str().unwrap_or_default();
        assert!(
            error.contains("utf-16le") && error.contains("byte-order mark"),
            "write must refuse and say why, got {error}"
        );
        assert_eq!(wrote["results"][0]["bytes_written"], 0);
        assert_eq!(
            std::fs::read(&target).unwrap(),
            original,
            "the file must be untouched"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    /// The guard reads what is on disk, so a new file is unaffected.
    #[tokio::test]
    async fn write_file_create_is_unaffected_by_the_bom_guard() {
        let root = std::env::temp_dir().join(format!(
            "lc-write-create-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let target = root.join("fresh.txt");

        let wrote = tool_write_file(WriteFileRequest {
            files: vec![WriteFileEntry {
                path: target.to_string_lossy().to_string(),
                content: "hello\n".into(),
                expected_sha256: None,
            }],
            mode: Some("create".into()),
            allowed_roots: Some(vec![root.to_string_lossy().to_string()]),
        })
        .await
        .unwrap();

        assert!(wrote["results"][0]["error"].is_null());
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "hello\n");
        std::fs::remove_dir_all(root).unwrap();
    }


    /// The decoder sniffs magic bytes, so the reported mime must come
    /// from the bytes too. Reporting the extension announced a PNG
    /// named `.jpg` as JPEG, and a valid PNG with no extension as
    /// `application/octet-stream`.
    #[tokio::test]
    async fn read_image_reports_the_format_it_decoded() {
        let root = std::env::temp_dir().join(format!(
            "lc-img-format-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let mut png = Vec::new();
        image::DynamicImage::ImageRgb8(image::RgbImage::new(4, 4))
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .unwrap();
        std::fs::write(root.join("really_a_png.jpg"), &png).unwrap();
        std::fs::write(root.join("noext"), &png).unwrap();

        for name in ["really_a_png.jpg", "noext"] {
            let out = tool_read_image(ReadImageRequest {
                paths: vec![root.join(name).to_string_lossy().to_string()],
                max_bytes: None,
                encoding: None,
                downscale: 1.0,
                allowed_roots: Some(vec![root.to_string_lossy().to_string()]),
            })
            .await
            .unwrap();
            let entry = &out["images"][0];
            assert!(entry["error"].is_null(), "{name}: {entry}");
            assert_eq!(
                entry["mime"].as_str().unwrap(),
                "image/png",
                "{name} is a PNG whatever it is called"
            );
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    /// "format could not be determined" is true and useless. An SVG is
    /// readable, just not here, and the message has to say so.
    #[tokio::test]
    async fn read_image_names_the_format_it_cannot_open() {
        let root = std::env::temp_dir().join(format!(
            "lc-img-unsupported-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            root.join("vector.svg"),
            b"<svg xmlns='http://www.w3.org/2000/svg' width='4' height='4'></svg>",
        )
        .unwrap();
        std::fs::write(root.join("scan.tiff"), b"II*\0\0\0\0\0padding").unwrap();

        let out = tool_read_image(ReadImageRequest {
            paths: vec![
                root.join("vector.svg").to_string_lossy().to_string(),
                root.join("scan.tiff").to_string_lossy().to_string(),
            ],
            max_bytes: None,
            encoding: None,
            downscale: 1.0,
            allowed_roots: Some(vec![root.to_string_lossy().to_string()]),
        })
        .await
        .unwrap();

        let svg = out["images"][0]["error"].as_str().unwrap_or_default();
        assert!(
            svg.contains("svg") && svg.contains("lc_read_file"),
            "svg must name itself and the tool that reads it, got {svg}"
        );
        let tiff = out["images"][1]["error"].as_str().unwrap_or_default();
        assert!(
            tiff.contains("tiff"),
            "tiff must be named, not called undetermined, got {tiff}"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

}
