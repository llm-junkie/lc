# Security

All model-facing file tools use canonical scope admission. They also use Rust
`resolve_under_roots()` and the structured `ToolError` boundary. The shell is a
separate capability. It requires a user decision for each call, except under
the hidden grandmaster `*******` entry. It applies the binary allowlist and
environment controls. By design, it can access paths outside File I/O roots.

`lc_whiteboard` is a local conversation-state tool, not a filesystem, network,
or shell capability. It has no path or owner parameter, creates no grant, and
runs without a permission prompt only while Workspace and the Whiteboard
category are enabled. The model can change only the model board. The user UI
can change only the user board, except for the explicitly gated package-import
restoration action described below. Whiteboard does not weaken any existing
sandbox, authorization, or destructive-operation check.

---

## Path Sandbox: `resolve_under_roots()`

Location: `src-tauri/src/tools/fs_ops.rs`

Every file I/O tool calls this function before any operation:

```
resolve_under_roots(raw_path, allowed_roots)
  ├─ clean_path(raw)                   // Strip whitespace around \ and /
  ├─ Walk up from raw_path             // Find deepest existing ancestor
  │   └─ canonicalize(ancestor)        // Resolve symlinks, .., .
  ├─ path_starts_with_ci(canon, root)  // Component-wise containment check
  │   ├─ Windows: lowercase both, then Path::starts_with
  │   └─ Unix: case-sensitive, Path::starts_with
  ├─ If outside → PathOutsideRoots(raw, "[roots]")
  └─ If inside → canon + tail components
```

### Key Properties

- **Canonicalization** — Resolve symlinks, `..`, and `.` before the containment
  check.
- **UNC removal** — Remove Windows `\\?\` prefixes.
- **Component comparison** — Treat `projects-secret` as one component, not a
  child of `projects`. This prevents prefix collisions.
- **Non-existing paths** — Find the deepest existing ancestor, check
  containment, and append the remaining path.
- **No implicit roots** — Require an explicit user grant for each directory.
  If no roots exist, `run_shell` uses `std::env::temp_dir()` as its CWD. Thus,
  commands such as `echo`, `date`, and `whoami` work without a directory grant.
- **Missing-root fallback** — A missing root uses a non-canonical prefix check in
  `resolve_under_roots`. Symlink resolution is unavailable in this case.
  `tool_check_path` rejects a missing root when Workspace adds it. Therefore,
  this case occurs only after deletion of a granted root.
- **Whitespace tolerance** — `clean_path()` removes whitespace around `\` and
  `/`.
- **Defense in depth** — JS (`sanitizePathSepWhitespace`) and Rust both clean
  paths.

---

## Binary Allowlist

`run_shell` enforces a binary allowlist. The canonical request puts one binary
in `cmd` and its arguments in `args`. The native compatibility splitter still
accepts earlier full-command strings. LC checks the executable basename, not a
hidden built-in alias. On Windows, the visible cmd adapter runs before the
permission popup and persistence. It normalizes a `cmd /c` request while `cmd`
remains the allowlisted executable.

### Platform Defaults

| Platform | Default allowlist |
|---|---|
| Windows | `cmd, powershell, dir, type, findstr, where, tasklist, echo, cd, python3, python, git, node` |
| Linux | `sh, bash, dash, cat, echo, printf, head, tail, grep, wc, find, test, true, false, pwd, date, python3, git, node, ls, cp, mv, rm, mkdir` |
| macOS | `sh, bash, zsh, cat, echo, printf, head, tail, grep, wc, find, test, true, false, pwd, date, python3, git, node, ls, cp, mv, rm, mkdir` |

These platform defaults live in `src/store/settings.ts`. The JS handler sends
the effective per-conversation list with every normal shell request. Rust's
23-entry `SAFE_ALLOWLIST` is a defense-in-depth fallback used only when that
input is absent. It is not the source of the platform defaults.

### Error Messages

| Scenario | Message |
|---|---|
| Binary not in allowlist | `"Command \"X\" is not in the shell binary allowlist. Allowed: cmd, powershell, ..."` |
| cmd.exe builtin used standalone | `windows_builtin_requires_cmd` with a machine-readable `suggested_call`. LC does not run it implicitly. `cmd` must pass the allowlist on the new call. |
| Executable missing | `executable_not_found` with executable plus native reason/code |
| Permission denied | `permission_denied` with operation plus native reason/code |
| Other launch failure | `spawn_failed` with executable plus native reason/code |
| Timeout | `{"code": "Timeout"}` |

### Quote-Aware Parsing

`split_cmd()` in `shell.rs` is a compatibility parser for earlier full-command
strings. It preserves the code string in `python -c "print('hello world')"`.
It is not a terminal emulator. Direct executable and argument calls do not use
a general shell.

On Windows, the cmd adapter treats all content after `/c` as one command tail.
It adds `/d` to disable registry AutoRun. It adds `/u` so cmd.exe built-in
output uses UTF-16. Rust uses Windows `raw_arg` only for that command tail.
Thus, C-runtime escaping does not change embedded quotes such as
`findstr /c:"Secret Master"`.

The user approves the normalized
`cmd /d /u /c` request. The conversation stores that exact request.

### CWD Resolution

The working directory for `run_shell` is resolved with a fallback chain:

1. If the model supplies `cwd`, resolve it under `allowed_roots` with
   `resolve_under_roots()`.
2. Verify that the supplied `cwd` exists and is a directory.
3. If the model omits `cwd`, use the first allowed root.
4. If no roots exist, use `std::env::temp_dir()`.

Approving a shell call does not add a directory or persist a shell grant.

The explicit-cwd errors are distinct: `cwd_not_found`, `cwd_not_directory`, and `cwd_outside_roots`. Because cwd validation completes before process lookup, a bad cwd cannot be misreported as a missing executable.

---

## Environment Scrubbing

The Rust spawner calls `env_clear()` and rebuilds the child environment:

- **Parent allowlist:** Only `PATH`, `HOME`, `USERPROFILE`, `LANG`, `LC_ALL`,
  `TZ`, `SystemRoot`, `windir`, and `COMSPEC` can be copied from the parent.
  Other parent variables are absent, so secret-name matching is unnecessary.
- **Always cleared:** `LD_PRELOAD`, `LD_LIBRARY_PATH`, `DYLD_INSERT_LIBRARIES`, `NODE_OPTIONS`, `PYTHONSTARTUP`, `BASH_ENV`, `ENV`, `PS4`, and `PROMPT_COMMAND` are inserted with empty values.
- **Caller overrides:** Non-secret overrides can replace safe values such as
  `LANG`. Overrides cannot restore the nine cleared names. Windows compares
  those names without case sensitivity. LC ignores names that contain
  `SECRET`, `TOKEN`, `API_KEY`, `KEY`, `PASSWORD`, `PASS`, or `PRIVATE`.

PowerShell needs `SystemRoot` and `windir` to find its .NET runtime DLLs.
`decode_output()` converts UTF-16LE output from Windows console programs to
UTF-8. It also converts cmd.exe built-in output requested through `/u`.

### UTF-16 Detection Heuristic

`decode_output()` in `shell.rs` uses a three-tier detection strategy:

1. **UTF-16LE BOM** (`0xFF 0xFE`) → decode as UTF-16LE
2. **UTF-16BE BOM** (`0xFE 0xFF`) → decode as UTF-16BE
3. **NUL-density heuristic:** If more than 25% of the first 256 bytes are NUL,
   treat the output as UTF-16LE ASCII. Windows console programs commonly emit
   this format to pipes. Without this check, `String::from_utf8_lossy` preserves
   NUL bytes between ASCII characters. This produces output such as
   `"I\u0000n\u0000t\u0000e\u0000r\u0000n\u0000a\u0000l\u0000..."`.

Fallback: standard lossy UTF-8 decode.

A process that launches returns `{ stdout, stderr, exit_code, ... }`. This also
applies to nonzero exits and output that contains phrases such as “cannot find”
or “spawn”. The orchestrator does not classify process output as a launch
failure. LC does not retry shell calls automatically. Structured launch, CWD,
and built-in issues mark an identical retry as non-retryable.

---

## Output Caps

| Cap | Tool | Limit |
|---|---|---|
| stdout/stderr | `run_shell` | 1 MiB each |
| stdin | `run_shell` | 1 MiB of UTF-8 bytes (validated in JS and enforced in Rust) |
| file read | `read_file` | 1 MiB default for complete reads. Focused ranges stream from larger files and limit returned content. |
| file write | `write_file` | 32 MiB per content/final file and 64 MiB of requested content per call |
| image read | `read_image` | 10 MiB default and 50 MiB hard limit. Analyze mode uses 5 MiB for each encoded image. |
| vision response | `read_image` analyze mode | 1 MiB successful body, 16 KiB non-success detail, and 64 KiB UTF-8 per usable description |
| pdf read | `read_pdf` | 25 MiB (default), 100 MiB (hard) per file |
| model summary | `read_pdf`, `web_research` | 64 KiB of UTF-8 visible text; blank or larger output is rejected without partial content |
| tool issue message | all built-in tools | 16 KiB of UTF-8 for validation detail or an arbitrary propagated message |
| skill result | `lc_skill` | 100 enabled list items and 2 MiB of serialized UTF-8 output |
| web fetch body | `web_fetch` | 1 MiB (default), 32 MiB (hard) |
| patch text | `apply_patch` | 1 MiB |
| patch target file | `apply_patch` | 32 MiB per existing source |
| prepared patch output | `apply_patch` | 64 MiB total per call |
| provider proxy body | renderer IPC | 64 MiB for a request body and for a non-stream response body |
| dropped attachment | renderer IPC | 25 MiB per regular file |
| user-selected export write | renderer IPC | 1,000,000,000 bytes |
| encrypted key value/file | renderer IPC | 64 KiB plaintext and 128 KiB encrypted file |
| grep results | `grep` | 5000 matches (hard) |
| glob results | `glob_files` | 5000 matches (hard) |
| whiteboard document | `lc_whiteboard` and Whiteboard UI | 32 KiB of UTF-8 per owner document |
| whiteboard package native read | `read_bounded_file` | 128 KiB hard ceiling |
| whiteboard package entry | Whiteboard import | 32 KiB of actual uncompressed bytes |
| whiteboard package output | Whiteboard import | 64 KiB of actual uncompressed bytes combined |

Search traversal has additional call-wide budgets:

| Budget | Default | Hard cap |
|---|---:|---:|
| grep visited entries | 50,000 | 200,000 |
| grep bytes read | 100 MB | 500 MB |
| glob visited entries | 50,000 | 200,000 |

`read_pdf` budgets apply to the complete call, not each file. A PDF batch cannot
multiply them. Summary-free reads retain text-page and result limits. The
complete serialized result is capped at 4 MiB; larger results become an error.
Rendered images and intermediate summaries stay native. At most two PDF
summary requests run concurrently per call, sharing its cancellation token
and deadline.

| Budget | Default | Hard cap |
|---|---:|---:|
| PDFs per call | — | 4 |
| pages with text extracted | 200 | 500 |
| pages rasterized | 20 | 50 |
| total encoded PNG bytes | — | 24 MiB |
| rasterized pixels per page | — | 40 megapixels |

The pixel limit is necessary because a PDF declares its own `MediaBox`. Without
the limit, one crafted page could request a multi-gigabyte pixmap. LC renders an
oversized page at reduced DPI. It skips the page if 72 DPI still exceeds the
limit.

`read_pdf` also fails closed on page selection. It rejects malformed, empty, or
overlong expressions. It also rejects selections that cover more than 2,000
pages. It does not silently select every page. LC checks cardinality before
enumeration. Thus, a range such as `1-1000000000` cannot expand in the webview.

---

## Whiteboard package and rendering boundary

Whiteboard package import is an explicit user action. The model-facing
`lc_whiteboard` schema has no filename or filesystem path field and cannot open,
save, or import a package. On desktop, the native open dialog supplies the
selected path to `read_bounded_file`. This UI command is separate from the
model-facing File I/O tools and does not create or consume a Workspace root or
directory grant.

`read_bounded_file` accepts only a non-empty path to a regular file. It rejects
a caller limit outside 1 through 128 KiB, checks metadata before allocating for
the file, and rejects an oversized file before opening it. It then reads through
`Read::take(max_bytes + 1)` and checks the actual byte count again, so a file
that grows after the metadata check cannot bypass the limit. The browser picker
applies the same 128 KiB compressed-input bound before ZIP parsing.

After selection, LC validates the package basename. It accepts only lowercase
`lc-whiteboard-YYYY-MM-DD-HHmm.zip` or that name with a decimal browser
collision suffix from ` (1)` through ` (9999)`. The date and time must be real
calendar values. A valid-looking name is not a trust signal.

The ZIP parser is entry-aware and runs in memory. It registers the deflate
decoder before input and observes every local entry. It rejects duplicate names.
It accepts exactly `model.md` and `user.md` at the archive root. That exact key-set
rule also rejects directories, nested paths, absolute paths, traversal names,
missing entries, and extra entries. LC never extracts an entry to the
filesystem.

It stops accepting compressed input after a failure. It limits each
entry to 32 KiB of actual output. It limits both entries to 64 KiB combined. It
uses fatal UTF-8 decoding.

A header size is only an early rejection hint. Actual
streamed output is authoritative. The current ZIP API exposes neither an
encryption flag nor portable symbolic-link metadata, so LC does not claim a
separate check for either property.

All validation finishes before import writes either board. Import is available
only when all these conditions are true:

- Both documents are empty.
- Both owners have only their initial empty versions.
- No pending user copy or provisional model copy exists.
- No model generation is active anywhere in LC.

A successful import creates fresh local
versions for both owners in one transaction. It imports no source IDs, history,
roots, grants, settings, tools, or files.

Board Markdown remains untrusted data. The overlay uses the shared Markdown
renderer and guarded-link behavior. The shared renderer retains a passive
raw-HTML formatting allowlist and removes every raw attribute. It renders
browser-active raw tags as literal text. A Markdown image can render directly
only from inline PNG, JPEG, GIF, or WebP bytes, or from an existing `blob:`
URL. Every other image source becomes a guarded link, so rendering model or
Whiteboard Markdown cannot start a network request. Whiteboard does not add an
unguarded-navigation path. Export captures immutable copies of the two values
visible at the click and writes only `model.md` and `user.md`. It does not add
hidden heads, retained history, identifiers, grants, or settings.

---

## SSRF Blocklist

`lc_web_fetch` blocks the non-global connection targets represented by the
current IANA special-purpose registries, including:

- Loopback: `127.0.0.0/8`, `::1`
- Private: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`
- Link-local: `169.254.0.0/16`
- ULA: `fc00::/7`, `fd00::/8`
- Unspecified, multicast, reserved/documentation, benchmarking, and other special-use ranges
- IPv4-mapped IPv6 addresses whose embedded IPv4 address is non-global
- Local-use translation (`64:ff9b:1::/48`), discard-only (`100::/64`), Dummy IPv6 Prefix (`100:0:0:1::/64`), and SRv6 SID (`5f00::/16`) space
- Non-global IPv4 embedded in the globally reachable well-known NAT64 prefix
  (`64:ff9b::/96`). Public embedded IPv4 remains allowed.
- `file://` protocol

LC evaluates the IPv4 `192.0.0.0/24` protocol-assignment block narrowly. It
allows the globally reachable PCP/TURN anycast addresses `192.0.0.9` and
`192.0.0.10`. It also allows ordinary public space elsewhere in
`192.0.0.0/16`.
Within IPv6 `2001::/23`, the parent protocol-assignment block is denied unless
the address belongs to a more-specific IANA allocation. The allocation must be
marked globally reachable. These allocations include PCP/TURN/DNS-SD anycast,
AMT, AS112-v6, ORCHIDv2, and Drone Remote ID DETs.

### Why this is bit arithmetic and not a CIDR table

Replacing the predicate with a checked-in CIDR denylist has been proposed and
**declined**. It is recorded here because it is an obvious-looking cleanup that
would silently lose behavior.

The policy cannot use a flat unordered denylist. Two rules are recursive, not
range-based. An IPv4-mapped IPv6 address returns to the IPv4 check through
`to_ipv4_mapped()`. The well-known NAT64 prefix also extracts an embedded IPv4
and uses that function. `2001::/23` needs longest-prefix priority.

The parent
range is denied except for more-specific allocations that IANA marks globally
reachable. An ordered prefix policy and embedded-address handlers could express
these rules. However, that design adds matching and priority logic. It would
require a table and special cases, which adds more surface than the predicate.

The proposed change would rewrite security-critical code verified against both
IANA registries in each direction. It would reduce existing assurance to gain
maintainability.

Registry-derived boundary tests better address an unnoticed IANA update. They
add no rewrite risk and are required before any future refactor. Each
branch carries a comment naming its registry row and RFC.

### Hostname Resolution

The blocklist resolves hostnames to IP addresses before checking them. A request
to `http://localhost/` resolves to `127.0.0.1`, `::1`, or both. The IP range
check blocks those addresses. LC does not match hostname strings. Therefore,
it also blocks a public-looking hostname that resolves to a private address.

### Redirect-Chain Protection

`web_fetch` disables reqwest automatic redirects with `Policy::none()` and
follows redirects in a bounded manual loop. Every hop is parsed, DNS-resolved,
checked against the SSRF predicate, and pinned to one of the validated
addresses before the request is sent. A chain like `http://safe.com` → 302 →
`http://127.0.0.1/admin` is blocked at the redirect target. DNS failure is also
fail-closed.

### Scope: `lc_web_search` is not covered, by design

The blocklist above applies to `lc_web_fetch`. `tool_web_search` has never had
one. It historically reached one hardcoded host. The SearXNG
provider deliberately keeps it that way, because a self-hosted instance is
normally on `localhost` or the LAN and would be blocked outright.

This does not extend the model's reach for these reasons:

- The base URL is typed by the user into **Settings → Workspace**. The model
  cannot supply, influence, or redirect it. `base_url` is absent from the
  tool's input schema. The TypeScript handler resolves it from settings and
  passes it in the request. Rust never reads settings for it.
- Only `http` and `https` are accepted. TypeScript export, import, search, and
  support-report boundaries enforce the scheme. Rust validates it again as
  defense in depth.
- The carve-out covers the configured search endpoint only. URLs *returned* by
  a search remain ordinary untrusted web content and are subject to the full
  blocklist when the model later calls `lc_web_fetch` on them.

When users configure a SearXNG base URL, they point LC at a host that they chose.
They make the same trust decision when they add a server profile. See
[`search-providers.md` § Security](./search-providers.md#6-security).

---

## Permission Grants

### Visible Grant State

File I/O authorization uses visible tool checkmarks for each directory in
`dir_permissions`. Web Access uses visible conversation
`tool_grants`. The shell has no persistent grant and always prompts. The hidden
grandmaster `*******` allowlist entry is the only exception and approves
automatically. Authorization does not use an opaque exact-call hash.

File grants cover their canonical root and descendants for the same tool.
Coverage is additive across overlapping roots and is directional. A child grant
does not authorize its parent or siblings. A child root that lacks a tool does
not override an enclosing root that grants the tool. LC has no implicit
child-level deny state.

### Patch Preflight Binding

`apply_patch` uses a fail-closed native preflight before permission checks. The
orchestrator reserves the global patch queue before preflight. It keeps the
reservation through execution. Therefore, concurrent patches cannot inspect
filesystem state that an earlier patch is about to change. Rust strictly parses
the patch and resolves each source and destination under allowed roots.

It
returns canonical affected paths and a plan ID. The orchestrator authorizes and
locks those paths. Execution requires the plan ID and rebuilds the resolved
plan. LC rejects a patch or path identity mismatch before mutation.

Add and move destinations use no-clobber creation. LC stages updates on the
target filesystem, flushes them, and commits each file atomically. Windows uses
`ReplaceFileW` for an existing target. LC does not promise cross-file atomicity.
It reports commit failures for each file with `fully_applied: false`.

### Permission Popup Flow

LC rejects unknown, invalid, and unexposed calls before a popup. For exposed
calls, LC determines targets and scopes before execution:

| Trigger | Effect of “Allow for this conversation” |
|---|---|
| File tool lacks a directory+tool grant | Persist only the displayed canonical target scopes and exact tool in `allowed_roots` / `dir_permissions` |
| Web Access tool is unchecked | Add only that tool to `tool_grants` |
| Shell call | Authorize only this invocation. Persist nothing. |

“Allow once” changes no persisted state and authorizes only the one logical model
tool call displayed in that popup. Queued same-scope calls still need their own
decision. A multi-directory file call runs only after approval covers each
displayed scope. The popup cannot select individual scopes. Therefore, denied,
empty, or partial approval starts no filesystem work.

Within one tool batch, same-key non-shell requests queue in arrival order.
They can share a persistent approval or a fail-closed decision. An “Allow once” result causes the next
same-key request to open a fresh popup.

Permission and ask-user prompts from every conversation share one strict FIFO
coordinator. A request carries conversation/generation/assistant/tool-call
identity and names the requesting conversation in the modal. LC validates that
identity when queued, when promoted, and after the user answers. Cancellation
removes a queued request.

The permission modal also shows the exact model ID captured for that generation
and the canonical tool name. File calls show their canonical directory scopes;
tools that operate unambiguously on files additionally show the deduplicated
direct file targets below those scopes. Raw formatted arguments remain
available through `Show arguments`, which starts collapsed. These labels are
decision context only and do not broaden the scopes being approved.

An answer to a cancelled or replaced generation is
discarded. Prompt payloads are not exposed through the Sidebar queue projection.
A 30-minute absolute attention cap fails closed. Time spent queued behind a
different prompt is excluded from that tool call's ordinary deadline.

### `run_shell` Special Handling

- **Always prompts** — Prompts regardless of Workspace state. The hidden
  grandmaster `*******` allowlist entry is the only exception.
- **Warning highlight** — Shows command text in orange in the popup.
- **No prompt deduplication** — Requires a separate decision for each
  simultaneous shell call.
- **Full arguments visible** — Summarizes the command in the popup headline.
  The open argument details show complete JSON, including `env`.

---

## Concurrent Write Serialization

All active conversations share one application mutation coordinator. Tool calls
inside each round still use the **Max tool calls per batch** pool (1–64).
Independent exact-target writes may proceed in parallel. They no longer own
separate JavaScript lock domains.

Known-target reads take shared locks and known-target writes take exclusive
locks for the same canonical identity. Directory listing, glob, and grep take a
broad-read reservation that waits behind active writes and prevents new writes
from overtaking it. Shell commands are serialized application-wide and also
participate as undeclared mutations because their complete write set cannot be
derived safely. The queue is fair FIFO, and multi-target acquisition sorts
keys to avoid deadlock.

Writes to the same
file queue behind each other. Targets are sorted before acquisition so
overlapping multi-file calls cannot deadlock.

The lock key is a **canonical** identity, not the model-supplied string.
`lockKey` normalizes only separators and case. It cannot detect that
`a/./b.ts`, `a/b.ts`, and a symlink refer to one file. Therefore, raw targets
first pass through `canonicalizeLockTargets`, which uses the native
`tool_resolve_path` resolution that the sandbox uses. Native resolution walks
up to the deepest existing ancestor and appends the tail.

Thus, a file that
does not exist yet still gets a stable identity before `lc_write_file` creates
it. A path that fails to resolve keeps its raw form and is still locked under
that weaker identity rather than skipped.

`lc_apply_patch` uses this sequence:

1. Reserve the application mutation domain.
2. Discover the targets.
3. Ask for approval.
4. Repeat a fresh preflight.
5. Acquire every canonical target.
6. Execute without releasing the composite reservation.

See Patch Preflight Binding above.

Every JavaScript lock wait accepts the owning generation's `AbortSignal`.
Cancellation removes a queued waiter before any native operation starts. This
ordering matters because the short native read/write locks and apply-patch
critical section cannot all be interrupted after entry.

The TypeScript lock is cooperative and in-process. At the native mutation
boundary, `lc_write_file`, `lc_edit_file`, and `lc_apply_patch` also acquire
cross-process locks for each target. Windows uses named mutexes. Unix uses
advisory `flock` locks. Canonical identities are hashed into lock names.

Multi-target
patch locks are sorted to avoid deadlocks, and process termination releases the
locks automatically. Separate LC executables therefore serialize mutations to
the same target.

Arbitrary external editors do not participate in LC's locks. `lc_write_file`
can accept `expected_sha256` from a prior `lc_read_file`. This detects
content changed before LC acquires the mutation lock and validates content
rather than path spelling. It is not an atomic compare-and-swap against an
uncooperative external process that writes during LC's native critical section.

---

## Cancellation & Abort

In-flight native operations and model proxy streams are registered in
`TOOL_REGISTRY` (process-global
`Mutex<HashMap<String, ToolRegistryEntry>>`) when the operation can run long
or block. These operations are `run_shell`, `web_fetch`, `web_search`, `grep`,
`glob_files`, `read_file`, `read_pdf`, `apply_patch`, `analyze_images`, and
model-stream relays. Each entry wraps a
`CancellationToken` handle plus an optional execution `group_id`. The owning
future retains the child process, response, or traversal state. Short
write/list operations deliberately do not register (documented in
`registry.rs`). `read_file` checks cancellation between paths and between
fixed-size read chunks. `apply_patch` checks before plan resolution, after
lock acquisition, after preparation, and before each file commit. A cancel
between commits keeps the already reported prefix and marks every remaining
file as not changed; one file transaction is still an atomic checkpoint.

- Chat and tool `AbortSignal` calls `abort_group(group_id)`. This cancels each
  child of that model tool call.
- Focused cleanup can use `abort_tool_calls(operation_ids)` for individual
  native operations and stream relays.
- Model streams use `lc-stream-<id>` registry identities. JS reader teardown
  removes the Tauri listener and cancels the same native relay.
- Stream guards remain registered until their task completes, errors, or
  aborts.
- `run_shell` kills children before joining stdout and stderr readers. This
  prevents a pipe deadlock.
- `read_pdf` checks its token between files and page extractions. It also checks
  before each render. An individual parser or render call is cooperative, not
  preemptible. Stop takes effect at the next checkpoint. The tool round's
  absolute deadline limits each map and reduce sub-agent request. Each request
  runs once with a requested 4,000-token provider ceiling and no reasoning or
  sampling overrides. LC separately rejects blank visible output or output
  above 64 KiB of UTF-8; it returns no partial over-limit summary.

  Native extraction receives the remaining time, limited to five
  minutes. A longer round can return partial native results before its deadline.

While a generation owner exists, LC also freezes out-of-band configuration that
could change the request's security or routing context. Server-profile mutation,
Workspace/tool grants and exposure, model/parameter changes, import/reset, and
conversation archive export are unavailable and mutation-boundary guarded. The
permission modal for the currently executing tool call is the intentional
exception. It receives the generation's `AbortSignal` and persists a grant only
while that owner remains active, and is dismissed as aborted on Stop.

Whiteboard mutation uses a generation-owned serialized lifecycle queue. The
first changed model mutation creates one provisional working row for that turn.
later changed calls replace that row. Terminal settlement closes the working
row before retaining or removing it. A worker that reaches storage after close
returns `aborted` and cannot write. If a mutation committed before generation
ended but its ordinary result did not persist, LC uses only the durable mutation
receipt to repair the result. This rule retains an applied change
without replaying it and cannot grant a late worker authority.

This registry is in-process and intentionally makes no cross-process cleanup
claim. A newly started app cannot inspect the previous process's memory. While
LC is alive, shell timeout/cancellation uses `taskkill /F /T` on Windows and a
dedicated child process group on Unix. The Unix guarantee covers descendants
that remain in the inherited group. A child that deliberately calls `setsid()`
or moves groups can escape it. Durable cleanup after a hard application/OS
crash still requires process-wide OS containment such as a Windows Job Object
or a Linux cgroup/PID namespace.

---

## API Key Storage

The Tauri desktop application encrypts keys with AES-256-GCM and stores them as
files:

- **Windows:** `%APPDATA%/lc/keys/profile.<id>`
- **Linux/Unix:** `~/.config/lc/keys/profile.<id>` (or the platform's configured equivalent)
- **macOS:** `~/Library/Application Support/lc/keys/profile.<id>`

The encryption key is derived from machine and user identity. Therefore,
desktop keys are not portable. GCM authentication detects tampering. LC does
not store desktop keys in localStorage or settings exports. Browser and
development mode has no encrypted local key-store backend.

Its profile fallback is
ordinary browser storage, not an encrypted secret store. Settings export still
omits the API key. It also omits all user-defined profile request-header names
and values, disables additional request headers in the portable profile, and
applies the URL credential rule below. Profile validation and settings import
reject credential-bearing URLs. SearXNG resolution treats such a URL as
unconfigured. It also treats a nonempty invalid or non-HTTP(S) URL as
unconfigured.

Every profile network path uses the same credential precedence. It reads the
encrypted desktop entry first. If the entry is missing or the encrypted store
is unavailable, it uses the profile's plaintext fallback. This rule applies to
chat generation, model discovery, connection tests, model management, routing,
and helper-model checks.

The search-key session cache is not the only runtime holder of a resolved key.
Send-time capture also retains that value in `GenerationRuntimeSecrets` beside
the frozen execution snapshot. Request assembly uses the captured value. These
runtime holders are not persisted or included in portable exports.

Profile removal first passes the application mutation guard and removes the
profile authority. LC then attempts to delete its encrypted entry. Settings
import attempts to delete local profile entries that the imported profile set
does not retain. Reset settings and Reset all application data attempt to delete
all replaced profile entries. Key-store failures remain bounded storage
diagnostics; they do not restore an already removed profile.

Profile creation does not persist the plaintext credential before the encrypted
write outcome is known. Creation and credential rotation hold an
application-wide generation-blocking lease across the encrypted-store write and
profile commit. If a create write fails, the commit contains the explicit
plaintext fallback. If a rotation write fails, the commit disconnects the old
reference and makes the newly entered plaintext fallback authoritative. Thus, a
later successful read cannot silently select an older encrypted value.

### URL credential rule

LC treats a URL as credential-bearing when any condition is true:

- The parsed URL contains username or password user-info.
- A query parameter has a recognized credential name.
- A structured fragment parameter has a recognized credential name.

A structured fragment uses `#name=value&...` or
`#anchor?name=value&...`. A fragment without `=`, `&`, or a `?` parameter
section is an ordinary anchor. For example, `#token` is an ordinary anchor.
LC lowercases query and fragment parameter names and removes non-alphanumeric
separators before comparison.

The recognized normalized names are `accesskey`, `accesskeyid`, `accesstoken`,
`apikey`, `auth`, `authorization`, `authtoken`, `bearertoken`, `clientsecret`,
`credential`, `credentials`, `key`, `password`, `passwd`, `refreshtoken`,
`secret`, `sessiontoken`, `sig`, `signature`, `subscriptionkey`, `token`,
`xapikey`, `xauthtoken`, `xamzcredential`, `xamzsecuritytoken`,
`xamzsignature`, `xgoogcredential`, and `xgoogsignature`.

Nonempty text that LC cannot parse as a URL is invalid. It is not
credential-free. Settings import rejects an invalid SearXNG value. Search and
support-report resolution treat it as unconfigured. The portable writer emits
an empty SearXNG value instead of copying invalid text. An empty SearXNG value
remains the valid unconfigured state.

A SearXNG URL is valid only when its scheme is `http` or `https`. Other
parseable schemes, including `data`, `file`, and `ftp`, are invalid at the same
boundaries. The portable writer emits an empty value for them.

The portable writer removes recognized credentials. It retains ordinary query
parameters, fragment parameters, and anchors. Profile save validation and
settings import reject recognized credentials. A SearXNG value can remain in
local settings, but search and support-report resolution treat it as
unconfigured. This rule applies to profile base URLs, model-fetch URLs, and
SearXNG URLs. For model-fetch overrides, the writer applies the rule to
absolute URLs and to both supported relative forms, `path` and `/path`. It
keeps the relative form and ordinary URL components after removal.

Native key storage accepts only the fixed Brave and Marginalia names or
`profile.<id>`. A profile ID is 1 through 128 lowercase ASCII letters, digits,
periods, underscores, or hyphens, and it starts with a letter or digit. These
names map one-to-one to files. The native boundary rejects a plaintext value
above 64 KiB and an encrypted file above 128 KiB before decryption.
Settings import reuses a local profile reference only when the profile ID,
reference, base URL, and model-fetch URL are unchanged. A new or changed
destination is disconnected from the local credential.

---

## Redacted Support Reports

Support-report generation is an explicit local export action. The collector
does not call keychain APIs, model discovery, provider adapters, or any network
client. It reads IndexedDB counts through indexes, browser storage estimates,
and named fields from the current stores. It never loads conversation message
rows for the report.

The `llm-client:support-report` v1 object is constructed from an allowlist.
It is LC's complete initial schema. There is no released historical support-
report shape to preserve. Application state is not cloned and then filtered.

A final recursive pass removes token, key, cookie, and authorization patterns. It
also removes URLs, private paths, emails, and long encoded values. The pass
enforces depth, array, string, event, and 64 KiB serialized-size limits.

Configured endpoints are reduced to network
classes. Their hosts, credentials, paths, queries, and fragments are not
serialized.

Production diagnostics are a 64-entry structured ring, not raw logs. Event
fields use bounded subsystem/operation/outcome/code vocabularies plus validated
HTTP status and token counters. LC rejects unknown payload properties.

Version 1 uses only closed, typed context fields for these events. The fields
contain:

- canonical built-in tool names and permission results
- duration, count, and age buckets
- protocol, API-style, routing, and endpoint classes
- search provider names and allowed ignored-parameter names
- credential states and model metadata sources
- cache status, cache counters, and prefix conclusions

LC removes values that do not match a known enum. It does not carry them as
provider text. The report builder limits codes again during serialization.

A provider request is correlated with its own terminal stream result using an
ephemeral counter. The counter exists only inside the ring and wraps at a small
bound.
It is not a provider, request, message, conversation, or profile identifier. It
is also not a content hash. LC never serializes or writes it to disk. The
persisted ring omits it.

LC removes a counter from an earlier session during
load. Therefore, a request pairs only with a stream result from the same
session.

The most recent request's shape is captured at the provider boundary as closed
enums and bounded numbers. The facts include protocol, API style, routing, and
endpoint class. They include cache surface, reasoning state, and the stream-
timeout bucket. They also include the count of sent tool definitions, resolved
capabilities, and whether a context window was known. The request shape holds
no model identifier, profile or conversation id, endpoint, header, body,
message, or tool schema, and it is held in memory only.

Credential outcomes are recorded at the shared profile resolver and at search
startup. Chat generation uses the `chat` surface. Model discovery, connection
tests, model management, routing, and helper checks use the `profile` surface.
Settings actions that reveal a stored key are not instrumented. The recorded
facts are a closed surface name (`chat`, `profile`, `brave`, `searxng`, or
`marginalia`) and a closed outcome code. They never include a value, a key-store
reference name, or an account or project ID.

Prompt-prefix diagnostics retain only keyed digests produced with a fresh
random per-session HMAC key imported as non-extractable. Neither the key nor
any digest is persisted or exported. Only a bounded conclusion enum leaves the
module. LC never uses an unkeyed stable content hash, never mutates or reorders
the request it observes, and never injects a cache or routing directive.
Descriptions are sanitized before persistence and are omitted from reports by
default. Unknown exception text is treated as a possible provider body, prompt,
tool result, or private storage value and is not retained verbatim.

The preview, clipboard writer, and file writer share one frozen serialized
string. LC provides no support-report upload path, telemetry, crash submission,
or background reporting. See [Support reports](./support-report.md) for the
documented schema and sharing workflow.

Whiteboard content and version identifiers are outside the support-report
allowlist. Report collection does not load Whiteboard retained or working rows.
A production diagnostic can record the canonical tool name and a closed outcome.
It can also record bounded numeric metadata.

It cannot record either board, an
edit string, turn references, a version ID, or a package path. This exclusion
does not apply to an explicit conversation archive or Whiteboard package export.
Those local artifacts intentionally contain the board data that their export contracts
describe.

---

## Safe Start recovery boundary

Safe Start is selected before the normal `App` module is imported. Its module
graph excludes settings/profile/model and conversation stores, IndexedDB/Dexie,
provider adapters, model discovery, auto-archive, chat generation, tool
execution, workspace tools, and skills. It uses fixed built-in visuals and
shows only a known startup phase and bounded failure code. Raw exceptions are
never stored in the startup marker or shown by the recovery shell.

The marker stores only status, one of six known phases, and a counter capped at
two. It also stores Safe Start state, a known failure code, and one-shot retry
flags. It never
contains a path, exception object, settings value, conversation identifier, or
content hash. LC replaces malformed marker data with a fresh marker. If
marker/session storage is unavailable, automatic counting is disabled rather
than guessing that reloads are crashes.

The packaged desktop app permits one native process. The single-instance gate
runs before all other native plugins. A second launch focuses the existing main
window and cannot read or advance the renderer startup marker.

The recovery shell always loads. If the failure shell chunk cannot be imported,
an inline entry-chunk fallback renders the original bounded code. It renders
`startup-interface-unavailable` when the Safe Start shell failed. This prevents
a blank window. The Safe Start branch leaves the marker unchanged. Settings
and normal-graph branches write their bounded failure
code into the marker before rendering, as the state machine requires.

Entering or leaving Safe Start does not read the following data:

- conversations, messages, and attachments
- profiles, API keys, and grants
- workspace roots and files
- skills
- Whiteboard retained versions and working copies
- portable settings
- the conversation database.

It does not migrate, repair, rewrite, or delete this data. It never retries an
interrupted tool call. Its only mutating recovery
action is an explicitly confirmed reset of the Tauri plugin's saved
main-window geometry. Opening the application-data directory is read-only, and
the one-launch normal retry writes only the bounded startup marker/retry token.

Orphaned Whiteboard provisional-state repair belongs to the normal lazy
conversation-load path, not Safe Start. It settles one generation-owned working
row from its mutation receipt, or discards it when its owning assistant message
is missing. Repeated loads are idempotent and do not create another retained
version or tool result.

Safe Start support reports reuse `llm-client:support-report` v1 — the same
current schema, final redaction, and immutable-byte delivery helpers used by
Settings. The recovery collector does not open normal stores. Store-dependent
sections are marked `unavailable` in `collection.sections`, and unavailable
counts and integrity facts remain unreadable in the report. Safe Start recovery
actions are recorded only as a closed action code and outcome. The desktop
`--safe-start` argument recognizes one exact flag. It performs no shell parsing.
