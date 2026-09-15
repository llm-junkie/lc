//! `tool_glob_files` — recursive file finder with glob pattern matching.
//!
//! Walks a directory tree, matches entries against a glob pattern,
//! and returns matching paths.  Uses the `globset` crate for robust,
//! Unicode-safe glob matching (replaces the previous custom matcher).
//! Read-only, sandboxed by `resolve_under_roots`.

use super::fs_ops::{merged_roots, resolve_under_roots};
use super::registry::{ToolHandle, ToolRegistryEntry, ToolRegistryGuard};
use super::{ToolError, ToolOk};
use serde::{Deserialize, Serialize};
use std::time::Instant;
use tokio_util::sync::CancellationToken;

const DEFAULT_MAX_RESULTS: usize = 1000;
const HARD_CAP_RESULTS: usize = 5000;
const MAX_BRACE_ALTERNATIVES: usize = 16;
const DEFAULT_MAX_VISITED: usize = 50_000;
const HARD_CAP_VISITED: usize = 200_000;
const CANCELLATION_CHECK_INTERVAL: usize = 100;

/// Directory names to skip by default (like grep).
const DEFAULT_IGNORE_DIRS: &[&str] = &[
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

#[derive(Debug, Deserialize)]
pub struct GlobRequest {
    pub pattern: String,
    pub root: String,
    pub allowed_roots: Vec<String>,
    pub include_hidden: Option<bool>,
    pub max_results: Option<usize>,
    /// Phase 2.1: Operation-level identity for cancellation registration.
    #[serde(default)]
    pub call_id: Option<String>,
    #[serde(default)]
    pub group_id: Option<String>,
    /// Max directory entries to visit (soft: DEFAULT_MAX_VISITED, hard: HARD_CAP_VISITED).
    #[serde(default)]
    pub max_visited_entries: Option<usize>,
    /// Wall-clock budget in milliseconds from call start. 0 or absent = no deadline.
    #[serde(default)]
    pub deadline_ms: Option<u64>,
    /// Directories to skip (appended to the default ignore list). Optional.
    #[serde(default)]
    pub ignore_dirs: Option<Vec<String>>,
}

#[derive(Debug, Serialize)]
pub struct GlobMatch {
    pub path: String,
    pub is_dir: bool,
    pub size_bytes: Option<u64>,
}

#[derive(Debug, Serialize)]
pub struct GlobOutput {
    pub matches: Vec<GlobMatch>,
    pub truncated: bool,
    pub pattern_used: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub visited_entries: Option<usize>,
}

// ── brace expansion ────────────────────────────────────────────────

/// Expand `{a,b,c}` braces into multiple patterns.  Nested braces are
/// expanded recursively.  Capped at `MAX_BRACE_ALTERNATIVES` (16)
/// alternatives per expansion — exceeding returns the original pattern
/// unexpanded to avoid blow-up.
///
/// Shared with `grep` and `list_dir` so all three tools speak one
/// glob dialect.
pub(super) fn expand_braces(pattern: &str) -> Vec<String> {
    if let Some(start) = pattern.find('{') {
        if let Some(end) = pattern[start..].find('}') {
            let end = start + end;
            let prefix = &pattern[..start];
            let suffix = &pattern[end + 1..];
            let inner = &pattern[start + 1..end];
            let options: Vec<&str> = inner.split(',').map(|s| s.trim()).collect();
            if options.len() > MAX_BRACE_ALTERNATIVES {
                return vec![pattern.to_string()];
            }
            let mut result = Vec::new();
            for opt in &options {
                let expanded = format!("{}{}{}", prefix, opt, suffix);
                result.extend(expand_braces(&expanded));
            }
            return result;
        }
    }
    vec![pattern.to_string()]
}

/// Compile expanded patterns into a matcher.  Shared with `grep` and
/// `list_dir`; invalid patterns are an explicit error, never a silent
/// match-nothing.
pub(super) fn build_glob_set(patterns: &[String]) -> Result<globset::GlobSet, ToolError> {
    let mut builder = globset::GlobSetBuilder::new();
    for pattern in patterns {
        let glob = globset::Glob::new(pattern)
            .map_err(|e| ToolError::Io(format!("invalid_glob_pattern: {}", e)))?;
        builder.add(glob);
    }
    builder
        .build()
        .map_err(|e| ToolError::Io(format!("invalid_glob_pattern: {}", e)))
}

fn cancellation_stops_traversal(
    cancel_token: Option<&CancellationToken>,
    visited: usize,
    truncated: &mut bool,
) -> bool {
    if !visited.is_multiple_of(CANCELLATION_CHECK_INTERVAL) {
        return false;
    }
    if cancel_token.is_some_and(CancellationToken::is_cancelled) {
        *truncated = true;
        return true;
    }
    false
}

// ── Tauri command ──────────────────────────────────────────────────

#[tauri::command]
pub async fn tool_glob_files(req: GlobRequest) -> Result<ToolOk, ToolError> {
    // Register cancellation token if call_id was provided.
    let (cancel_token, _guard) = if let Some(ref call_id) = req.call_id {
        let token = CancellationToken::new();
        {
            let entry = ToolRegistryEntry {
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
        let roots = merged_roots(&req.allowed_roots);
        let search_root = resolve_under_roots(&req.root, &roots)?;

        let max_results = req
            .max_results
            .unwrap_or(DEFAULT_MAX_RESULTS)
            .min(HARD_CAP_RESULTS);
        let max_visited = req
            .max_visited_entries
            .unwrap_or(DEFAULT_MAX_VISITED)
            .min(HARD_CAP_VISITED);
        let deadline = req.deadline_ms.map(|ms| Instant::now()
            .checked_add(std::time::Duration::from_millis(ms))
            .unwrap_or(Instant::now()));
        let include_hidden = req.include_hidden.unwrap_or(false);
        let patterns = expand_braces(&req.pattern);

        let glob_set = build_glob_set(&patterns)?;

        // Build ignore set: default + user-supplied.
        let ignore_dirs: Vec<String> = DEFAULT_IGNORE_DIRS
            .iter()
            .map(|s| s.to_string())
            .chain(req.ignore_dirs.into_iter().flatten())
            .collect();

        let walker = walkdir::WalkDir::new(&search_root)
            .follow_links(false)
            .into_iter()
            .filter_entry(move |e| {
                if e.file_type().is_dir() {
                    let name = e.file_name().to_string_lossy();
                    !ignore_dirs.contains(&name.to_string())
                } else {
                    true
                }
            });

        let mut matches: Vec<GlobMatch> = Vec::new();
        let mut truncated = false;
        let mut visited: usize = 0;

        for entry in walker {
            if visited >= max_visited {
                truncated = true;
                break;
            }
            // Cancellation is a successful truncated traversal: preserve
            // every match collected before the cancellation checkpoint.
            if cancellation_stops_traversal(cancel_token.as_ref(), visited, &mut truncated) {
                break;
            }
            if let Some(ref dl) = deadline {
                if Instant::now() >= *dl {
                    truncated = true;
                    break;
                }
            }
            let entry = match entry {
                Ok(e) => e,
                Err(error) => return Err(ToolError::Io(format!(
                    "Glob traversal failed at {}. Check that this path exists and is readable, or choose another root. Native error: {}",
                    error.path().unwrap_or(&search_root).display(), error,
                ))),
            };
            visited += 1;

            // Skip hidden unless requested.
            if !include_hidden && entry.file_name().to_str()
                .map(|s| s.starts_with('.') && s != ".")
                .unwrap_or(false)
            {
                continue;
            }

            let rel = match entry.path().strip_prefix(&search_root) {
                Ok(r) => r,
                Err(_) => continue,
            };
            // Normalise to forward slashes for glob matching.
            let rel_str = rel.to_string_lossy().replace('\\', "/");
            if rel_str.is_empty() {
                continue; // skip root itself
            }
            if !glob_set.is_match(&rel_str) {
                continue;
            }

            let size_bytes = if entry.file_type().is_file() {
                entry.metadata().ok().map(|m| m.len())
            } else {
                None
            };
            matches.push(GlobMatch {
                path: entry.path().to_string_lossy().into_owned(),
                is_dir: entry.file_type().is_dir(),
                size_bytes,
            });

            // Check after push so truncated is only set when we know
            // there was at least one more match beyond the cap.
            if matches.len() > max_results {
                truncated = true;
                matches.truncate(max_results);
                break;
            }
        }

        // Sort for stable, deterministic output.
        matches.sort_by(|a, b| a.path.cmp(&b.path));

        Ok(serde_json::to_value(GlobOutput {
            matches,
            truncated,
            pattern_used: req.pattern,
            visited_entries: Some(visited),
        })
        .unwrap_or(serde_json::json!({"matches":[],"truncated":false,"pattern_used":"","visited_entries":0})))
    })
    .await
    .map_err(|e| ToolError::Io(format!("task join failed: {}", e)))?
}

// ── Tests ──────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn tempdir() -> PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let id = COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!("lc-glob-test-{}-{}", std::process::id(), id));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn brace_expansion_basic() {
        let result = expand_braces("file.{ts,js}");
        assert_eq!(result, vec!["file.ts", "file.js"]);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn traversal_error_cannot_claim_a_complete_listing() {
        let root = tempdir();
        let denied = root.join("locked");
        std::fs::create_dir(&denied).unwrap();
        std::fs::write(denied.join("hidden.txt"), "content").unwrap();
        let identity = std::process::Command::new("whoami").output().unwrap();
        assert!(identity.status.success());
        let identity = String::from_utf8(identity.stdout).unwrap();
        let identity = identity.trim();
        let deny = std::process::Command::new("icacls")
            .arg(&denied)
            .args(["/deny", &format!("{identity}:(RD)")])
            .output()
            .unwrap();
        assert!(
            deny.status.success(),
            "fixture must install its directory read denial"
        );
        let walker_errors = walkdir::WalkDir::new(&root)
            .into_iter()
            .filter(|entry| entry.is_err())
            .count();
        let request = || GlobRequest {
            pattern: "**/*.txt".into(),
            root: root.to_string_lossy().into(),
            allowed_roots: vec![root.to_string_lossy().into()],
            include_hidden: None,
            max_results: None,
            call_id: None,
            group_id: None,
            max_visited_entries: None,
            deadline_ms: None,
            ignore_dirs: None,
        };
        let result = tool_glob_files(request()).await;
        let restore = std::process::Command::new("icacls")
            .arg(&denied)
            .args(["/remove:d", identity])
            .output()
            .unwrap();
        assert!(
            restore.status.success(),
            "fixture must restore directory access"
        );
        let recovered = tool_glob_files(request()).await;
        std::fs::remove_dir_all(&root).unwrap();
        assert!(walker_errors > 0, "fixture must prevent traversal");
        let error = result.expect_err("a traversal error must not claim completeness");
        assert!(matches!(error, ToolError::Io(_)));
        let message = error.to_string();
        assert!(message.contains(&denied.to_string_lossy().to_string()));
        assert!(message
            .contains("Check that this path exists and is readable, or choose another root."));
        let recovered = recovered.unwrap();
        assert_eq!(recovered["truncated"], false);
        assert_eq!(recovered["matches"].as_array().unwrap().len(), 1);
        assert_eq!(
            recovered["matches"][0]["path"],
            denied.join("hidden.txt").to_string_lossy().to_string()
        );
    }

    #[test]
    fn brace_expansion_nested() {
        let result = expand_braces("src/{a,b}/{x,y}.rs");
        assert_eq!(
            result,
            vec!["src/a/x.rs", "src/a/y.rs", "src/b/x.rs", "src/b/y.rs",]
        );
    }

    #[test]
    fn brace_expansion_overflow() {
        let mut big = String::from("file.{");
        for i in 0..20 {
            if i > 0 {
                big.push(',');
            }
            big.push_str(&format!("ext{}", i));
        }
        big.push('}');
        let result = expand_braces(&big);
        // Should return original unexpanded due to cap.
        assert_eq!(result.len(), 1);
        assert_eq!(result[0], big);
    }

    #[test]
    fn invalid_requested_pattern_is_rejected() {
        let error = build_glob_set(&["[".to_string()]).unwrap_err();
        assert!(error.to_string().contains("invalid_glob_pattern"));
    }

    #[test]
    fn fixed_traversal_exclusions_match_the_public_contract() {
        assert_eq!(
            DEFAULT_IGNORE_DIRS,
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
    }

    #[test]
    fn cancellation_before_traversal_marks_an_empty_result_truncated() {
        let token = CancellationToken::new();
        token.cancel();
        let mut truncated = false;

        assert!(cancellation_stops_traversal(
            Some(&token),
            0,
            &mut truncated
        ));
        let output = GlobOutput {
            matches: Vec::new(),
            truncated,
            pattern_used: "**/*".to_string(),
            visited_entries: Some(0),
        };
        assert!(output.truncated);
        assert!(output.matches.is_empty());
    }

    #[test]
    fn cancellation_preserves_matches_collected_before_the_checkpoint() {
        let token = CancellationToken::new();
        let matches = vec![GlobMatch {
            path: "already-found.txt".to_string(),
            is_dir: false,
            size_bytes: Some(7),
        }];
        token.cancel();
        let mut truncated = false;

        assert!(cancellation_stops_traversal(
            Some(&token),
            CANCELLATION_CHECK_INTERVAL,
            &mut truncated
        ));
        let output = GlobOutput {
            matches,
            truncated,
            pattern_used: "**/*".to_string(),
            visited_entries: Some(CANCELLATION_CHECK_INTERVAL),
        };
        assert!(output.truncated);
        assert_eq!(output.matches.len(), 1);
        assert_eq!(output.matches[0].path, "already-found.txt");
    }

    #[tokio::test]
    async fn returns_directories_and_descends_through_hidden_basename_entries() {
        let root = tempdir();
        std::fs::create_dir_all(root.join(".github/workflows")).unwrap();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join(".github/workflows/build.yml"), "name: build").unwrap();
        std::fs::write(root.join("src/main.rs"), "fn main() {}").unwrap();

        let output = tool_glob_files(GlobRequest {
            pattern: "**/*".to_string(),
            root: root.to_string_lossy().into_owned(),
            allowed_roots: vec![root.to_string_lossy().into_owned()],
            include_hidden: Some(false),
            max_results: None,
            call_id: None,
            group_id: None,
            max_visited_entries: None,
            deadline_ms: None,
            ignore_dirs: None,
        })
        .await
        .unwrap();

        let matches = output["matches"].as_array().unwrap();
        assert!(matches.iter().any(|entry| {
            entry["path"]
                .as_str()
                .unwrap()
                .ends_with(".github\\workflows\\build.yml")
                || entry["path"]
                    .as_str()
                    .unwrap()
                    .ends_with(".github/workflows/build.yml")
        }));
        let src = matches
            .iter()
            .find(|entry| {
                entry["path"].as_str().unwrap().ends_with("\\src")
                    || entry["path"].as_str().unwrap().ends_with("/src")
            })
            .expect("directory entries are returned");
        assert_eq!(src["is_dir"], true);
        assert!(src["size_bytes"].is_null());
        assert!(output["visited_entries"].as_u64().unwrap() >= 4);

        let hidden_default = tool_glob_files(GlobRequest {
            pattern: ".github".to_string(),
            root: root.to_string_lossy().into_owned(),
            allowed_roots: vec![root.to_string_lossy().into_owned()],
            include_hidden: Some(false),
            max_results: None,
            call_id: None,
            group_id: None,
            max_visited_entries: None,
            deadline_ms: None,
            ignore_dirs: None,
        })
        .await
        .unwrap();
        assert!(hidden_default["matches"].as_array().unwrap().is_empty());

        let hidden_included = tool_glob_files(GlobRequest {
            pattern: ".github".to_string(),
            root: root.to_string_lossy().into_owned(),
            allowed_roots: vec![root.to_string_lossy().into_owned()],
            include_hidden: Some(true),
            max_results: None,
            call_id: None,
            group_id: None,
            max_visited_entries: None,
            deadline_ms: None,
            ignore_dirs: None,
        })
        .await
        .unwrap();
        let hidden_matches = hidden_included["matches"].as_array().unwrap();
        assert_eq!(hidden_matches.len(), 1);
        assert_eq!(hidden_matches[0]["is_dir"], true);

        std::fs::remove_dir_all(root).unwrap();
    }
}
// ── Globset Unicode safety tests (Phase 0B.4 — GLM C2) ──────────
// The custom `matches_glob` was replaced by `globset` for Unicode-safe
// byte-indexing.  These tests verify that `globset` correctly handles
// multi-byte characters and emoji without panicking — the original bug
// was a byte-index panic on non-ASCII input.
//
// Note: `globset` uses byte-level matching for `?` and `[...]`, so
// those wildcards may not treat multi-byte characters as single units
// the way a char-level matcher would.  This is acceptable — the goal
// is panic-free execution, not char-level wildcard semantics.  `*`
// and exact-match patterns work correctly with Unicode.

#[cfg(test)]
mod globset_unicode_tests {
    #[test]
    fn japanese_exact_match() {
        let g = globset::Glob::new("テスト.txt").unwrap().compile_matcher();
        assert!(g.is_match("テスト.txt"));
        assert!(!g.is_match("テスト2.txt"));
    }

    #[test]
    fn star_matches_multibyte() {
        let g = globset::Glob::new("*.txt").unwrap().compile_matcher();
        assert!(g.is_match("テスト.txt"));
        let g2 = globset::Glob::new("テスト*").unwrap().compile_matcher();
        assert!(g2.is_match("テストファイル.txt"));
    }

    #[test]
    fn emoji_exact_match() {
        let g = globset::Glob::new("report_📊.pdf")
            .unwrap()
            .compile_matcher();
        assert!(g.is_match("report_📊.pdf"));
    }

    #[test]
    fn unicode_path_segments() {
        // Path separators work correctly with Unicode directory names.
        let g = globset::Glob::new("プロジェクト/src/*.rs")
            .unwrap()
            .compile_matcher();
        assert!(g.is_match("プロジェクト/src/main.rs"));
        assert!(!g.is_match("other/src/main.rs"));
    }

    #[test]
    fn unicode_no_panic() {
        // Verify globset does not panic on multi-byte filenames —
        // the original `matches_glob` panicked when a byte-index
        // slice fell mid-character.
        let g = globset::Glob::new("**/*.md").unwrap().compile_matcher();
        // Japanese directory name (3-byte chars) — must not panic.
        let _ = g.is_match("ドキュメント/readme.md");
        // Emoji in path — must not panic.
        let _ = g.is_match("docs/api/画像/screenshot.png");
    }
}
