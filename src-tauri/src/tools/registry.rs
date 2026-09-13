//! Tool-call infrastructure: stable error envelopes, the in-flight
//! cancellation registry, and per-operation/per-group abort plumbing.
//!
//! File tools (read/write/list) live in [`super::fs_ops`].

use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use thiserror::Error;

/// Stable error envelope returned to JS for every tool command. Each
/// variant carries a stable string code (the `#[error("...")]` text)
/// plus a human-readable message. Codes are the contract — the JS
/// runner surfaces them in the `role: 'tool'` message so the model
/// can adapt on the next turn.
#[derive(Debug, Error, Serialize)]
#[serde(tag = "code", content = "message")]
#[allow(dead_code)]
pub enum ToolError {
    #[error("invalid_arguments: {0}")]
    #[serde(rename = "invalid_arguments")]
    InvalidArguments(String),
    #[error("path_outside_roots: {path} (not inside allowed roots: {allowed_roots:?})")]
    PathOutsideRoots {
        path: String,
        allowed_roots: Vec<String>,
    },
    #[error("not_found: {0}")]
    NotFound(String),
    /// `tool_write_file` with `mode='create'` when the file already
    /// exists. Caller chose to fail on collision; we honor that.
    #[error("already_exists: {0}")]
    AlreadyExists(String),
    #[error("not_a_file: {0}")]
    NotAFile(String),
    #[error("not_a_dir: {0}")]
    NotADir(String),
    #[error("permission_denied during {operation}: {native_reason}")]
    PermissionDenied {
        operation: String,
        path: Option<String>,
        executable: Option<String>,
        native_code: NativeErrorCode,
        native_reason: String,
    },
    #[error("io_error: {0}")]
    Io(String),
    #[error("too_large: {0}")]
    TooLarge(String),
    #[error("binary_detected: {0}")]
    BinaryDetected(String),
    #[error("invalid_url: {0}")]
    InvalidUrl(String),
    #[error("blocked_host: {0}")]
    BlockedHost(String),
    #[error("invalid_tz: {0}")]
    InvalidTz(String),
    #[error("blocked_cmd: {0}")]
    BlockedCmd(String),
    #[error("cwd_not_found: {path}: {native_reason}")]
    CwdNotFound {
        path: String,
        native_code: NativeErrorCode,
        native_reason: String,
    },
    #[error("cwd_not_directory: {path}")]
    CwdNotDirectory { path: String },
    #[error("cwd_outside_roots: {path} (not inside allowed roots: {allowed_roots:?})")]
    CwdOutsideRoots {
        path: String,
        allowed_roots: Vec<String>,
    },
    #[error("executable_not_found: {executable}: {native_reason}")]
    ExecutableNotFound {
        executable: String,
        native_code: NativeErrorCode,
        native_reason: String,
    },
    #[error("windows_builtin_requires_cmd: {builtin}")]
    WindowsBuiltinRequiresCmd {
        builtin: String,
        suggested_call: ShellSuggestedCall,
        required_allowlist_entry: String,
    },
    #[error("spawn_failed: {executable}: {native_reason}")]
    SpawnFailed {
        executable: String,
        native_code: NativeErrorCode,
        native_reason: String,
    },
    #[error("timeout")]
    Timeout,
    #[error("aborted")]
    Aborted,
    #[error("http_error: {0}")]
    HttpError(String),
    #[error("non_text_content: {0}")]
    NonTextContent(String),
}

/// Native I/O codes are numeric when the OS supplies `raw_os_error()`. Rust's
/// process lookup can also synthesize only an `ErrorKind`; retain that kind as
/// a string instead of dropping the code field.
#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum NativeErrorCode {
    Os(i32),
    Kind(String),
}

/// Machine-readable correction returned when a Windows cmd.exe builtin was
/// requested as though it were a standalone executable. This is guidance only:
/// the caller must submit it as a new approval-controlled tool call, and `cmd`
/// must pass the ordinary binary allowlist.
#[derive(Debug, Serialize)]
pub struct ShellSuggestedCall {
    pub cmd: String,
    pub args: Vec<String>,
}

/// Success envelope. Always `serde_json::Value` so the renderer can
/// pass tool results through untyped (each tool's zod schema validates
/// the shape on the JS side).
pub type ToolOk = serde_json::Value;

/* ------------------------------------------------------------------ */
/*  Cancellation registry                                                */
/* ------------------------------------------------------------------ */

/// In-flight native work the JS side may need to cancel. Shell, web fetch,
/// web search, grep, glob, read_file, read_pdf, apply_patch, analyze_images,
/// and model-stream relays
/// register a token. Resource ownership stays with the operation future; the
/// registry is only the abort bridge. Short write/list operations do not
/// register.
///
/// Registered operations race their work against this token, avoiding an
/// un-abortable ownership gap.
pub struct ToolHandle(pub tokio_util::sync::CancellationToken);

/// Per-handle metadata stored alongside the handle.
pub struct ToolRegistryEntry {
    pub handle: ToolHandle,
    /// Phase 2.1: Optional execution-group identity for batch abort.
    pub group_id: Option<String>,
}

/// Process-global registry. `OnceLock<Mutex<HashMap<call_id, entry>>>`
/// avoids a `lazy_static` dep and is stable since Rust 1.70 (MSRV is
/// 1.77 — see `src-tauri/Cargo.toml`).
static TOOL_REGISTRY: OnceLock<Mutex<HashMap<String, ToolRegistryEntry>>> = OnceLock::new();

pub fn registry() -> &'static Mutex<HashMap<String, ToolRegistryEntry>> {
    TOOL_REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

/// RAII guard: when this struct drops, the registry entry is removed.
/// On Ok, Err, or panic, cleanup runs automatically. Belt-and-braces
/// alongside the explicit `abort_tool_calls` path.
pub struct ToolRegistryGuard {
    pub call_id: String,
}

impl Drop for ToolRegistryGuard {
    fn drop(&mut self) {
        registry()
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&self.call_id);
    }
}

/// Abort one or more in-flight tool calls by their `call_id`. The JS
/// runner sets up the `call_id` per-call (UUIDv4) and registers an
/// `addEventListener('abort', ...)` that calls this when the chat's
/// AbortSignal fires. Returns the number of registered operations for
/// which cancellation was requested so the JS side can log / surface a toast.
#[tauri::command]
pub async fn abort_tool_calls(call_ids: Vec<String>) -> Result<u32, ToolError> {
    let handles: Vec<ToolHandle> = {
        let mut reg = registry().lock().unwrap_or_else(|p| p.into_inner());
        call_ids
            .into_iter()
            .filter_map(|id| reg.remove(&id).map(|entry| entry.handle))
            .collect()
    };
    let killed = handles.len() as u32;
    for handle in handles {
        handle.0.cancel();
    }
    Ok(killed)
}

/// Phase 2.1: Abort all in-flight tool calls belonging to an
/// execution group. Useful when the orchestrator wants to cancel
/// every native child of one model tool call (e.g. all research
/// fetches, all image analysis sub-requests) at once.
///
/// Returns the number of registered operations for which cancellation was requested.
#[tauri::command]
pub async fn abort_group(group_id: String) -> Result<u32, ToolError> {
    let handles: Vec<ToolHandle> = {
        let mut reg = registry().lock().unwrap_or_else(|p| p.into_inner());
        let to_kill: Vec<String> = reg
            .iter()
            .filter(|(_, entry)| entry.group_id.as_deref() == Some(&group_id))
            .map(|(id, _)| id.clone())
            .collect();
        to_kill
            .into_iter()
            .filter_map(|id| reg.remove(&id).map(|entry| entry.handle))
            .collect()
    };
    let killed = handles.len() as u32;
    for handle in handles {
        handle.0.cancel();
    }
    Ok(killed)
}

/// Register a tool handle in the process-global registry and return a
/// guard that removes the entry when it goes out of scope. The guard
/// is the safety net for every exit path (Ok, Err, panic) — paired
/// with `take` if a caller needs to remove and reclaim a handle before
/// the call's main work completes.
///
/// Phase 2.1: Accepts optional `group_id` for batch abort via
/// `abort_group`. When set, the entry is indexed for group lookup.
#[allow(dead_code)]
pub fn register(call_id: String, handle: ToolHandle) -> ToolRegistryGuard {
    register_with_group(call_id, handle, None)
}

/// Phase 2.1: Register with an optional execution-group identity.
pub fn register_with_group(
    call_id: String,
    handle: ToolHandle,
    group_id: Option<String>,
) -> ToolRegistryGuard {
    registry()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(call_id.clone(), ToolRegistryEntry { handle, group_id });
    ToolRegistryGuard { call_id }
}

/// Remove a handle from the registry. Returns `None` if no entry
/// exists (e.g. `abort_tool_calls` already removed and killed it —
/// callers should treat that as `Aborted`).
#[allow(dead_code)]
pub fn take(call_id: &str) -> Option<ToolHandle> {
    registry()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .remove(call_id)
        .map(|entry| entry.handle)
}

/// Deterministic synchronization for cancellation integration tests.
///
/// A production worker calls `hit` only after the native event under test has
/// happened. The test waits for that event, aborts through this registry, and
/// then releases the worker. This module is absent from non-test builds.
#[cfg(test)]
pub(crate) mod test_support {
    use std::collections::HashMap;
    use std::sync::{Arc, Condvar, Mutex, OnceLock};
    use std::time::Duration;

    #[derive(Default)]
    struct CheckpointState {
        hits: usize,
        released: bool,
    }

    type SharedState = Arc<(Mutex<CheckpointState>, Condvar)>;

    static CHECKPOINTS: OnceLock<Mutex<HashMap<String, SharedState>>> = OnceLock::new();

    fn checkpoints() -> &'static Mutex<HashMap<String, SharedState>> {
        CHECKPOINTS.get_or_init(|| Mutex::new(HashMap::new()))
    }

    pub(crate) struct BlockingCheckpoint {
        key: String,
        state: SharedState,
    }

    impl BlockingCheckpoint {
        pub(crate) fn install(key: String) -> Self {
            let state = Arc::new((Mutex::new(CheckpointState::default()), Condvar::new()));
            let previous = checkpoints()
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .insert(key.clone(), state.clone());
            assert!(
                previous.is_none(),
                "checkpoint key already installed: {key}"
            );
            Self { key, state }
        }

        pub(crate) fn wait_for_hits(&self, expected: usize, timeout: Duration) -> bool {
            let (lock, condition) = &*self.state;
            let state = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            let (state, _) = condition
                .wait_timeout_while(state, timeout, |state| state.hits < expected)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            state.hits >= expected
        }

        pub(crate) fn release(&self) {
            let (lock, condition) = &*self.state;
            let mut state = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            state.released = true;
            condition.notify_all();
        }

        pub(crate) fn hits(&self) -> usize {
            self.state
                .0
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .hits
        }
    }

    impl Drop for BlockingCheckpoint {
        fn drop(&mut self) {
            self.release();
            checkpoints()
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .remove(&self.key);
        }
    }

    pub(crate) fn hit(key: &str) {
        let state = checkpoints()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(key)
            .cloned();
        let Some(state) = state else {
            return;
        };

        let (lock, condition) = &*state;
        let mut state = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        state.hits += 1;
        condition.notify_all();
        while !state.released {
            state = condition
                .wait(state)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
    }
}

/* ------------------------------------------------------------------ */
/*  Registration helpers                                                 */
/* ------------------------------------------------------------------ */

// Required to anchor the `#[derive(Error)]` impl — empty body.
impl ToolError {}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio_util::sync::CancellationToken;

    #[tokio::test]
    async fn abort_group_cancels_only_matching_children() {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let group = format!("group-{unique}");
        let first = CancellationToken::new();
        let second = CancellationToken::new();
        let unrelated = CancellationToken::new();
        let _first_guard = register_with_group(
            format!("first-{unique}"),
            ToolHandle(first.clone()),
            Some(group.clone()),
        );
        let _second_guard = register_with_group(
            format!("second-{unique}"),
            ToolHandle(second.clone()),
            Some(group.clone()),
        );
        let _unrelated_guard = register_with_group(
            format!("unrelated-{unique}"),
            ToolHandle(unrelated.clone()),
            Some(format!("other-{unique}")),
        );

        assert_eq!(abort_group(group).await.unwrap(), 2);
        assert!(first.is_cancelled());
        assert!(second.is_cancelled());
        assert!(!unrelated.is_cancelled());
    }
}
