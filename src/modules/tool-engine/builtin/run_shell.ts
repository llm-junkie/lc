/**
 * run_shell — execute a shell command.
 *
 * The dangerous one. The Rust side enforces:
 *   - A binary allowlist — the JS side sends the effective user setting on
 *     every call and Rust checks the executable basename. The system prompt
 *     derives Windows executable-vs-cmd.exe-builtin guidance from that same
 *     effective list. Rust's SAFE_ALLOWLIST is only a missing-input fallback.
 *   - Secret master virtual binary: if "*****" is in the allowlist,
 *     any binary is permitted (the allowlist check is bypassed on
 *     the Rust side). The permission popup still fires on every
 *     invocation.
 *   - Secret grandmaster virtual binary: "*******" (7 stars) implies
 *     the master behavior (any binary) AND auto-approves — the
 *     permission popup is suppressed on the JS orchestrator side.
 *     All other sandboxing (env scrubbing, I/O caps, timeout,
 *     CWD sandboxing) still applies.
 *   - Backward-compatible quote-aware full-command parsing (split_cmd) — preserves quoted
 *     arguments like python -c "print('hello world')" intact.
 *   - argv passed as Vec<String> to tokio::process::Command (no
 *     shell intermediary on the Rust side; the binary is invoked
 *     directly via execve/CreateProcess)
 *   - env scrubbing: copies only PATH, HOME, USERPROFILE, LANG,
 *     LC_ALL, TZ, SystemRoot, windir, COMSPEC from the parent;
 *     clears dangerous loader/runtime variables and prevents env
 *     overrides from restoring them; drops secret-shaped overrides
 *   - CWD: if the model supplies a cwd, it's sandboxed under
 *     allowed_roots; otherwise defaults to the first allowed root;
 *     if no roots are configured, falls back to the system temp
 *     directory so commands like echo/date/whoami work out of the
 *     box
 *   - timeout (default 30s, hard cap 120s)
 *   - stdin, stdout, and stderr each capped at 1 MiB of bytes
 *   - UTF-16LE/BE output auto-detected and decoded to UTF-8
 *     (PowerShell and Windows console programs emit UTF-16LE to
 *     pipes; decode_output() transparently converts via BOM
 *     detection + NUL-density heuristic)
 *   - CREATE_NO_WINDOW on Windows — prevents console flash in
 *     production builds
 *   - CancellationToken registered in TOOL_REGISTRY; Child stays local
 *
 * Execution is approval-controlled. A concealed configuration exception can
 * suppress the popup; model-facing copy intentionally does not advertise it.
 */
import { z } from 'zod';
import type { ToolHandler } from '../types';
import type { JsonSchema } from '../../llm-client/types';
import { remainingMs } from '../runner.ts';
import type { RunShellResult } from '../sandbox-bridge';

export const RUN_SHELL_STDIN_CAP_BYTES = 1_048_576;
export const RUN_SHELL_TIMEOUT_CAP_MS = 120_000;

const schema = z.object({
  cmd: z.string(),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  timeout_ms: z.number().int().positive().max(
    RUN_SHELL_TIMEOUT_CAP_MS,
    `timeout_ms must be at most ${RUN_SHELL_TIMEOUT_CAP_MS}. Use 120000 milliseconds or less.`,
  ).optional(),
  env: z.record(z.string(), z.string()).optional(),
  stdin: z.string()
    .max(RUN_SHELL_STDIN_CAP_BYTES)
    .refine(
      (value) => new TextEncoder().encode(value).byteLength <= RUN_SHELL_STDIN_CAP_BYTES,
      { message: 'stdin must be at most 1 MiB when encoded as UTF-8' },
    )
    .optional(),
});

export type RunShellInput = z.infer<typeof schema>;

const CACHED_SCHEMA = Object.freeze(schema.toJSONSchema()) as unknown as JsonSchema;

export const runShell: ToolHandler<RunShellInput, RunShellResult> = {
  name: 'lc_run_shell',
  description:
    'Execute an approval-controlled shell command.\n' +
    'The executable name must satisfy the allowlist in the system prompt.\n' +
    'Put one executable name in cmd.\n' +
    'Put its argument array in args.\n' +
    'For compatibility, cmd can still contain a previously accepted full command string.\n' +
    'stdin is optional and accepts at most 1 MiB of UTF-8 data.\n' +
    'LC preserves empty and whitespace-only stdin exactly.\n' +
    'LC enforces this stdin limit natively.\n' +
    'If cwd is explicit, it must already exist as a directory inside an allowed root.\n' +
    'If cwd is omitted, LC uses the first allowed root.\n' +
    'If no roots exist, LC uses the system temporary directory.\n' +
    'LC copies a small safe set of parent variables.\n' +
    'LC clears dangerous loader and runtime variables.\n' +
    'LC drops overrides that restore those variables or use secret-shaped names.\n' +
    'stdout and stderr each have a 1 MiB cap.\n' +
    'The result reports separate truncation flags for both streams.\n' +
    'The timeout defaults to 30 seconds and has a 120-second hard limit.\n' +
    'On timeout, timed_out is true and exit_code is null.\n' +
    'On Windows, use cmd and args for cmd.exe builtins.\n' +
    'Before approval, LC normalizes explicit cmd /c calls.\n' +
    'This normalization disables AutoRun, requests Unicode builtin output, and preserves the /c command tail.',
  uiDescription: '⚠︎ Run an approval-controlled shell command.',
  input: schema,
  toJsonSchema: () => CACHED_SCHEMA,
  run: async (input, ctx) => {
    // The Rust side handles the binary allowlist, env scrubbing,
    // argv validation, timeout, and the kill-signal flow (see
    // src-tauri/src/tools/shell.rs + registry.rs for the
    // abort_tool_calls registry).
    //
    // Phase 2.1: Use ctx.identity for operation + group identity.
    //   - call_id = identity.operationId (Rust registry key)
    //   - group_id = identity.groupId (batch abort by group)
    //
    // Phase 2.2: Connect JS AbortSignal to native abort_tool_calls.
    //   When the chat is stopped, the signal fires → we call the
    //   Tauri command to kill the child process. The listener is
    //   removed in `finally` to prevent leaks.
    const callId = ctx.identity.operationId;
    const groupId = ctx.identity.groupId;

    const onAbort = () => {
      // Fire-and-forget: don't await — the native kill is best-effort.
      // The promise chain in the orchestrator handles the JS-side cleanup.
      ctx.sandbox.abortToolCalls({ callIds: [callId] }).catch(() => {});
    };
    ctx.signal.addEventListener('abort', onAbort);

    try {
      // Check signal before invoking — if already aborted, skip the call.
      if (ctx.signal.aborted) {
        throw { code: 'Aborted', message: 'Operation cancelled by user.' };
      }

      return ctx.sandbox.runShell({
        ...input,
        cwd: input.cwd?.trim() ? input.cwd : undefined,
        allowed_roots: ctx.config.allowedRoots,
        call_id: callId,
        group_id: groupId,
        allowlist: ctx.config.shellAllowlist.join(','),
        // Phase 2.5: Derive timeout from the per-call deadline.
        // This ensures compound tools share one budget.
        timeout_ms: input.timeout_ms
          ?? remainingMs(ctx.config.deadlineMs, ctx.config.maxShellTimeoutMs),
      });
    } finally {
      ctx.signal.removeEventListener('abort', onAbort);
    }
  },
};
