//! `tool_run_shell` — execute a shell command with binary allowlist,
//! env scrubbing, I/O caps, timeout, and cancellation-token registration.
//! See `docs/security.md` for the sandbox design and
//! `docs/tools/tools.md` for the tool catalog.

use super::registry::NativeErrorCode;
// Only `windows_builtin_error` names this type; it is itself
// windows-only, so the import follows the same gate.
#[cfg(target_os = "windows")]
use super::registry::ShellSuggestedCall;
use super::{ToolError, ToolHandle, ToolOk};
use serde::Deserialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tokio::io::{AsyncRead, AsyncReadExt};

const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const HARD_CAP_TIMEOUT_MS: u64 = 120_000; // docs/tools/tool-reference.md, lc_run_shell

fn effective_timeout_ms(requested: Option<u64>) -> u64 {
    requested
        .unwrap_or(DEFAULT_TIMEOUT_MS)
        .min(HARD_CAP_TIMEOUT_MS)
}
const OUTPUT_CAP_BYTES: u64 = 1024 * 1024; // 1 MiB per stream; docs/security.md, Output Caps
const STDIN_CAP_BYTES: usize = 1024 * 1024; // 1 MiB of UTF-8 data

/// Commands implemented by cmd.exe rather than standalone Windows programs.
/// Keep this aligned with `WINDOWS_CMD_BUILTINS` in
/// `src/modules/chat-pipeline/windows-cmd.ts`.
#[cfg(target_os = "windows")]
const WINDOWS_CMD_BUILTINS: &[&str] = &[
    "assoc", "break", "call", "cd", "chdir", "cls", "color", "copy", "date", "del", "dir", "echo",
    "endlocal", "erase", "exit", "for", "ftype", "goto", "if", "md", "mkdir", "mklink", "move",
    "path", "pause", "popd", "prompt", "pushd", "rd", "rem", "ren", "rename", "rmdir", "set",
    "setlocal", "shift", "start", "time", "title", "type", "ver", "verify", "vol",
];

/// Default safe binary allowlist. The user can edit this in settings
/// (Phase 3). This initial default includes common POSIX utilities
/// plus shells and a couple of scripting runtimes. Cross-platform
/// entries are accepted on Windows too (cmd / git / node etc. are
/// usually present); some won't be found and `spawn` will fail with
/// a clear error, which is the correct behavior.
const SAFE_ALLOWLIST: &[&str] = &[
    "sh", "bash", "zsh", "dash", "node", "python3", "git", "ls", "cat", "head", "tail", "grep",
    "rg", "find", "wc", "echo", "printf", "pwd", "date", "true", "false", "test", "[",
];

/// Env vars we explicitly pass through from parent to child. The plan
/// §6.3.4 list — PATH for command lookup, HOME/USERPROFILE for
/// home-relative scripts, LANG/LC_ALL for locale-aware output,
/// TZ for time-handling code.
/// On Windows, SystemRoot/windir/COMSPEC are needed for PowerShell
/// and other system tools to find their runtime DLLs.
const SAFE_PARENT_VARS: &[&str] = &[
    "PATH",
    "HOME",
    "USERPROFILE",
    "LANG",
    "LC_ALL",
    "TZ",
    "SystemRoot",
    "windir",
    "COMSPEC",
];

/// Env vars we *forbid* — set them to empty in the child so anything
/// inside the binary that consults them gets a deterministic value
/// rather than inheriting the parent's environment. See docs/security.md.
const FORBIDDEN_VARS: &[&str] = &[
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "DYLD_INSERT_LIBRARIES",
    "NODE_OPTIONS",
    "PYTHONSTARTUP",
    "BASH_ENV",
    "ENV",
    "PS4",
    "PROMPT_COMMAND",
];

/// Regex matching secret-shaped user-override names (case-insensitive).
/// Parent variables are governed by `SAFE_PARENT_VARS` instead: variables
/// outside that allowlist are never copied into the child. See docs/security.md.
fn secret_var_re() -> &'static regex::Regex {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| {
        regex::Regex::new(r"(?i)(SECRET|TOKEN|API_KEY|KEY|PASSWORD|PASS|PRIVATE)").unwrap()
    })
}

/// Wire request from the JS runner. `call_id` is a UUIDv4 for the
/// abort registry. `env` is a map of *user-requested* overrides that
/// the model wants set on the child — these pass through the
/// scrubbing filter like any other input.
///
/// Phase 2.1: `group_id` links this operation to its parent model
/// tool call group so `abort_group` can cancel all children at once.
#[derive(Debug, Deserialize)]
pub struct RunShellRequest {
    pub cmd: String,
    pub args: Option<Vec<String>>,
    pub cwd: Option<String>,
    pub timeout_ms: Option<u64>,
    pub env: Option<HashMap<String, String>>,
    pub call_id: String,
    pub group_id: Option<String>,
    pub allowed_roots: Option<Vec<String>>,
    /// Optional user-configured binary allowlist (from JS settings).
    /// When provided, this overrides the hardcoded SAFE_ALLOWLIST.
    /// Comma-separated basenames like "sh,bash,git,node,cmd,dir".
    pub allowlist: Option<String>,
    /// Optional data to pipe to the child's stdin (capped at 1 MiB UTF-8).
    pub stdin: Option<String>,
}

fn resolve_shell_cwd(raw: Option<&str>, roots: &[PathBuf]) -> Result<PathBuf, ToolError> {
    let raw_cwd = raw.filter(|s| !s.trim().is_empty());
    let (display_path, candidate) = match raw_cwd {
        Some(cwd) => {
            let resolved = match super::fs_ops::resolve_under_roots(cwd, roots) {
                Ok(path) => path,
                Err(ToolError::PathOutsideRoots {
                    path,
                    allowed_roots,
                }) => {
                    return Err(ToolError::CwdOutsideRoots {
                        path,
                        allowed_roots,
                    });
                }
                Err(error) => return Err(error),
            };
            (cwd.to_string(), resolved)
        }
        None => {
            let path = roots.first().cloned().unwrap_or_else(std::env::temp_dir);
            (path.to_string_lossy().into_owned(), path)
        }
    };

    let metadata = std::fs::metadata(&candidate).map_err(|error| match error.kind() {
        std::io::ErrorKind::NotFound => ToolError::CwdNotFound {
            path: display_path.clone(),
            native_code: native_error_code(&error),
            native_reason: error.to_string(),
        },
        std::io::ErrorKind::PermissionDenied => ToolError::PermissionDenied {
            operation: "resolve cwd".to_string(),
            path: Some(display_path.clone()),
            executable: None,
            native_code: native_error_code(&error),
            native_reason: error.to_string(),
        },
        _ => ToolError::Io(format!("failed to inspect cwd {display_path}: {error}")),
    })?;
    if !metadata.is_dir() {
        return Err(ToolError::CwdNotDirectory { path: display_path });
    }

    Ok(candidate)
}

fn native_error_code(error: &std::io::Error) -> NativeErrorCode {
    match error.raw_os_error() {
        Some(code) => NativeErrorCode::Os(code),
        None => NativeErrorCode::Kind(format!("{:?}", error.kind())),
    }
}

/// Split a command line into argv, respecting single and double
/// quotes.  Quoted spans are treated as a single argument with the
/// surrounding quote characters stripped.  This is intentionally
/// minimal — no escape handling, no variable expansion — just enough
/// to keep `python -c "print('hello world')"` intact.
///
/// Returns `(binary, leading_args)`.  If the string is empty or only
/// whitespace, binary is the empty string.
fn split_cmd(cmd: &str) -> (String, Vec<String>) {
    let mut args: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut in_quote: Option<char> = None;
    for ch in cmd.chars() {
        match in_quote {
            Some(q) if ch == q => {
                in_quote = None;
            }
            Some(_) => {
                current.push(ch);
            }
            None if ch == '"' || ch == '\'' => {
                in_quote = Some(ch);
            }
            None if ch.is_whitespace() => {
                if !current.is_empty() {
                    args.push(std::mem::take(&mut current));
                }
            }
            None => {
                current.push(ch);
            }
        }
    }
    // Flush final token (closing quote may have been omitted).
    if !current.is_empty() {
        args.push(current);
    }
    let binary = args.first().cloned().unwrap_or_default();
    let leading = if args.len() > 1 {
        args[1..].to_vec()
    } else {
        Vec::new()
    };
    (binary, leading)
}

fn executable_basename(executable: &str) -> &str {
    Path::new(executable)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(executable)
}

#[cfg(target_os = "windows")]
fn is_windows_cmd_builtin(executable: &str) -> bool {
    let basename = executable_basename(executable).to_ascii_lowercase();
    WINDOWS_CMD_BUILTINS.contains(&basename.as_str())
}

#[cfg(target_os = "windows")]
fn quote_windows_cmd_tail_token(token: &str) -> String {
    if token.is_empty() || (token.chars().any(char::is_whitespace) && !token.contains('"')) {
        format!("\"{token}\"")
    } else {
        token.to_string()
    }
}

#[cfg(target_os = "windows")]
fn join_windows_cmd_tail<'a>(tokens: impl IntoIterator<Item = &'a str>) -> String {
    tokens
        .into_iter()
        .map(quote_windows_cmd_tail_token)
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(target_os = "windows")]
fn windows_builtin_error(
    executable: &str,
    leading_args: &[String],
    explicit_args: &[String],
) -> ToolError {
    let builtin = executable_basename(executable).to_ascii_lowercase();
    let tail = join_windows_cmd_tail(
        std::iter::once(builtin.as_str())
            .chain(leading_args.iter().map(String::as_str))
            .chain(explicit_args.iter().map(String::as_str)),
    );
    ToolError::WindowsBuiltinRequiresCmd {
        builtin,
        suggested_call: ShellSuggestedCall {
            cmd: "cmd".to_string(),
            args: vec!["/d".to_string(), "/u".to_string(), "/c".to_string(), tail],
        },
        required_allowlist_entry: "cmd".to_string(),
    }
}

fn classify_spawn_error(executable: &str, error: std::io::Error) -> ToolError {
    let native_code = native_error_code(&error);
    let native_reason = error.to_string();
    match error.kind() {
        std::io::ErrorKind::NotFound => ToolError::ExecutableNotFound {
            executable: executable.to_string(),
            native_code,
            native_reason,
        },
        std::io::ErrorKind::PermissionDenied => ToolError::PermissionDenied {
            operation: "spawn executable".to_string(),
            path: None,
            executable: Some(executable.to_string()),
            native_code,
            native_reason,
        },
        _ => ToolError::SpawnFailed {
            executable: executable.to_string(),
            native_code,
            native_reason,
        },
    }
}

#[cfg(target_os = "windows")]
fn configure_process_args(command: &mut std::process::Command, executable: &str, argv: &[String]) {
    use std::os::windows::process::CommandExt;

    let basename = executable_basename(executable).to_ascii_lowercase();
    let is_cmd = basename == "cmd" || basename == "cmd.exe";
    let command_index = argv.iter().position(|arg| arg.eq_ignore_ascii_case("/c"));
    if is_cmd {
        if let Some(index) = command_index.filter(|index| *index + 1 < argv.len()) {
            command.args(&argv[..=index]);
            let tail = if argv.len() == index + 2 {
                argv[index + 1].clone()
            } else {
                join_windows_cmd_tail(argv[index + 1..].iter().map(String::as_str))
            };
            // cmd.exe does not follow the C runtime quoting rules used by
            // Command::arg. Append its /c command string literally, inside the
            // extra outer quote pair cmd.exe expects. Inner quotes stay intact.
            command.raw_arg(format!("\"{tail}\""));
            return;
        }
    }
    command.args(argv);
}

#[cfg(not(target_os = "windows"))]
fn configure_process_args(command: &mut std::process::Command, _executable: &str, argv: &[String]) {
    command.args(argv);
}

#[tauri::command]
pub async fn tool_run_shell(mut req: RunShellRequest) -> Result<ToolOk, ToolError> {
    let timeout_ms = effective_timeout_ms(req.timeout_ms);

    // 0. Reject empty/whitespace-only cmd early.
    let raw_cmd = req.cmd.trim();
    if raw_cmd.is_empty() {
        return Err(ToolError::Io("empty command".into()));
    }
    let (spawn_cmd, extra_args) = split_cmd(raw_cmd);

    // 1. Binary allowlist. The canonical shape puts only the executable in
    //    `cmd`, but archived/model calls may still put a full command there.
    //    The compatibility splitter extracts its first quote-aware token, then
    //    the basename check uses the user-configured allowlist from JS.
    let cmd_basename = executable_basename(&spawn_cmd);
    let dynamic_allowlist: Option<Vec<&str>> = req.allowlist.as_ref().map(|s| {
        s.split(',')
            .map(|entry| entry.trim())
            .filter(|e| !e.is_empty())
            .collect()
    });
    // Secret master virtual binary: if "*****" is in the allowlist,
    // any binary is permitted — the allowlist check is bypassed.
    // The permission popup still fires on every invocation.
    //
    // Secret grandmaster virtual binary: "*******" (7 stars) implies
    // the master behavior (any binary) AND auto-approves on the JS
    // orchestrator side (no permission popup). Here it only relaxes
    // the binary-name check, exactly like "*****" — the popup
    // suppression is a JS-side decision and is invisible to Rust.
    let has_master = dynamic_allowlist
        .as_ref()
        .is_some_and(|list| list.contains(&"*****") || list.contains(&"*******"));
    let allowed = if has_master {
        true
    } else if let Some(ref list) = dynamic_allowlist {
        // Normalize case-insensitive comparison on Windows.
        #[cfg(target_os = "windows")]
        {
            let lower = cmd_basename.to_lowercase();
            list.iter().any(|e| e.to_lowercase() == lower)
        }
        #[cfg(not(target_os = "windows"))]
        {
            list.contains(&cmd_basename)
        }
    } else {
        #[cfg(target_os = "windows")]
        {
            let lower = cmd_basename.to_lowercase();
            SAFE_ALLOWLIST.iter().any(|e| e.to_lowercase() == lower)
        }
        #[cfg(not(target_os = "windows"))]
        {
            SAFE_ALLOWLIST.contains(&cmd_basename)
        }
    };
    if !allowed {
        return Err(ToolError::BlockedCmd(cmd_basename.to_string()));
    }

    // 2. Argv NUL check — defensive: a NUL byte in argv can cause
    //    C-string truncation in the child, allowing an attacker to
    //    pass arguments that look one way to our check and another
    //    way to the binary. Reject the whole call.
    for arg in req.args.as_deref().unwrap_or(&[]) {
        if arg.contains('\0') {
            return Err(ToolError::Io("argument contains NUL byte".into()));
        }
    }

    // Keep the native boundary authoritative. JS performs the same byte
    // check for early feedback, but direct IPC callers must not bypass it.
    validate_stdin_size(req.stdin.as_deref())?;

    #[cfg(target_os = "windows")]
    if is_windows_cmd_builtin(&spawn_cmd) {
        return Err(windows_builtin_error(
            &spawn_cmd,
            &extra_args,
            req.args.as_deref().unwrap_or(&[]),
        ));
    }

    // 3. CWD resolution.  The binary allowlist (step 1) is the real
    //    security boundary — shell commands can target arbitrary paths
    //    regardless of working directory, so restricting the CWD to
    //    allowed_roots adds friction without meaningful security.
    //
    //    - If the model supplies an explicit `cwd`, resolve it under
    //      the allowed roots (same sandbox as file tools).
    //    - Otherwise default to the first allowed root.
    //    - If no roots are configured either, fall back to the system
    //      temp directory so commands like `echo`, `date`, and
    //      `whoami` work out of the box.
    let roots = super::fs_ops::merged_roots(req.allowed_roots.as_deref().unwrap_or(&[]));
    let cwd_canon = resolve_shell_cwd(req.cwd.as_deref(), &roots)?;

    // 4. Build scrubbed env (parent SAFE_PARENT_VARS only, forbidden
    //    vars set to empty, then non-forbidden/non-secret overrides).
    let safe_env = build_safe_env(req.env.as_ref())?;

    // 5. Spawn the child. We DON'T go through a shell — `Command`
    //    + `args` as a Vec<String> invokes the binary directly via
    //    `execve`, so shell metacharacters in args are inert. This
    //    eliminates the entire class of "model injects `; rm -rf ~`"
    //    attacks.
    //
    //    The `cmd` string is split into argv with basic quote
    //    awareness (both ' and ").  Without this, `python -c
    //    "print('hello world')"` would split at the space inside
    //    the quoted code, breaking the command.
    let started_at = Instant::now();
    let needs_stdin = req.stdin.as_ref().is_some_and(|s| !s.is_empty());

    // Build argv: split_cmd args + user-supplied args.
    let argv: Vec<String> = extra_args
        .iter()
        .chain(req.args.as_deref().unwrap_or(&[]).iter())
        .cloned()
        .collect();

    // On Windows, CREATE_NO_WINDOW prevents a console window from
    // flashing when spawning child processes in production builds.
    // In dev mode the parent already has a console, so no new window
    // is created either way — but in production (Windows subsystem),
    // Windows allocates a new console for each child by default.
    //
    // We build a std::process::Command first (which supports
    // creation_flags via CommandExt), then convert to tokio's async
    // Command via From.
    let mut std_cmd = std::process::Command::new(&spawn_cmd);
    configure_process_args(&mut std_cmd, &spawn_cmd, &argv);
    std_cmd
        .env_clear()
        .envs(&safe_env)
        .current_dir(&cwd_canon)
        .stdin(if needs_stdin {
            std::process::Stdio::piped()
        } else {
            std::process::Stdio::null()
        })
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        std_cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Descendants inherit this process group, allowing cancellation and
        // timeout to kill the complete tree with one group signal.
        std_cmd.process_group(0);
    }
    let mut cmd: tokio::process::Command = std_cmd.into();

    let mut child = cmd
        .spawn()
        .map_err(|error| classify_spawn_error(&spawn_cmd, error))?;

    // Write stdin in a background task so a slow-reading child can't
    // block the main read loop.
    if let Some(stdin_data) = req.stdin.take() {
        if !stdin_data.is_empty() {
            if let Some(mut stdin) = child.stdin.take() {
                tokio::spawn(async move {
                    use tokio::io::AsyncWriteExt;
                    let _ = stdin.write_all(stdin_data.as_bytes()).await;
                    // Drop closes stdin → EOF to the child.
                });
            }
        }
    }

    // Capture the streams BEFORE inserting into the registry — child
    // is owned by us until we register.
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| ToolError::Io("child stdout missing".into()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| ToolError::Io("child stderr missing".into()))?;

    // 6. Register cancellation token for abort — Phase 2.2 fix.
    //    Instead of putting the Child in the registry and taking it
    //    back before wait() (which creates an un-abortable window),
    //    we register a CancellationToken.  abort_tool_calls cancels
    //    the token, and we race child.wait() against it below.
    //    The child itself stays local — we kill it directly if the
    //    token fires or if the timeout elapses.
    let cancel_token = tokio_util::sync::CancellationToken::new();
    let _guard = super::registry::register_with_group(
        req.call_id.clone(),
        ToolHandle(cancel_token.clone()),
        req.group_id.clone(),
    );

    // 7. Spawn output readers concurrently with the wait. They're
    //    bounded by OUTPUT_CAP_BYTES — anything beyond is dropped
    //    and `truncated: true` is set in the result.
    let stdout_task = tokio::spawn(read_capped(stdout, OUTPUT_CAP_BYTES));
    let stderr_task = tokio::spawn(read_capped(stderr, OUTPUT_CAP_BYTES));

    // 8. Wait for the child, racing against cancellation and timeout.
    //    Phase 2.2: The child never enters the registry — the
    //    CancellationToken is the abort bridge.  abort_tool_calls
    //    cancels it, and we kill the child locally.  This eliminates
    //    the un-abortable window between take() and wait().
    let timeout = Duration::from_millis(timeout_ms);
    let waited = tokio::select! {
        _ = cancel_token.cancelled() => {
            // Abort was requested. Kill the child and return Aborted.
            // Keep tree-kill before wait/reap: while the child is unreaped it
            // retains its PID, so the negative-PID Unix group signal cannot
            // be redirected to an unrelated process group by PID reuse.
            kill_entire_tree(&mut child);
            let _ = child.wait().await;
            Err(ToolError::Aborted)
        }
        result = tokio::time::timeout(timeout, child.wait()) => {
            match result {
                Ok(Ok(status)) => Ok(status),
                Ok(Err(e)) => Err(ToolError::Io(e.to_string())),
                Err(_timeout) => {
                    // Timeout: kill the child and return Timeout.
                    // This must remain before wait/reap for the same PID-reuse
                    // invariant as the cancellation branch above.
                    kill_entire_tree(&mut child);
                    let _ = child.wait().await;
                    Err(ToolError::Timeout)
                }
            }
        }
    };

    let duration_ms = started_at.elapsed().as_millis() as u64;

    // Join output readers — they should be done by now since the
    // child has exited (or been killed). If not, wait a bit.
    let stdout_pair = stdout_task.await.unwrap_or_default();
    let stderr_pair = stderr_task.await.unwrap_or_default();

    match waited {
        Ok(status) => Ok(serde_json::json!({
            "stdout": stdout_pair.0,
            "stderr": stderr_pair.0,
            "exit_code": status.code().unwrap_or(-1),
            "duration_ms": duration_ms,
            "timed_out": false,
            "stdout_truncated": stdout_pair.1,
            "stderr_truncated": stderr_pair.1,
        })),
        Err(ToolError::Aborted) => Err(ToolError::Aborted),
        Err(ToolError::Timeout) => {
            // Return structured timeout result — preserve captured
            // partial stdout/stderr with truncation flags so the
            // model can see what was produced before the timeout.
            Ok(serde_json::json!({
                "stdout": stdout_pair.0,
                "stderr": stderr_pair.0,
                "exit_code": null,
                "duration_ms": duration_ms,
                "timed_out": true,
                "stdout_truncated": stdout_pair.1,
                "stderr_truncated": stderr_pair.1,
            }))
        }
        Err(e) => Err(e),
    }
}

fn validate_stdin_size(stdin: Option<&str>) -> Result<(), ToolError> {
    let bytes = stdin.map(str::len).unwrap_or(0);
    if bytes > STDIN_CAP_BYTES {
        return Err(ToolError::TooLarge(format!(
            "stdin is {} bytes. The hard cap is {} bytes. Shorten stdin and retry.",
            bytes, STDIN_CAP_BYTES
        )));
    }
    Ok(())
}

fn is_forbidden_override(key: &str) -> bool {
    FORBIDDEN_VARS.iter().any(|forbidden| {
        if cfg!(target_os = "windows") {
            forbidden.eq_ignore_ascii_case(key)
        } else {
            *forbidden == key
        }
    })
}

/// Insert an override using the target platform's environment-key semantics.
/// Windows keys are case-insensitive, so preserve an inherited key's spelling
/// instead of creating an order-dependent duplicate such as `PATH` and `path`.
fn insert_user_override(env: &mut HashMap<String, String>, key: &str, value: &str) {
    #[cfg(windows)]
    if let Some(existing_key) = env
        .keys()
        .find(|existing| existing.eq_ignore_ascii_case(key))
        .cloned()
    {
        env.insert(existing_key, value.to_string());
        return;
    }

    env.insert(key.to_string(), value.to_string());
}

/// Build the scrubbed environment. See SAFE_PARENT_VARS / FORBIDDEN_VARS
/// docs. Exposed for testing — the test suite asserts on the exact
/// shape of the resulting env map.
fn build_safe_env(
    user_overrides: Option<&HashMap<String, String>>,
) -> Result<HashMap<String, String>, ToolError> {
    let mut env: HashMap<String, String> = HashMap::new();

    // Pass through safe parent vars only.
    for key in SAFE_PARENT_VARS {
        if let Ok(val) = std::env::var(key) {
            env.insert((*key).to_string(), val);
        }
    }

    // Explicitly clear forbidden vars. Even if the parent didn't
    // have them, set them empty so child processes that check see
    // a deterministic value (rather than inheriting something via
    // some other channel).
    for key in FORBIDDEN_VARS {
        env.insert((*key).to_string(), String::new());
    }

    // User-supplied overrides may replace safe pass-through values, but
    // cannot restore the explicit loader/runtime denylist. Secret-shaped
    // names are also dropped: if the model asks to set `MY_API_KEY`, it
    // never reaches the child process.
    if let Some(overrides) = user_overrides {
        let re = secret_var_re();
        for (k, v) in overrides {
            if is_forbidden_override(k) || re.is_match(k) {
                continue;
            }
            insert_user_override(&mut env, k, v);
        }
    }

    Ok(env)
}

/// Read from `reader` until EOF, capping at `cap` bytes. Returns
/// `(body, truncated)`. Excess bytes are drained (so the source
/// doesn't block on a full pipe) but discarded.
async fn read_capped<R: AsyncRead + Unpin>(mut reader: R, cap: u64) -> (String, bool) {
    let mut buf: Vec<u8> = Vec::new();
    let mut total: u64 = 0;
    let mut truncated = false;
    let mut chunk = [0u8; 4096];
    loop {
        match reader.read(&mut chunk).await {
            Ok(0) => break,
            Ok(n) => {
                if total + n as u64 > cap {
                    let allowed = (cap - total) as usize;
                    buf.extend_from_slice(&chunk[..allowed]);
                    truncated = true;
                    // Drain remaining bytes so the source can finish
                    // (the pipe would block otherwise on some OSes).
                    let mut drain = [0u8; 4096];
                    while reader
                        .read(&mut drain)
                        .await
                        .map(|m| m > 0)
                        .unwrap_or(false)
                    {}
                    break;
                } else {
                    buf.extend_from_slice(&chunk[..n]);
                    total += n as u64;
                }
            }
            Err(_) => break,
        }
    }
    (decode_output(&buf), truncated)
}

/// Decode a byte buffer to a String, transparently handling UTF-16
/// output from Windows processes (PowerShell, cmd /U, etc.).
///
/// Windows console programs often write UTF-16LE to their stdout/stderr
/// pipes.  Without this, `String::from_utf8_lossy` preserves the NUL
/// bytes interleaved between ASCII characters, producing garbled output
/// like `"I\u0000n\u0000t\u0000e\u0000r\u0000n\u0000a\u0000l\u0000..."`.
///
/// Detection strategy:
///   1. UTF-16LE BOM (0xFF 0xFE) → decode as UTF-16LE
///   2. UTF-16BE BOM (0xFE 0xFF) → decode as UTF-16BE
///   3. Heuristic: if >25 % of the first 256 bytes are NUL, it's
///      almost certainly UTF-16LE ASCII (common on Windows)
///   4. Fallback: standard lossy UTF-8
fn decode_output(buf: &[u8]) -> String {
    if buf.len() >= 2 {
        // UTF-16LE BOM
        if buf[0] == 0xFF && buf[1] == 0xFE {
            return String::from_utf16le_lossy(&buf[2..]);
        }
        // UTF-16BE BOM
        if buf[0] == 0xFE && buf[1] == 0xFF {
            return String::from_utf16be_lossy(&buf[2..]);
        }
    }
    // Heuristic: high NUL density → UTF-16LE (Windows default).
    let sample = &buf[..buf.len().min(256)];
    let nul_count = sample.iter().filter(|&&b| b == 0).count();
    if sample.len() >= 4 && nul_count > sample.len() / 4 {
        return String::from_utf16le_lossy(buf);
    }
    String::from_utf8_lossy(buf).into_owned()
}

/// Kill the child's ordinary process tree. Windows uses `taskkill /F /T`.
/// Unix shell-tool children are process-group leaders, so a negative-PID
/// SIGKILL targets the group atomically. Descendants that deliberately leave
/// the group with `setsid()` or `setpgid()` are outside this guarantee.
///
/// Unix safety invariant: this helper is valid only for a child created with
/// `process_group(0)`, and it must be called before that child is waited/reaped.
pub(crate) fn kill_entire_tree(child: &mut tokio::process::Child) {
    let pid = child.id();
    if pid.is_none() {
        let _ = child.start_kill();
        return;
    }
    let pid = pid.unwrap();

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Primary: taskkill /F /T (force tree kill).
        let result = std::process::Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
            .output();
        match result {
            Ok(output) if output.status.success() => {}
            Ok(output) => {
                eprintln!(
                    "taskkill /F /T /PID {} failed (exit {}): {}",
                    pid,
                    output.status,
                    String::from_utf8_lossy(&output.stderr).trim()
                );
            }
            Err(e) => {
                eprintln!("taskkill spawn failed for PID {}: {}", pid, e);
            }
        }
    }
    #[cfg(unix)]
    {
        if let Ok(group_id) = i32::try_from(pid) {
            // SAFETY: shell-tool children are created with process_group(0),
            // making this PID their process-group ID. Callers signal before
            // wait/reap, so PID reuse cannot redirect the negative-PID signal.
            let result = unsafe { libc::kill(-group_id, libc::SIGKILL) };
            if result != 0 {
                eprintln!(
                    "failed to kill process group {}: {}",
                    pid,
                    std::io::Error::last_os_error()
                );
            }
        } else {
            eprintln!("child PID {} does not fit a Unix process-group ID", pid);
        }
    }
    // Always kill the direct child too. This is the Windows fallback when
    // taskkill fails and the Unix fallback when the group signal fails.
    let _ = child.start_kill();
}

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    /// Compile this request builder on every platform. Unix-only tests use it,
    /// so a future RunShellRequest field also breaks the Windows build instead
    /// of being discovered only by a Linux or macOS CI leg.
    fn shell_req(cmd: &str, call_id: &str) -> RunShellRequest {
        RunShellRequest {
            cmd: cmd.to_string(),
            args: None,
            cwd: None,
            timeout_ms: None,
            env: None,
            call_id: call_id.to_string(),
            group_id: None,
            allowed_roots: None,
            allowlist: None,
            stdin: None,
        }
    }

    #[test]
    fn timeout_defaults_and_clamps_at_native_boundary() {
        assert_eq!(effective_timeout_ms(None), DEFAULT_TIMEOUT_MS);
        assert_eq!(
            effective_timeout_ms(Some(HARD_CAP_TIMEOUT_MS)),
            HARD_CAP_TIMEOUT_MS
        );
        assert_eq!(
            effective_timeout_ms(Some(HARD_CAP_TIMEOUT_MS + 1)),
            HARD_CAP_TIMEOUT_MS
        );
    }

    #[test]
    fn output_decoder_handles_both_utf16_byte_orders_and_malformed_input() {
        let text = "héllo \u{10437}";
        let mut le = vec![0xFF, 0xFE];
        let mut be = vec![0xFE, 0xFF];
        for unit in text.encode_utf16() {
            le.extend_from_slice(&unit.to_le_bytes());
            be.extend_from_slice(&unit.to_be_bytes());
        }

        assert_eq!(decode_output(&le), text);
        assert_eq!(decode_output(&be), text);

        le.push(b'x');
        assert_eq!(
            decode_output(&le),
            format!("{text}{}", char::REPLACEMENT_CHARACTER)
        );
    }

    /* ---------------- Binary allowlist ------------------------ */

    #[test]
    fn allowlist_accepts_safe_binaries() {
        for cmd in ["git", "node", "echo", "ls"] {
            let basename = Path::new(cmd).file_name().unwrap().to_str().unwrap();
            assert!(
                SAFE_ALLOWLIST.contains(&basename),
                "{} should be allowed",
                cmd
            );
        }
    }

    #[test]
    fn allowlist_rejects_unsafe_binaries() {
        for cmd in ["curl", "wget", "rm", "dd", "mkfs", "shutdown"] {
            assert!(
                !SAFE_ALLOWLIST.contains(&cmd),
                "{} should NOT be allowed",
                cmd
            );
        }
    }

    #[test]
    fn allowlist_check_uses_basename_only() {
        // A path-prefixed cmd still matches if basename is safe.
        let basename = Path::new("/usr/bin/git")
            .file_name()
            .unwrap()
            .to_str()
            .unwrap();
        assert!(SAFE_ALLOWLIST.contains(&basename));
    }

    /* ---------------- Argv NUL check -------------------------- */

    #[test]
    fn rejects_arg_with_nul_byte() {
        let bad_args = vec!["ok".to_string(), "with\0nul".to_string()];
        // Inline check — same as the production guard.
        for a in &bad_args {
            if a.contains('\0') {
                return; // pass
            }
        }
        panic!("expected NUL-byte detection");
    }

    /* ---------------- Env scrubbing --------------------------- */

    #[test]
    fn env_passes_through_safe_parent_vars() {
        let env = build_safe_env(None).unwrap();
        // HOME / USERPROFILE should be present on any real system.
        let has_home = env.contains_key("HOME") || env.contains_key("USERPROFILE");
        assert!(has_home, "expected HOME or USERPROFILE in scrubbed env");
    }

    #[test]
    fn env_clears_all_forbidden_vars() {
        let env = build_safe_env(None).unwrap();
        for key in FORBIDDEN_VARS {
            assert_eq!(env.get(*key).map(String::as_str), Some(""), "{key}");
        }
    }

    #[test]
    fn parent_env_is_strictly_allowlisted() {
        let env = build_safe_env(None).unwrap();
        let mut expected: HashSet<String> = FORBIDDEN_VARS
            .iter()
            .map(|key| (*key).to_string())
            .collect();
        expected.extend(
            SAFE_PARENT_VARS
                .iter()
                .filter(|key| std::env::var(key).is_ok())
                .map(|key| (*key).to_string()),
        );
        let actual: HashSet<String> = env.keys().cloned().collect();
        assert_eq!(actual, expected);
    }

    #[test]
    fn env_user_override_wins_over_safe_pass_through() {
        let mut overrides = HashMap::new();
        overrides.insert("PATH".to_string(), "lc-test-path".to_string());
        let env = build_safe_env(Some(&overrides)).unwrap();
        assert_eq!(env.get("PATH").map(String::as_str), Some("lc-test-path"));
    }

    #[test]
    fn env_user_override_drops_secret_shaped_keys() {
        let mut overrides = HashMap::new();
        overrides.insert("MY_API_KEY".to_string(), "should_be_dropped".to_string());
        overrides.insert("MY_NORMAL_VAR".to_string(), "kept".to_string());
        let env = build_safe_env(Some(&overrides)).unwrap();
        assert!(!env.contains_key("MY_API_KEY"));
        assert_eq!(env.get("MY_NORMAL_VAR").map(|s| s.as_str()), Some("kept"));
    }

    #[test]
    fn env_user_override_cannot_restore_forbidden_vars() {
        let overrides: HashMap<String, String> = FORBIDDEN_VARS
            .iter()
            .map(|key| ((*key).to_string(), "malicious".to_string()))
            .collect();
        let env = build_safe_env(Some(&overrides)).unwrap();
        for key in FORBIDDEN_VARS {
            assert_eq!(env.get(*key).map(String::as_str), Some(""), "{key}");
        }

        #[cfg(target_os = "windows")]
        {
            let mut lower = HashMap::new();
            lower.insert("node_options".to_string(), "malicious".to_string());
            let env = build_safe_env(Some(&lower)).unwrap();
            assert!(!env.contains_key("node_options"));
            assert_eq!(env.get("NODE_OPTIONS").map(String::as_str), Some(""));
        }
    }

    #[cfg(windows)]
    #[test]
    fn env_override_reuses_case_insensitive_windows_key() {
        let mut env = HashMap::from([("Path".to_string(), "parent".to_string())]);
        insert_user_override(&mut env, "PATH", "override");

        assert_eq!(env.len(), 1);
        assert_eq!(env.get("Path").map(String::as_str), Some("override"));
        assert!(!env.contains_key("PATH"));
    }

    #[test]
    fn stdin_cap_is_measured_in_utf8_bytes() {
        let exact = "x".repeat(STDIN_CAP_BYTES);
        assert!(validate_stdin_size(Some(&exact)).is_ok());

        let oversized = "漢".repeat(STDIN_CAP_BYTES / 3 + 1);
        assert!(oversized.len() > STDIN_CAP_BYTES);
        assert!(matches!(
            validate_stdin_size(Some(&oversized)),
            Err(ToolError::TooLarge(_))
        ));
    }

    #[tokio::test]
    async fn oversized_stdin_is_rejected_before_spawn() {
        let mut req = shell_req("echo", "test-stdin-cap");
        req.timeout_ms = Some(1000);
        req.stdin = Some("漢".repeat(STDIN_CAP_BYTES / 3 + 1));
        let result = tool_run_shell(req).await;
        assert!(matches!(result, Err(ToolError::TooLarge(_))));
    }

    #[test]
    fn cwd_uses_explicit_allowed_directory_then_first_root_then_temp() {
        let root =
            std::env::temp_dir().join(format!("lc-shell-cwd-{:016x}", rand::random::<u64>()));
        let child = root.join("child");
        let outside = root.with_extension("outside");
        std::fs::create_dir_all(&child).unwrap();
        std::fs::create_dir_all(&outside).unwrap();

        let explicit = resolve_shell_cwd(child.to_str(), std::slice::from_ref(&root)).unwrap();
        let canonical = std::fs::canonicalize(&child).unwrap();
        assert_eq!(
            explicit.to_string_lossy().trim_start_matches(r"\\?\"),
            canonical.to_string_lossy().trim_start_matches(r"\\?\")
        );
        assert!(matches!(
            resolve_shell_cwd(outside.to_str(), std::slice::from_ref(&root)),
            Err(ToolError::CwdOutsideRoots { path, .. }) if path == outside.to_string_lossy()
        ));
        assert_eq!(
            resolve_shell_cwd(None, std::slice::from_ref(&root)).unwrap(),
            root
        );
        assert_eq!(resolve_shell_cwd(None, &[]).unwrap(), std::env::temp_dir());

        std::fs::remove_dir_all(root).unwrap();
        std::fs::remove_dir_all(outside).unwrap();
    }

    #[test]
    fn nonexistent_cwd_has_a_cwd_specific_error() {
        let root = std::env::temp_dir().join(format!(
            "lc-shell-cwd-missing-{:016x}",
            rand::random::<u64>()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let missing = root.join("missing");

        let error = resolve_shell_cwd(missing.to_str(), std::slice::from_ref(&root))
            .expect_err("missing cwd must fail before spawn");
        match error {
            ToolError::CwdNotFound {
                path,
                native_reason,
                ..
            } => {
                assert_eq!(path, missing.to_string_lossy());
                assert!(!native_reason.is_empty());
            }
            other => panic!("expected CwdNotFound, got {other:?}"),
        }

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn file_used_as_cwd_has_a_not_directory_error() {
        let root =
            std::env::temp_dir().join(format!("lc-shell-cwd-file-{:016x}", rand::random::<u64>()));
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join("not-a-directory.txt");
        std::fs::write(&file, b"file").unwrap();

        let error = resolve_shell_cwd(file.to_str(), std::slice::from_ref(&root))
            .expect_err("file cwd must fail before spawn");
        assert!(
            matches!(error, ToolError::CwdNotDirectory { ref path } if path == &file.to_string_lossy()),
            "got {error:?}"
        );

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn spawn_errors_keep_native_classification_and_detail() {
        let missing = std::io::Error::from(std::io::ErrorKind::NotFound);
        assert!(matches!(
            classify_spawn_error("missing-program", missing),
            ToolError::ExecutableNotFound {
                executable,
                native_reason,
                ..
            } if executable == "missing-program" && !native_reason.is_empty()
        ));

        let denied = std::io::Error::from(std::io::ErrorKind::PermissionDenied);
        assert!(matches!(
            classify_spawn_error("denied-program", denied),
            ToolError::PermissionDenied {
                executable: Some(executable),
                native_reason,
                ..
            } if executable == "denied-program" && !native_reason.is_empty()
        ));

        let unknown = std::io::Error::other("native launch reason");
        assert!(matches!(
            classify_spawn_error("odd-program", unknown),
            ToolError::SpawnFailed {
                executable,
                native_reason,
                ..
            } if executable == "odd-program" && native_reason == "native launch reason"
        ));

        let serialized = serde_json::to_value(classify_spawn_error(
            "missing-program",
            std::io::Error::from(std::io::ErrorKind::NotFound),
        ))
        .unwrap();
        assert_eq!(serialized["code"], "ExecutableNotFound");
        assert_eq!(serialized["message"]["executable"], "missing-program");
        assert!(serialized["message"]["native_code"].is_string());
        assert!(serialized["message"]["native_reason"].is_string());
    }

    #[tokio::test]
    async fn unknown_executable_returns_native_not_found_detail() {
        let root = std::env::temp_dir().join(format!(
            "lc-shell-missing-executable-{:016x}",
            rand::random::<u64>()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let executable = format!("lc-definitely-missing-{:016x}", rand::random::<u64>());
        let mut req = shell_req(&executable, "test-missing-executable");
        req.cwd = Some(root.to_string_lossy().into_owned());
        req.allowed_roots = Some(vec![root.to_string_lossy().into_owned()]);
        req.allowlist = Some(executable.clone());

        let error = tool_run_shell(req)
            .await
            .expect_err("unknown executable must not become a process result");
        match error {
            ToolError::ExecutableNotFound {
                executable: actual,
                native_code,
                native_reason,
            } => {
                assert_eq!(actual, executable);
                assert!(matches!(
                    native_code,
                    NativeErrorCode::Os(_) | NativeErrorCode::Kind(_)
                ));
                assert!(!native_reason.is_empty());
            }
            other => panic!("expected ExecutableNotFound, got {other:?}"),
        }

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cwd_whitespace_only_falls_back_to_root_or_temp() {
        let root = std::env::temp_dir().join(format!(
            "lc-shell-cwd-ws-{:016x}",
            rand::random::<u64>()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let roots = vec![root.clone()];
        let resolved = resolve_shell_cwd(Some("   "), &roots).expect("whitespace cwd must fall back to first root");
        assert_eq!(resolved, root);

        let temp_fallback = resolve_shell_cwd(Some("   "), &[]).expect("whitespace cwd with no roots must fall back to temp");
        assert_eq!(temp_fallback, std::env::temp_dir());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "windows")]
    #[tokio::test]
    async fn bare_rmdir_returns_builtin_guidance_and_suggested_call() {
        let mut req = shell_req("rmdir", "test-bare-rmdir");
        req.args = Some(vec!["/s".into(), "/q".into(), "missing dir".into()]);
        req.allowlist = Some("rmdir".to_string());

        let error = tool_run_shell(req)
            .await
            .expect_err("bare builtin must not be sent to process lookup");
        match error {
            ToolError::WindowsBuiltinRequiresCmd {
                builtin,
                suggested_call,
                required_allowlist_entry,
            } => {
                assert_eq!(builtin, "rmdir");
                assert_eq!(required_allowlist_entry, "cmd");
                assert_eq!(suggested_call.cmd, "cmd");
                assert_eq!(
                    suggested_call.args,
                    ["/d", "/u", "/c", "rmdir /s /q \"missing dir\""]
                );
            }
            other => panic!("expected WindowsBuiltinRequiresCmd, got {other:?}"),
        }
    }

    #[cfg(target_os = "windows")]
    fn windows_cmd_req(root: &Path, tail: String, call_id: &str) -> RunShellRequest {
        let mut req = shell_req("cmd", call_id);
        req.args = Some(vec!["/d".into(), "/u".into(), "/c".into(), tail]);
        req.cwd = Some(root.to_string_lossy().into_owned());
        req.allowed_roots = Some(vec![root.to_string_lossy().into_owned()]);
        req.allowlist = Some("cmd".to_string());
        req.timeout_ms = Some(5_000);
        req
    }

    #[cfg(target_os = "windows")]
    #[tokio::test]
    async fn cmd_type_missing_is_a_completed_process_result() {
        let root = std::env::temp_dir().join(format!(
            "lc-shell-type-missing-{:016x}",
            rand::random::<u64>()
        ));
        std::fs::create_dir_all(&root).unwrap();

        let result = tool_run_shell(windows_cmd_req(
            &root,
            "type missing.txt".to_string(),
            "test-type-missing",
        ))
        .await
        .expect("cmd launched, so its nonzero exit must remain a process result");
        assert_ne!(result["exit_code"], 0);
        assert!(!result["stderr"].as_str().unwrap_or_default().is_empty());

        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "windows")]
    #[tokio::test]
    async fn repeated_rmdir_is_a_completed_process_result() {
        let root =
            std::env::temp_dir().join(format!("lc-shell-rmdir-{:016x}", rand::random::<u64>()));
        let target = root.join("doomed");
        std::fs::create_dir_all(&target).unwrap();

        let first = tool_run_shell(windows_cmd_req(
            &root,
            "rmdir /s /q doomed".to_string(),
            "test-rmdir-first",
        ))
        .await
        .expect("first rmdir must launch");
        assert_eq!(first["exit_code"], 0);

        let second = tool_run_shell(windows_cmd_req(
            &root,
            "rmdir /s /q doomed".to_string(),
            "test-rmdir-second",
        ))
        .await
        .expect("second rmdir still launched and must remain a process result");
        assert_ne!(second["exit_code"], 0);
        assert!(!second["stderr"].as_str().unwrap_or_default().is_empty());

        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "windows")]
    #[tokio::test]
    async fn cmd_builtin_unicode_round_trips() {
        let root =
            std::env::temp_dir().join(format!("lc-shell-unicode-{:016x}", rand::random::<u64>()));
        std::fs::create_dir_all(&root).unwrap();

        let result = tool_run_shell(windows_cmd_req(
            &root,
            "echo héllo wörld 日本語".to_string(),
            "test-unicode",
        ))
        .await
        .expect("cmd echo must launch");
        assert_eq!(result["exit_code"], 0);
        assert!(result["stdout"]
            .as_str()
            .unwrap_or_default()
            .contains("héllo wörld 日本語"));

        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "windows")]
    #[tokio::test]
    async fn quoted_findstr_patterns_with_spaces_stay_intact() {
        let root =
            std::env::temp_dir().join(format!("lc-shell-findstr-{:016x}", rand::random::<u64>()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            root.join("patterns.txt"),
            b"Secret Master\r\nSecret Grandmaster\r\nNo match\r\n",
        )
        .unwrap();

        let result = tool_run_shell(windows_cmd_req(
            &root,
            "findstr /n /c:\"Secret Master\" /c:\"Secret Grandmaster\" patterns.txt".to_string(),
            "test-findstr-quotes",
        ))
        .await
        .expect("findstr command must launch");
        assert_eq!(result["exit_code"], 0);
        let stdout = result["stdout"].as_str().unwrap_or_default();
        assert!(stdout.contains("1:Secret Master"), "stdout: {stdout:?}");
        assert!(
            stdout.contains("2:Secret Grandmaster"),
            "stdout: {stdout:?}"
        );

        std::fs::remove_dir_all(root).unwrap();
    }

    /* ---------------- read_capped ----------------------------- */

    #[tokio::test]
    async fn read_capped_truncates_long_input() {
        // 100 bytes input, cap 50 → truncated=true, body 50 bytes.
        let input: Vec<u8> = (0..100u8).collect();
        let (body, truncated) = read_capped(&input[..], 50).await;
        assert_eq!(body.len(), 50);
        assert!(truncated);
        assert_eq!(body.as_bytes()[0], 0);
        assert_eq!(body.as_bytes()[49], 49);
    }

    #[tokio::test]
    async fn read_capped_under_cap_not_truncated() {
        let input: Vec<u8> = (0..50u8).collect();
        let (body, truncated) = read_capped(&input[..], 100).await;
        assert_eq!(body.len(), 50);
        assert!(!truncated);
    }

    /* ---------------- Actual run (echo) ----------------------- */

    #[tokio::test]
    async fn runs_echo_and_captures_stdout() {
        // `echo` on Unix is a real binary in /usr/bin/echo (or builtin
        // for some shells). On Windows there's no standalone echo.exe
        // in the default PATH — `echo` is a cmd.exe builtin, so this
        // test is Unix-only.
        #[cfg(unix)]
        {
            let mut req = shell_req("echo", "test-echo");
            req.args = Some(vec!["hello".to_string()]);
            req.timeout_ms = Some(5000);
            let r = tool_run_shell(req).await.expect("expected Ok");
            assert_eq!(r["exit_code"], 0);
            assert!(r["stdout"].as_str().unwrap().contains("hello"));
            assert_eq!(r["timed_out"], false);
        }
    }

    #[tokio::test]
    async fn times_out_on_slow_command() {
        // `sleep` may not exist on Windows — guard with cfg.
        #[cfg(unix)]
        {
            let mut req = shell_req("sleep", "test-timeout");
            req.args = Some(vec!["10".to_string()]);
            req.timeout_ms = Some(500);
            req.allowlist = Some("sleep".to_string());
            let r = tool_run_shell(req).await.expect("expected timeout result");
            assert_eq!(r["timed_out"], true);
        }
        #[cfg(not(unix))]
        {
            // No portable "sleep" on Windows. Skip.
        }
    }

    #[tokio::test]
    async fn abort_group_stops_an_active_shell_process() {
        let root = std::env::temp_dir().join(format!(
            "lc-shell-abort-group-{:016x}",
            rand::random::<u64>()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let call_id = format!("test-shell-abort-{:016x}", rand::random::<u64>());
        let group_id = format!("test-shell-group-{:016x}", rand::random::<u64>());

        #[cfg(target_os = "windows")]
        let (command, arguments, allowlist) = (
            "powershell",
            vec![
                "-NoProfile".to_string(),
                "-NonInteractive".to_string(),
                "-Command".to_string(),
                "Start-Sleep -Seconds 30".to_string(),
            ],
            "powershell",
        );
        #[cfg(unix)]
        let (command, arguments, allowlist) = ("sleep", vec!["30".to_string()], "sleep");

        let mut req = shell_req(command, &call_id);
        req.args = Some(arguments);
        req.cwd = Some(root.to_string_lossy().into_owned());
        req.allowed_roots = Some(vec![root.to_string_lossy().into_owned()]);
        req.timeout_ms = Some(60_000);
        req.allowlist = Some(allowlist.to_string());
        req.group_id = Some(group_id.clone());

        let task = tokio::spawn(tool_run_shell(req));
        let mut cancelled = 0;
        for _ in 0..200 {
            cancelled = super::super::registry::abort_group(group_id.clone())
                .await
                .unwrap();
            if cancelled > 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert_eq!(cancelled, 1, "shell call never entered the abort registry");

        let outcome = tokio::time::timeout(Duration::from_secs(5), task)
            .await
            .expect("cancelled shell should settle promptly")
            .expect("shell task should not panic");
        assert!(
            matches!(outcome, Err(ToolError::Aborted)),
            "got {outcome:?}"
        );

        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn timeout_kills_every_member_of_the_child_process_group() {
        fn process_exists(pid: i32) -> bool {
            // SAFETY: signal 0 performs existence/permission checking only.
            let result = unsafe { libc::kill(pid, 0) };
            result == 0 || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
        }

        let root = std::env::temp_dir().join(format!(
            "lc-shell-process-group-{:016x}",
            rand::random::<u64>()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let pid_file = root.join("descendants.pid");

        let mut req = shell_req("sh", "test-process-group-timeout");
        req.args = Some(vec![
            "-c".to_string(),
            concat!(
                "sleep 30 & first=$!; ",
                "sleep 30 & second=$!; ",
                "printf '%s\\n%s\\n' \"$first\" \"$second\" > \"$1\"; ",
                "wait"
            )
            .to_string(),
            "sh".to_string(),
            pid_file.to_string_lossy().into_owned(),
        ]);
        req.cwd = Some(root.to_string_lossy().into_owned());
        req.allowed_roots = Some(vec![root.to_string_lossy().into_owned()]);
        req.timeout_ms = Some(1_000);
        req.allowlist = Some("sh".to_string());

        let result = tool_run_shell(req).await.expect("expected timeout result");
        assert_eq!(result["timed_out"], true);

        let pids: Vec<i32> = std::fs::read_to_string(&pid_file)
            .expect("shell should record both descendant PIDs before timeout")
            .lines()
            .map(|line| line.parse().expect("recorded PID should be numeric"))
            .collect();
        assert_eq!(pids.len(), 2);

        // Reparented processes may remain visible briefly while the OS reaps
        // them, so poll before declaring that a group member leaked.
        for _ in 0..40 {
            if pids.iter().all(|pid| !process_exists(*pid)) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let survivors: Vec<i32> = pids
            .iter()
            .copied()
            .filter(|pid| process_exists(*pid))
            .collect();
        for pid in &survivors {
            // Best-effort cleanup keeps a failing test from leaking sleepers.
            unsafe { libc::kill(*pid, libc::SIGKILL) };
        }
        let _ = std::fs::remove_dir_all(&root);
        assert!(survivors.is_empty(), "descendants survived: {survivors:?}");
    }

    #[tokio::test]
    async fn blocked_cmd_returns_error_without_spawning() {
        let mut req = shell_req("rm", "test-blocked");
        req.args = Some(vec!["-rf".to_string(), "/".to_string()]);
        req.timeout_ms = Some(1000);
        let r = tool_run_shell(req).await.expect_err("expected Err");
        assert!(matches!(r, ToolError::BlockedCmd(_)), "got {:?}", r);
    }

    /* ---------------- SAFETY: end-to-end allowlist coverage -- */

    #[test]
    fn allowlist_covers_all_documented_safe_binaries() {
        // Pins SAFE_ALLOWLIST against a deliberate literal duplicated in
        // this test body; docs/security.md documents the fallback by count
        // only, so a docs change alone cannot fail this test.
        let documented: HashSet<&str> = [
            "sh", "bash", "zsh", "dash", "node", "python3", "git", "ls", "cat", "head", "tail",
            "grep", "rg", "find", "wc", "echo", "printf", "pwd", "date", "true", "false", "test",
            "[",
        ]
        .iter()
        .copied()
        .collect();
        let actual: HashSet<&str> = SAFE_ALLOWLIST.iter().copied().collect();
        assert_eq!(
            actual, documented,
            "SAFE_ALLOWLIST drift from the pinned literal in this test"
        );
    }
}
