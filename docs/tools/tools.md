# Tools

All 21 built-in tools, their backends, and error handling patterns.

See [`tool-reference.md`](./tool-reference.md) for the full input/output schemas and [`tool-error-handling.md`](./tool-error-handling.md) for the complete error handling breakdown.

---

## Tool Catalog

The numbered catalog follows the canonical `BUILTIN_TOOLS` registry order.
Category tables below describe membership and UI grouping. They do not define
wire order.

| # | Tool | Handler | Backend | Authorization | Destructive |
|---|------|---------|-------------|------------|-------------|
| 1 | `lc_read_image` | `builtin/read_image.ts` | `fs_ops.rs` → `tool_read_image` | Directory grant or prompt | No |
| 2 | `lc_read_pdf` | `builtin/read_pdf.ts` | `pdf.rs` → `tool_read_pdf` | Directory grant or prompt | No |
| 3 | `lc_read_file` | `builtin/read_file.ts` | `fs_ops.rs` → `tool_read_file` | Directory grant or prompt | No |
| 4 | `lc_write_file` | `builtin/write_file.ts` | `fs_ops.rs` → `tool_write_file` | Directory grant or prompt | Yes |
| 5 | `lc_list_dir` | `builtin/list_dir.ts` | `fs_ops.rs` → `tool_list_dir` | Directory grant or prompt | No |
| 6 | `lc_web_fetch` | `builtin/web_fetch.ts` | `web.rs` → `tool_web_fetch` | Conversation grant or prompt | No |
| 7 | `lc_get_current_time` | `builtin/get_current_time.ts` | Pure JS | No prompt when Workspace is on | No |
| 8 | `lc_run_shell` | `builtin/run_shell.ts` | `shell.rs` → `tool_run_shell` | Prompt on every call (`*******` auto-approves) | Yes |
| 9 | `lc_todo_write` | `builtin/todo_write.ts` | Pure JS | No prompt when Workspace is on | No |
| 10 | `lc_ask_user` | `builtin/ask_user.ts` | Pure JS + modal | No prompt when Workspace is on | No |
| 11 | `lc_whiteboard` | `whiteboard.ts` | Pure TypeScript + conversation store | No prompt when exposed | No (versioned) |
| 12 | `lc_grep` | `builtin/grep.ts` | `grep.rs` → `tool_grep` | Directory grant or prompt | No |
| 13 | `lc_edit_file` | `builtin/edit.ts` | `edit.rs` → `tool_edit` | Directory grant or prompt | Yes |
| 14 | `lc_web_search` | `builtin/web_search.ts` | `web_search.rs` → `tool_web_search` | Conversation grant or prompt | No |
| 15 | `lc_web_research` | `builtin/web_research.ts` | JS + sub-agent LLM | Conversation grant or prompt | No |
| 16 | `lc_stat` | `builtin/stat.ts` | `fs_ops.rs` → `tool_stat` | Directory grant or prompt | No |
| 17 | `lc_glob_files` | `builtin/glob_files.ts` | `glob.rs` → `tool_glob_files` | Directory grant or prompt | No |
| 18 | `lc_apply_patch` | `builtin/apply_patch.ts` | `apply_patch.rs` → `tool_apply_patch` | Directory grant or prompt | Yes |
| 19 | `lc_tool_help` | `builtin/tool_help.ts` | Pure JS | No prompt when exposed | No |
| 20 | `lc_tool_history` | `builtin/tool_history.ts` | Pure JS | No prompt when exposed | No |
| 21 | `lc_skill` | `builtin/skill.ts` | Pure JS | No prompt when exposed | No |

`lc_web_search` and `lc_web_research` additionally need a **search provider**
configured in Settings → Workspace — Brave Search, a self-hosted SearXNG
instance, or Marginalia. Exactly one serves each call. There is no fallback
between them. Configuration does not affect *exposure*. Without a configured
provider, both tools remain exposed. They return an error that names the three
options. `web_access_enabled` controls exposure (see below). Both tools report
parameters the active provider cannot honour rather than dropping
them silently. See [`search-providers.md`](../search-providers.md).

---

## Tool Groups

Tools use one foundation group and six user-toggle groups. Tool Help is a
derived eighth policy category. **Exposure** and
**grant** are separate, independent layers. Skills switches are availability
controls, not grants. See [`TOOL-POLICY-MODEL.md`](./TOOL-POLICY-MODEL.md) for
the normative policy.

### Exposure (category toggles)

Controls which tools appear in the request's `tools` array. The Workspace
master exposes foundation tools. The six category toggles add optional tools.
Checkmarks never hide tools.

| Group | Toggle | Exposed tools |
|---|---|---|
| **Foundation** | Workspace master | `lc_todo_write`, `lc_ask_user`, `lc_get_current_time` |
| **File I/O** | `file_io_enabled` | All 10: `lc_read_file`, `lc_read_image`, `lc_read_pdf`, `lc_write_file`, `lc_list_dir`, `lc_stat`, `lc_glob_files`, `lc_grep`, `lc_edit_file`, `lc_apply_patch` |
| **Shell** | `shell_enabled` | `lc_run_shell` |
| **Web Access** | `web_access_enabled` | All 3: `lc_web_fetch`, `lc_web_search`, `lc_web_research` |
| **Tool History** | `tool_history_enabled` | `lc_tool_history` |
| **Skills** | `skills_enabled` | `lc_skill` |
| **Whiteboard** | `whiteboard_enabled` | `lc_whiteboard` |

`lc_tool_help` has no toggle of its own. LC derives its exposure when File I/O,
Shell, Web Access, or Whiteboard exposes an operational tool.
Foundation, Tool History, or Skills alone do not expose it. The Workspace master
transition enables File I/O and Whiteboard. Their category toggles can disable
them afterward.

The built-in `lc:builtin:lc-tools` LC Tool Cheat Sheet follows this same exposure snapshot.
When it is retrieved or previewed, LC includes its Core section plus only the
sections corresponding to rows currently enabled above. It never adds tool
definitions, grants, or extra built-in skills. Other skills are static Markdown,
so a tool mention in skill text is not evidence that the tool is exposed.
The first direct Skills activation selects LC Tool Cheat Sheet and Simplified Technical
English once. Subsequent category off/on cycles preserve the user's skill
selections.

### Grant (popup suppression)

Within exposed tools, checkmarks control whether a call skips the permission popup:

| Grant scope | Field | Tools | Behavior |
|---|---|---|---|
| **Directory+tool** | `dir_permissions` | All 10 File I/O tools | Checkmark per directory and tool. A grant covers that root and its descendants for the same tool. Overlapping roots are additive, so an unchecked child tool does not shadow a checked ancestor tool. Seven read-only tools get grants when a user adds a root through Workspace. The user can clear these grants. Three mutating tools require explicit consent. Popup approval grants only the requested tool for the canonical target directory. Nested entries collapse when the request includes their parent. |
| **Conversation+tool** | `tool_grants` | All 3 Web Access tools | Conversation-scoped checkmark per tool. Checked → skip popup. Unchecked → prompt. |
| **Always prompt** | *(no persistent grant)* | `lc_run_shell` | Popup for each invocation. No stored grant can suppress it. The `*******` allowlist entry is the only bypass and causes auto-approval. See [Secret Grandmaster Virtual Binary](#secret-grandmaster-virtual-binary-) below. |
| **No prompt** | *(grant not needed)* | `lc_todo_write`, `lc_ask_user`, `lc_get_current_time`, `lc_whiteboard`, `lc_tool_help`, `lc_tool_history` | Foundation tools execute whenever Workspace is on. Whiteboard, help, and history execute only when their exposure rules include them. None creates a grant. |
| **Skills availability** | `enabled_skill_ids` | `lc_skill` | No popup. Returns only enabled skill records. Lists at most 100 records and caps serialized results at 2 MiB. Accepts built-in IDs (`lc:builtin:*`) and conversation-scoped custom UUIDs. |

File I/O popups display all required directories as read-only information and
approve or deny the whole logical call. The model can issue separate calls
when it needs finer-grained directory scopes.

Grant coverage is directional. A tool granted on a root applies to every
descendant, but a grant created on a child does not authorize its parent or
siblings. When roots overlap, LC uses the most-specific containing root that
grants the requested tool. A more-specific root without that tool is not an
implicit deny and does not shadow an enclosing grant.

`tool_grants` is the sole Web Access grant authority. Normalization
preserves current grant values, including an explicit empty array. It does not
infer grants or create missing current fields. The three defaults apply only to
a new config whose initialization marker is not explicitly `true`. A missing
marker identifies a new config. Normalization preserves the supplied marker.

`BUILTIN_TOOLS` provides the canonical registry order. `FILE_IO_NAMES`,
`FOUNDATION_NAMES`, `WEB_ACCESS_NAMES`, `SKILLS_NAMES`, and
`WHITEBOARD_NAMES` define category membership.

The first explicit Web Access activation checks all three Web Access grants.
Workspace activation leaves Web Access off by default. It enables File I/O and
Whiteboard. LC expands a section when activation changes its category from off
to on. Explicit Web Access activation expands its section and shows the default
grants. Workspace off/on cycles preserve the Web Access choice and explicit
checkmarks. This preservation includes an unchecked-all state. These cycles do
not reopen an enabled category that the user collapsed.

When Web Access is off, stored checkmarks stay visible but read-only.
Direct category activation can expand that category. Creating or switching
conversations uses a separate restart-ephemeral Workspace presentation state
for each chat. Switching back restores that conversation's disclosures; a new
conversation starts from its own collapsed defaults. This state is never shared
between conversations or persisted across application restart.

Roots added through Workspace receive the seven read-only File I/O defaults
once. Popup approval grants only the requested tool. It does not restore
unrelated defaults. Persistent approvals reread the latest conversation state.
They update only the requested tool and displayed target scopes.

A file batch
runs only after approval covers each listed scope. The popup has no per-scope
selection. Empty or partial approval makes no filesystem change.

### Whiteboard conversation state

`lc_whiteboard` is exposed only while Workspace and Whiteboard are on and the
provider supports structured tools. It has `grantScope: none`,
`promptPolicy: no_prompt`, and `mutability: conversation_state`. The toggle
creates no checkbox, directory grant, conversation grant, or permission popup.
Turning it off hides both the model tool and Whiteboard UI while preserving
retained versions and pending content.

One conversation has a model-owned Markdown board and a user-owned Markdown
board. The model can explicitly read both but can change only the model board.
LC never injects board Markdown, IDs, or history into the system prompt or an
ordinary message. A turn pins the user-board version at admission; later user
edits appear on the next turn. Reads use that pinned user version and the
latest applied model content from the active turn.

The flat strict schema has three actions: `read`, complete `replace`, and one
exact-occurrence `edit`. Empty replacement content clears the model board, and
an empty `new_string` deletes the exact match. Each board is limited to 32 KiB
of UTF-8 Markdown. LC never truncates it. Successful mutations return the
current references, `changed`, and `model_bytes` without echoing the board.

At most one exact `lc_whiteboard` call is admitted in a model-declared batch.
Two such calls both receive `whiteboard_batch_conflict` before either handler
runs. One Whiteboard call can run beside ordinary noninteractive tools. There
is no Whiteboard-specific per-turn total or read limit; the global tool-round
limit remains in force.

Tool History has a deliberate privacy projection for archived Whiteboard
retrieval. A Whiteboard result returns only the action and a redacted output
notice. Message lookup, or exact-call lookup for any result whose owning
assistant has Whiteboard references, adds one top-level `whiteboard_refs`
object. List and broad search do not repeat references, and search never
indexes board Markdown or mutation payloads. Canonical local messages and
conversation archives keep the original calls and results. When Tool History
is off, those complete historical calls and results also remain in provider
requests, like every other explicit tool exchange.

Canonical category lists are in the dependency-free `registry-names.ts`
module. `registry.ts` exports them as `FOUNDATION_NAMES`, `FILE_IO_NAMES`,
`WEB_ACCESS_NAMES`, `SKILLS_NAMES`, and `WHITEBOARD_NAMES`. `BUILTIN_TOOLS`
is the canonical registry and tool order.
Declarative policy metadata is in `policy.ts` as `TOOL_POLICY`.
`resolveExposure()` resolves exposure.

`authorizeCall()` resolves
authorization. Pure Workspace and category transitions are in
`workspace-state.ts`.

### What "secret" means here

The two entries below are documented, not concealed. "Secret" describes their
**exposure surface**. Neither string appears in the UI or is disclosed to the
model. `buildShellSection()` tells the model only that it can run any binary.
It does not state that LC waived the popup.

They are advanced options for someone who has read this page and typed the
string on purpose. Nothing inside LC can enable one on a user's behalf: no
built-in tool writes LC configuration, so a `*****` or `*******` entry always
means a person put it there. Their security therefore rests on that deliberate
act, not on the strings being unknown — which is why documenting them here costs
nothing.

### Secret Master Virtual Binary (`*****`)

`lc_run_shell` supports an opt-in escape hatch: if the string `*****` appears anywhere in the shell allowlist, the binary allowlist check is **completely bypassed** — the model can invoke any binary (`apt`, `pip`, `docker`, etc.). All other sandboxing (forbidden/secret environment filtering, byte-accurate I/O caps, timeout, CWD sandboxing) remains active.

- **Rust side** (`shell.rs`): the `has_master` flag short-circuits `list.contains(&cmd_basename)` to `true`.
- **JS side** (`system-prompt.ts`): `buildShellSection()` detects `*****` and generates a prompt telling the model it can run any binary (with platform-appropriate `cmd /c` guidance on Windows).
- **Permission popup**: still fires on every invocation — `*****` only relaxes the binary name check, not the human-in-the-loop requirement.
- **UI**: zero mention. A user can type `*****` in the Shell binaries text area
  in Workspace or Settings. The UI does not advertise this power-user feature.

### Secret Grandmaster Virtual Binary (`*******`)

A step above the master: the string `*******` (seven stars) implies the master behavior (any binary) **and additionally auto-approves** — the permission popup is suppressed entirely, so shell calls run without a human-in-the-loop prompt. All other sandboxing (forbidden/secret environment filtering, byte-accurate I/O caps, timeout, CWD sandboxing) still applies on the Rust side.

- **Rust side** (`shell.rs`): the `has_master` flag also recognizes `*******`, so the binary-name check is bypassed exactly as with `*****`. The popup suppression is a JS-side decision and is invisible to Rust.
- **JS side** (`approval-control.ts`): `permissionPopupRequired()` returns `false` for a `shell` call whose allowlist contains `*******` (its `shellAutoApproved` branch). `orchestrator.ts` consumes that as `needsPopup` and skips `resolveModal` entirely.
- **JS side** (`system-prompt.ts`): `buildShellSection()` treats `*******` like `*****` and generates the "allows any binary" prompt — the auto-approve behavior is never disclosed to the model.
- **Permission popup**: suppressed on every invocation. This is the only
  allowlist entry that disables the human-in-the-loop prompt. It is more
  permissive than `*****`.
- **UI**: zero mention. Like `*****`, a user can type it in the Shell binaries
  text area. The UI does not advertise the feature.

---

## Error Handling Pattern

Every tool returns bounded structured failures. The common pattern is:

1. **Identify the failed field safely** — many operational tools return a bounded path, pattern, or query when that helps recovery. Privacy-preserving tools can omit or redact content; Whiteboard never echoes complete board Markdown or mutation strings.
2. **Prescriptive message** — tells the model exactly what went wrong and how to fix it
3. **New output fields** help models self-correct:

| Field | Tool | Purpose |
|---|---|---|
| `fully_applied` | `lc_apply_patch` | `true` only if every file action reached its intended final state — instant commit-time partial-failure detection |
| `truncated_reason` | `lc_grep` | Names why completeness failed or was not determined. Reasons include cancellation, limits, traversal, and per-file sampling. `truncated: null` means LC could not prove completeness or omission |
| `visited_entries` | `lc_grep` | Directory entries walked |
| `files_selected` | `lc_grep` | Files chosen for content search after all filters — a FILE count, not a match count |
| `bytes_read` | `lc_grep` | Bytes read from selected files |
| `skipped_large` | `lc_grep` | Count of files skipped because >1 MiB |
| `skipped_binary` | `lc_grep` | Count of files skipped because binary (extension, NUL byte, or content) |
| `skipped_symlink` | `lc_grep` | Count of symlinked files skipped by the walk |
| `skipped_unreadable` | `lc_grep` | Count of files whose metadata or content could not be read |
| `files_transcoded` | `lc_grep` | Count of files decoded from UTF-16 before searching. A match from one carries `encoding` |
| `content_truncated` | `lc_grep` | Marks a match line cut at the 2000-character cap |
| `encoding` | `lc_grep` | On a match, marks a line that came from a transcoded UTF-16 file. Absent means UTF-8 |
| `before`/`after` | `lc_grep` | Numbered context lines around a match when `context_lines` was requested |
| `files`/`counts` | `lc_grep` | Result payload in `files_with_matches`/`count` output modes. `matches` is empty there. |
| `encoding` | `lc_read_file` | Names how content was decoded: `utf-8` unchanged, or `utf-16le`/`utf-16be` when a byte-order mark was transcoded — every write tool refuses a transcoded file |
| `confidence_note` | `lc_web_research` | Warns when sources are sparse, all usable sources share one hostname, preferred domains do not survive fetching, or candidate fetches fail |
| `tz_warning` | `lc_get_current_time` | Names the invalid `tz` field, reports the timezone used, and suggests valid examples without echoing the rejected value |

### Rust Error Envelope

```rust
#[derive(Debug, Error, Serialize)]
#[serde(tag = "code", content = "message")]
pub enum ToolError {
    PathOutsideRoots { path: String, allowed_roots: Vec<String> },
    NotFound(String),
    AlreadyExists(String),
    NotAFile(String),
    NotADir(String),
    PermissionDenied { operation, path, executable, native_code, native_reason },
    Io(String),
    TooLarge(String),
    BinaryDetected(String),
    Timeout,
    BlockedCmd(String),         // Basename only; the JS layer adds the allowlist to the message
    CwdNotFound { path, native_code, native_reason },
    CwdNotDirectory { path },
    CwdOutsideRoots { path, allowed_roots },
    ExecutableNotFound { executable, native_code, native_reason },
    WindowsBuiltinRequiresCmd { builtin, suggested_call, required_allowlist_entry },
    SpawnFailed { executable, native_code, native_reason },
    // ... etc
}
```

The `code` field is stable. The JS runner normalizes native codes to snake
case. It preserves fields such as `path`, `native_code`, `native_reason`, and
`suggested_call`. Native timeout and abort remain distinct terminal statuses.
They do not become `handler_exception`.

Permission and retry logic never parses
error strings. LC does not inspect successful process output for launch-error
phrases. LC never retries a shell call automatically.

File admission canonicalizes each extracted target before a popup or execution.
LC displays, stores, and passes the same canonical roots to the native
operation. Native code validates them again before access or mutation. LC
admits a multi-target mutation as one unit before the first item starts.

---

## Tool Runner

`runner.ts` orchestrates every tool execution:

```
executeToolCall(call, parsedInput, handler, ctx)
  ├─ Link AbortSignal → native abort_group(groupId)
  ├─ handler.run(parsedInput, ctx)          // Invoke via SandboxBridge
  ├─ Preserve native code/path/status in ToolResultEnvelope
  ├─ Enforce the complete serialized-result byte limit
  └─ Return { output, duration_ms, is_error? }

runWithPool(validatedCalls, maxToolCallsPerBatch, executor)
  ├─ Pool width equals Max tool calls per batch (1–64)
  ├─ Permission and Ask User prompts enter the application interaction FIFO
  └─ Each call → executor → { tool_call_id, output, is_error, duration_ms }

validateToolCalls(calls, handlersByName)
  ├─ Zod parse call.arguments against handler.input
  └─ Return { call, parsed, error? }

resolveHandler(call, enabledSet, handlersByName)
  ├─ Unknown tool → { denied: true, reason: 'unknown_tool' }
  ├─ Not exposed by Workspace/category → { denied: true, reason: 'not_exposed' }
  └─ Allowed → ToolHandler
```

The default complete result limit is 4 MiB of UTF-8. `lc_read_file` and
`lc_web_fetch` use 64 MiB. `lc_run_shell` uses 16 MiB. An oversized result
becomes a bounded `result_too_large` envelope with no partial data.
The remedy tells the model to narrow the request or split the work into several
calls.

The orchestrator serializes either denial as a structured `ToolResultEnvelope`
with an `issues[].code`. Neither path returns a plain policy-error string.

### Argument repair and worker bounds

After an initial JSON parse fails, `tryParseLenient()` scans backward for at most
50 candidate `}` or `]` endings. It tries to parse each corresponding prefix.
The limit bounds repair attempts; scanning, slicing, and parsing still depend
on input length. A repaired call returns to the model for explicit retry.

`runWithPool()` uses eight workers as the default limit for non-finite values
and values below one. It clamps values above 64 to 64. Invalid configuration
therefore uses the default instead of rejecting the operation. The actual
worker count is also limited by the number of items.

### Tool-turn observability and recovery

LC keeps all tool-call rounds for one model response on the same captured assistant message. `finalizeMessage(conversationId, assistantMessageId, patch)` append-merges `tool_calls` and nested-merges partial `meta` updates. Each continued round explicitly stores `finish_reason: "tool_calls"`, so the assistant bubble's clickable status chip stays in the **tooling** state until the loop reaches a final response or terminal error.

Assistant mutation and terminal finalization use the initiating assistant ID.
They never use a later “latest assistant” lookup. During an active response,
the five-second Dexie checkpoint saves that assistant and each following
`role: "tool"` result. Thus, a long tool loop remains checkpointed when its
latest message is a tool result. Normal completion releases only the matching
generation.

It performs a full delete-and-replace flush only when
`messageCount` proves that in-memory history is complete. Otherwise, it uses a
non-deleting upsert and reports the storage warning.

---

## Batch Support

| Tool | Batch field | Semantics |
|---|---|---|
| `lc_read_file` | `paths: string[]` | Same line range for all. Focused ranges use bounded chunks and are cancellable. Maximum 20. |
| `lc_read_image` | `paths: string[]` | Same encoding for all. Maximum 20. Analyze mode processes 10 and reports any dropped tail. |
| `lc_read_pdf` | `paths: string[]` | Same depth and page selection for all. LC admits the first 4 paths and reports a dropped tail. Summaries run in pairs in Rust. |
| `lc_write_file` | `files: [{ path, content }]` | Each file has its own content. Rust limits each/final file to 32 MiB and request content to 64 MiB. Maximum 20. |
| `lc_list_dir` | `paths: string[]` | Processes each directory independently. Maximum 20. |
| `lc_stat` | `paths: string[]` | Processes each path independently. Maximum 100. |
| `lc_grep` | `searches: [{ path, pattern, include? }]` | Each path has its own pattern and optional include override. Maximum 20. |
| `lc_edit_file` | `files: [{ path, old_string, new_string }]` | Each file has its own replacement. Maximum 20. |
| `lc_apply_patch` | N/A (single patch string) | Multi-file via patch format |
| `lc_todo_write` | `todos: [{ id, title, status, note?, completion_evidence? }]` | Replaces the complete list. Minimum 1 and maximum 20. |
| `lc_ask_user` | `questions: [{ id, question, choices }]` | Pauses for 1–3 structured questions. Each question has 2–5 choices. |

`lc_todo_write` stores model-maintained progress metadata. A successful update
does not prove that later tool work still matches it, and LC does not infer
completion, add a list lifecycle status, or require another model call to close
stale bookkeeping. Multiple tasks can be in progress. Missing optional
completion evidence produces one warning that names the affected task IDs.

Every workload-array field in this table requires at least one entry. An empty array is rejected
at validation with a field-specific instruction to add an entry. It is never
accepted as a silent no-op. Per-entry errors don't abort array-batched tools.
`lc_apply_patch` instead validates and prepares all deterministic actions before
its first commit. Commit-time failures or cancellation between file commits can
produce a partially applied multi-file result. Remaining cancelled entries say
that LC did not change them.

---

## Rust-Side Sub-Agent: `tool_analyze_images`

`lc_read_image` with `analyze: true` delegates to the `tool_analyze_images` Tauri command.
This command makes its **own HTTP request to a vision-capable LLM from Rust**.
Native PDF summaries also make LLM requests from Rust.

```
JS: read_image({ paths, analyze: true, downscale?, encoding? })
  → SandboxBridge.analyzeImages(args)
    → Tauri invoke('tool_analyze_images')
      → Rust reads + downscales + encodes images
      → Rust makes HTTP request to vision model (from user settings)
      → Returns { images: [...], analyzed: true, description: "...",
                  truncated, total_requested, processed_count,
                  analyzed_count, described_count, dropped_count, warning? }
```

**Why Rust-side?** Keeps base64 image data out of the main conversation context. The sub-agent model is configured in Settings → Sub-agent models → Image analyze, filtered from all active cross-server profiles for vision-capable models only.

The analysis request carries the parent tool call's operation and group IDs.
It registers a native cancellation token before image preparation. Pressing
**Stop** cancels an active vision HTTP request and returns the structured
`Aborted` tool status. LC does not persist a late analysis result. Cancellation
drops LC's request future. However, a remote provider can finish inference that
it already started.

For a vision-capable chat model, non-analyze delivery uses the same transient
side channel. LC caches image bytes for five minutes and does not persist them
in the tool result. The data-URL limit is eight batches or 64 MiB. If expiry or
eviction removes a batch before delivery, LC tells the model that no image was
sent. It gives a literal retry with fewer paths, downscaling, or JPEG encoding.

A non-vision chat model should use `analyze: true`. For non-analyze calls, LC
returns `description: null` and puts the capability guidance in `warning`.

**Image processing pipeline (analyze mode):**
1. Read raw bytes from disk (max 50 MiB hard cap)
2. Decode and validate dimensions (max 16384 px, max 100 MP)
3. Downscale if `downscale < 1.0` (Lanczos3 filter, min 1×1 px)
4. Encode: default `medium_jpeg` (q60), or `low_jpeg` (q30) / `original`
5. Cap check: **5 MB per encoded image**. Reject with actionable error if exceeded.

Analyze mode processes at most ten input paths. When the request is larger, the
result reports how many paths were requested, processed, successfully encoded
and admitted to a vision request, returned usable descriptions, and dropped.
Admission does not assert network delivery. The warning remains separate from `description`.
Per-image numbering uses the original request position. Encoding and analysis
failures remain in the affected image entry's `error` field. If no description
is produced, `analyzed` is false and `description` is null.

Every per-image request asks for a 4,000-token provider ceiling. Rust caps a
successful provider body at 1 MiB, non-success detail at 16 KiB, and accepted
description text at 64 KiB of UTF-8. Blank, malformed, oversized, and
non-success responses stay as bounded per-image errors.

**Vision request timeout:** applied **per image request**, not to the batch — 120 s by default and 180 s on Anthropic vision paths (`DEFAULT_VISION_TIMEOUT_SECS` / `ANTHROPIC_VISION_TIMEOUT_SECS` in `fs_ops.rs`). There is no total-time formula and no ceiling: images are analyzed with bounded concurrency, two at a time, so wall time scales with `ceil(image_count / 2)`. Uses `tokio::time::timeout` — the 30 s connect timeout is separate. A timeout error reports the selected duration and which image hit it (`image N/M`).

---

## Internal path commands

The model-facing `lc_stat` tool invokes the batch native command `tool_stat`. `tool_check_path` is an internal existing-path validator used by Workspace root UI.

`tool_resolve_path` is internal-only. Permission admission uses it to obtain the same canonical target identity as native execution, including a reconstructed missing-create target based on its nearest existing canonical ancestor.

---

## Verification

```bash
npm test
npm run test:rust
```

Test counts are not repeated here because the suite changes frequently. The
commands above are authoritative. Production-path regression tests cover:

- exposure and grants
- modal recovery
- canonical filesystem containment and missing-create identities
- result and error preservation
- group cancellation
- provider call/result order
- multi-round assistant metadata preservation
- tool-turn checkpoint selection
- history IDs, exposure, and budgets
- web-research limits
- SSRF targets and redirects
- shared grep budgets
- invalid glob patterns

Exposure and grant tests include Workspace activation transitions, grant
normalization, default Web Access grants, and complete batch approval.
They also cover child-directory scope, popup-only grants, nested-scope collapse,
and mixed `lc_stat` target scopes.
