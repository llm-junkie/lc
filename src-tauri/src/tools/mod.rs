//! Tool-call Tauri commands. See `docs/tools/tools.md` for the
//! full tool catalog and `docs/security.md` for the sandbox
//! design.
//!
//! Module layout:
//! - [`registry`] — `ToolError`, `ToolHandle`, in-flight registry,
//!   `ToolRegistryGuard`, `register` / `take` helpers,
//!   `abort_tool_calls`, and `abort_group`.
//! - [`file_tx`] — shared file transaction service (staging,
//!   flush+fsync, atomic replacement) used by write_file, edit,
//!   and apply_patch.
//! - [`fs_ops`] — file tools (`read_file`, `write_file`, `list_dir`),
//!   image/stat helpers, and the canonical path sandbox.
//! - [`edit`] — exact-string, single-target transactional edits.
//! - [`apply_patch`] — strict native patch parsing, preflight binding,
//!   and per-file transactional commits.
//! - [`glob`] — bounded recursive path matching.
//! - [`grep`] — bounded, cancellation-aware content search.
//! - [`web`] — `tool_web_fetch` with SSRF blocklist, body cap, and
//!   `CancellationToken` registration.
//! - [`web_search`] — Brave / SearXNG / Marginalia search with cancellation.
//! - [`shell`] — `tool_run_shell` with binary allowlist, env
//!   scrubbing, I/O caps, and cancellation-token registration. The
//!   child remains local to the shell future.
//!
//! `get_current_time` is intentionally absent from every module —
//! it's a pure-JS tool (the model can't influence `new Date()`, no
//! point round-tripping through Rust).

// Must be `pub mod` (not `mod`) — Tauri 2's `generate_handler!`
// generates per-command `__cmd__*` helper items in the source module
// and resolves them at the path passed to it. `lib.rs` references
// `tools::registry::abort_tool_calls` etc., so the submodules must
// be reachable across the crate root boundary.
pub mod apply_patch;
pub mod edit;
pub mod file_tx;
pub mod fs_ops;
pub mod glob;
pub mod grep;
pub mod pdf;
pub mod model_request;
pub mod process_file_lock;
pub mod registry;
pub mod shell;
pub mod web;
pub mod web_search;

// Re-export the cross-module types so callers can write
// `tools::ToolError` instead of `tools::registry::ToolError`. We
// do NOT re-export the `#[tauri::command]` functions here — Tauri 2's
// `generate_handler!` macro generates per-command `__cmd__*` helpers
// in the source module and looks them up at the path passed in. A
// `pub use` re-export hides the original module path, so the macro
// can't find its helpers. `lib.rs`'s `invoke_handler!` therefore
// references the submodules directly (`tools::fs_ops::tool_read_file`).
pub use registry::{ToolError, ToolHandle, ToolOk};
