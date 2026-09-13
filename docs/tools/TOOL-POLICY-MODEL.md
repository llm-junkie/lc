# LC Tool Policy Model

**Status:** Normative product and implementation contract  
**Date:** 2026-08-31\
**Applies to:** LC Workspace tool exposure, permission popups, pre-grants, execution admission, persistence, and contract tests  
**Implementation references:** [`tools.md`](./tools.md), [`tool-reference.md`](./tool-reference.md), [`tool-error-handling.md`](./tool-error-handling.md)

---

## 1. Purpose

LC separates two decisions that must remain independent:

1. **Exposure:** Which tool definitions are shown to the model.
2. **Grant:** Whether an exposed tool call may run without an interactive popup.

The distinction is fundamental:

> A category toggle controls exposure. A checkbox/checkmark controls popup behavior.

An exposed tool without a checkmark is not disabled or hidden. It remains
callable. LC asks the user for permission when the model calls it.

This document is the authoritative policy model. Current implementation behavior that conflicts with it is a defect to fix, not a reason to redefine the policy.

---

## 2. Normative terminology

### 2.1 Workspace enabled

The Workspace master toggle is on. If it is off, LC sends no Workspace tools to the model, regardless of sub-toggle or grant state.

### 2.2 Category toggle

One of six sub-toggles that controls exposure for a complete tool category:

- File I/O
- Shell
- Web Access
- Tool History
- Skills
- Whiteboard

### 2.3 Foundation tool

A foundation tool is exposed when Workspace is on. It has no category toggle,
settings row, or grant. The foundation tools are `lc_todo_write`,
`lc_ask_user`, and `lc_get_current_time`.

### 2.4 Exposed

The tool appears in the model request's `tools[]` array. It also appears in
corresponding system-prompt and tool metadata. The model can select it.

### 2.5 Not exposed

The tool is absent from the model request. A manually injected call to it is rejected as `not_exposed` without displaying a permission popup.

### 2.6 Pre-granted / checked

The user checked the relevant checkbox or accepted a persistent permission
popup. The popup updates the same visible state. A matching call skips the
popup within the documented grant scope.

### 2.7 Ungranted / unchecked

The tool remains exposed, but a matching call requires a popup.

### 2.8 Allow once

Authorization for one logical model tool call only. It is held in the immutable per-call context and is never persisted or reflected as a checkmark.

### 2.9 Allow for this conversation

A persistent grant for the current conversation. It must update the same visible checkbox/checkmark that controls future popup suppression.

### 2.10 Always prompt

The tool is exposed, but every invocation must receive its own popup. No stored grant may bypass it.
The hidden shell grandmaster (`*******`) is the sole exception. See §8.5.

### 2.11 No prompt

The exposed tool requires no user grant and executes directly.

---

## 3. Tool categories and membership

LC has 21 built-in tools in eight policy categories. The Workspace master
exposes three foundation tools. Six user toggles control optional exposure
categories. One derived category contains the read-only help tool.

### 3.0 Foundation — 3 tools

- `lc_todo_write`
- `lc_ask_user`
- `lc_get_current_time`

Workspace exposes these tools before it evaluates optional category toggles.
They execute without a popup and store no grant. Todo and Ask User use
conversation state. Current Time is a read-only local utility.

`lc_ask_user` must be the only model-declared call in its batch. LC rejects a
mixed batch before any sibling handler, grant check, or permission popup can
run. A sole valid call uses no ordinary operational deadline while it waits for
the user. Permission and ask-user prompts from every generation enter one
strict FIFO application queue. Queue wait is excluded from operational tool
deadlines, and a separate 30-minute absolute attention cap bounds every queued
or visible interaction. Parent generation cancellation still aborts the round.

### 3.1 File I/O — 10 tools

Controlled only by `file_io_enabled` for exposure:

- `lc_read_file`
- `lc_read_image`
- `lc_read_pdf`
- `lc_write_file`
- `lc_list_dir`
- `lc_grep`
- `lc_edit_file`
- `lc_glob_files`
- `lc_stat`
- `lc_apply_patch`

When File I/O is on, all ten are exposed. Per-directory checkboxes do not remove any of them from the model-visible tool list.

### 3.2 Shell — 1 tool

Controlled only by `shell_enabled` for exposure:

- `lc_run_shell`

When Shell is on, `lc_run_shell` is exposed. It always prompts, except under the hidden grandmaster `*******` allowlist entry, which auto-approves (see §8.5).

### 3.3 Web Access — 3 tools

Controlled only by `web_access_enabled` for exposure:

- `lc_web_fetch`
- `lc_web_search`
- `lc_web_research`

When Web Access is on, all three are exposed. Their individual checkboxes control pre-granting, not visibility.

### 3.4 Tool Help — 1 derived tool

- `lc_tool_help`

`lc_tool_help` is exposed when at least one File I/O, Shell, Web Access, or
Whiteboard tool is exposed. Foundation, Tool History, or Skills
alone do not expose it. It
executes without a popup and has no stored grant or category toggle.

Detailed catalogs currently exist for `lc_grep`, `lc_read_file`,
`lc_read_pdf`, and `lc_whiteboard`. A known exposed tool without a detailed
catalog returns `no_match`.

### 3.5 Tool History — 1 tool

Controlled only by `tool_history_enabled` for exposure:

- `lc_tool_history`

When Tool History is on, it is exposed and executes without a popup.

### 3.6 Skills — 1 tool

Controlled only by `skills_enabled` for exposure:

- `lc_skill`

When Skills is on, `lc_skill` is exposed and executes without a popup. The
conversation's `enabled_skill_ids` controls which skill records it may return.
These switches control availability, not permission. On a fresh
configuration, the first direct Skills activation selects LC Tool Cheat Sheet and
Simplified Technical English and sets `skills_initialized`. Later off/on cycles
preserve the user's exact skill selections. A missing marker is treated as
legacy/already initialized.

### 3.7 Whiteboard — 1 tool

Controlled only by `whiteboard_enabled` for exposure:

- `lc_whiteboard`

The Workspace master transition enables Whiteboard. When Workspace and
Whiteboard are on, `lc_whiteboard` is exposed and the conversation Whiteboard
overlay is available. The user can disable the category afterward. Disabling
it hides the composer action, disables the Workspace launch action, removes the
model tool, and preserves retained versions and pending state.

The tool reads conversation-owned state and can change only the model board.
It has no grant, permission checkbox, directory scope, conversation grant, or
popup:

```text
grantScope = none
promptPolicy = no_prompt
mutability = conversation_state
```

### 3.8 TokenMeter display mapping

Tool exposure and display accounting derive from the same canonical categories:

| Policy category | TokenMeter row |
|---|---|
| Foundation | `Foundation tools` |
| File I/O and Shell | `File I/O & shell` |
| Web Access | `Web access` |
| Whiteboard | `Whiteboard` |
| Tool Help, Tool History, and Skills | `Help, history & skills` |

Synthetic Tool History marker calls and stubs also use `Help, history & skills`.
An unknown imported tool uses a nonzero-only `Other tools` fallback. No tool
call, argument, result, marker, or stub belongs to `Replies`; that row contains
only assistant bubble `content` and `refusal` text.

---

## 4. Exposure rules

### 4.1 Master rule

```text
Workspace OFF
→ exposed set = ∅
```

No sub-toggle or checkmark may override this.

```text
Workspace ON
→ expose every canonical foundation tool
```

When the user turns Workspace on, the current default also turns on File I/O,
Tool History, and Whiteboard. It does not turn on Web Access, Shell, or Skills.
Web Access remains an explicit category choice. Workspace off/on cycles
preserve that choice and all explicit grant choices.

### 4.2 Category rule

```text
Workspace ON + category toggle ON
→ expose every canonical tool in that category
```

### 4.3 Checkbox independence

```text
Category ON + checkbox OFF
→ tool remains exposed
```

Unchecking a tool must never change:

- wire `tools[]` materialization
- system-prompt tool listings
- token-estimation tool schemas
- executor admission as an exposed tool
- provider adapter tool definitions.

### 4.4 Single source of category membership

Category membership must live in one canonical registry. Every layer imports the same lists. No duplicated hard-coded category arrays are permitted in request builders, prompts, UI, or tests.

Recommended metadata:

```ts
interface ToolPolicyMetadata {
  name: ToolName;
  category: 'foundation' | 'file_io' | 'shell' | 'web_access' | 'tool_help' | 'tool_history' | 'skills' | 'whiteboard';
  grantScope: 'directory_tool' | 'conversation_tool' | 'none';
  promptPolicy: 'grant_or_prompt' | 'always_prompt' | 'no_prompt';
  defaultGrantOnRootAdd?: boolean;
  mutability?: 'read_only' | 'mutating' | 'external_effect' | 'conversation_state';
}
```

An implementation-level permission boolean cannot represent the complete policy model. It cannot represent category exposure, grant scope, default pre-grants, or Tool History's no-prompt behavior. It also cannot represent shell's always-prompt rule and hidden grandmaster override. LC therefore keeps these decisions in declarative `TOOL_POLICY` metadata.

---

## 5. Authorization rules

Authorization happens only after all of the following:

1. The call's tool name is known.
2. The tool is confirmed exposed by the current Workspace/category snapshot.
3. Arguments pass schema validation.
4. Required target paths/scopes are extracted and canonicalized.

The authorization decision must not mutate global or conversation state.

### 5.1 Decision states

```ts
type AuthorizationState =
  | 'not_exposed'
  | 'prompt'
  | 'pregranted'
  | 'always_prompt'
  | 'no_prompt';
```

Meaning:

| State | Meaning | Popup |
|---|---|---|
| `not_exposed` | Workspace/category is off | No. Reject the call. |
| `prompt` | Exposed but missing visible grant | Yes |
| `pregranted` | Exposed and matching checkmark exists | No |
| `always_prompt` | Shell invocation | Yes, every call |
| `no_prompt` | Foundation, Tool Help, Tool History, Skills, or Whiteboard | No |

### 5.2 Unknown tools

A name absent from the built-in registry is `unknown_tool`, not `not_exposed` and not `prompt`. Unknown calls never open a grant popup.

### 5.3 Validation before prompting

Malformed arguments must not trigger a permission popup. LC first validates
the call and identifies its action. Only a valid, actionable call can request
permission.

### 5.4 Structured policy errors

Policy failures must use structured codes such as:

- `unknown_tool`
- `not_exposed`
- `invalid_arguments`
- `path_outside_roots`
- `grant_required`
- `permission_ui_unavailable`
- `denied_by_user`

Human-readable error strings must not be parsed to recover paths or grant scopes.

---

## 6. File I/O policy

### 6.1 Exposure

`file_io_enabled` exposes all ten File I/O tools.

### 6.2 Scope

File grants are scoped by:

```text
conversation + canonical directory/root + tool name
```

The authoritative persistent state is `dir_permissions`.

A grant on a canonical directory/root covers that directory and every
canonical descendant for the same tool. Coverage is directional: a child grant
does not authorize its parent, ancestors, or siblings. Grants on overlapping
roots are additive per tool. A more-specific root that lacks a tool checkmark
must not shadow a matching ancestor that grants that tool. The current schema
has grants, not implicit child-level denies.

Examples:

- read granted on `ROOT` authorizes reads on `ROOT` and its child directories
- write granted on `ROOT` authorizes writes on `ROOT` and its child directories
- write granted only on `CHILD` does not authorize writes on its parent `ROOT`
  or on `SIBLING`
- read granted on `ROOT` plus write granted on `CHILD` authorizes inherited
  reads and child-scoped writes in `CHILD`.

### 6.3 Allowed roots versus grants

`allowed_roots` and `dir_permissions` answer different questions:

- `allowed_roots`: Which filesystem roots may be considered by LC's File I/O sandbox.
- `dir_permissions[root]`: Which File I/O tools are pre-granted for that root.

A root may be allowed while a tool remains unchecked. The call then prompts.

Popup approval is scoped to the canonical target directory that triggered the
prompt. A configured enclosing root is only used for containment and matching.
It must never be substituted as the approval scope. If approval creates a new
target root, approval grants only the requested tool on that root. The seven
read-only defaults are reserved for an explicit root added through Workspace.

Creating that child grant does not shadow grants already provided by enclosing
roots. Conversely, the child grant never broadens the requested tool to an
enclosing root or a sibling.
When a batch requests both a directory and descendants of that directory, the
popup collapses the redundant descendant entries. It never invents a parent
scope when only child directories were requested.
The popup displays all required directory scopes as read-only information.

The
user approves the whole logical call with **Allow once** or **Allow for this
conversation**, or rejects the whole call with **Deny**. The model can issue
separate calls when it needs finer-grained directory scopes.

### 6.4 Default read-only pre-grants

When the user adds a File I/O root through Workspace, LC automatically checks
seven read-only tools. Calls under that root do not show a permission popup. If
the user clears a matching checkmark, calls for that tool prompt again:

- `lc_read_file`
- `lc_read_image`
- `lc_read_pdf`
- `lc_list_dir`
- `lc_stat`
- `lc_glob_files`
- `lc_grep`

The three mutating tools are not auto-granted:

- `lc_write_file`
- `lc_edit_file`
- `lc_apply_patch`

This is an initialization default, not an unchangeable policy. The user may uncheck a read-only tool. Once unchecked, it remains exposed but prompts on the next matching call.

### 6.5 Root-add implementation rule

Every code path that creates a new root must call one shared store action, for example:

```ts
addAllowedRoot(root, { initializeReadOnlyGrants: true })
```

The authorization resolver must not add default grants again during each
execution. Repeated initialization would override deliberate user choices.

Persistence boundaries must preserve explicit grant data. Normalization may canonicalize its representation, but it must not invent or broaden authorization.

### 6.6 Target extraction

Every File I/O tool must expose all affected paths to the authorizer before execution.

Examples:

- `lc_read_file`: file path
- `lc_list_dir`: directory path
- `lc_write_file`: target file and parent directory
- `lc_edit_file`: target file
- `lc_apply_patch`: every create/update/delete/move source and destination parsed from the patch

A multi-target call is pre-granted only when every target is covered by a
matching ancestor-or-exact directory+tool checkmark. Overlapping grant roots
are searched per tool, from most specific to least specific. A root that lacks
the requested tool is skipped rather than treated as a deny. Otherwise the
popup lists the missing exact target scopes.

### 6.7 Canonical identity

Grant matching uses canonical filesystem identities, not raw string prefixes. It must account for:

- `.` and `..`
- case rules on the current platform
- trailing separators
- symlinks/junctions
- UNC and extended Windows forms
- alternate lexical paths to the same file.

The native tool revalidates the canonical target immediately before performing an operation to reduce time-of-check/time-of-use drift.

### 6.8 Popup outcomes

For a missing File I/O grant:

- **Deny:** return `denied_by_user`. Do not change state.
- **Permission UI unavailable:** return `permission_ui_unavailable`. Fail closed
  without executing the tool. Do not claim that the user denied it.
- **Allow once:** execute only this call using a temporary per-call grant for every listed scope.
- **Allow for this conversation:** add the tool checkmark to every listed canonical directory/root and update the UI-visible state.

---

## 7. Web Access policy

### 7.1 Exposure

`web_access_enabled` exposes all three tools as a category.

### 7.2 Grant scope

Web Access grants are scoped by:

```text
conversation + tool name
```

They are not directory-scoped.

### 7.3 Checkboxes

Each tool's checkbox is a persistent pre-grant:

```text
checked   → exposed and no popup
unchecked → exposed and popup
```

The live field for these checkmarks is `tool_grants`. It is filtered to the canonical Web Access names when persisted state is normalized.

### 7.4 Defaults

LC initializes all three Web Access checkmarks when the category is first
enabled explicitly. Workspace activation does not initialize them. This is a
one-time default-state decision, not exposure logic. Toggling exposure and
computing the wire tool set remain independent from stored grants after
initialization.

Subsequent toggle-off/toggle-on cycles should preserve explicit user checkmark choices unless the product intentionally offers a reset action.

`web_access_grants_initialized` records that LC applied the one-time default. A
persisted `tool_grants` value, including an empty array, is authoritative.
Normalization filters and canonicalizes current fields. It does not fill an
omitted marker or replace grant choices. The current config initializes the
marker to `false`. That value receives the three defaults on first activation.

### 7.5 Popup outcomes

- **Deny:** no state change.
- **Allow once:** current call only.
- **Allow for this conversation:** check that tool in the visible Web Access list.

---

## 8. Shell policy

### 8.1 Exposure

`shell_enabled` exposes `lc_run_shell`.

### 8.2 Always-prompt rule

Every `lc_run_shell` invocation opens a popup, including:

- identical repeated commands
- commands previously allowed once
- commands issued concurrently
- commands whose binary is on the allowlist.

There is no persistent shell checkmark that suppresses the popup. The hidden
`*******` grandmaster allowlist entry is the sole exception to this rule and
suppresses the popup on every invocation. See §8.5.

### 8.3 Popup UI

The shell popup should not present a misleading persistent option. Preferred behavior:

- offer **Deny** and **Run once**
- if a shared modal still shows “Allow for this conversation,” treat it as
  current-call authorization only. Clearly state that the shell will ask again.

### 8.4 No prompt deduplication

Permission-popup deduplication for identical File I/O or Web Access scopes must not merge
separate shell invocations. Each logical shell tool call must receive an
explicit user decision.

### 8.5 Binary allowlist is separate

The shell binary allowlist determines whether the requested executable can
run. It does not grant permission or suppress the popup. The grandmaster
virtual binary is the only exception.

The hidden `*****` master virtual binary bypasses the binary-name check. The
hidden `*******` grandmaster virtual binary also suppresses the permission
popup through auto-approval. Stability refactors must preserve both behaviors
unless a separate product decision removes them.

### 8.6 Filesystem roots are separate

Shell runs outside LC's File I/O sandbox and may access paths beyond `allowed_roots`. That is why it always requires human approval. File I/O directory checkmarks do not authorize shell commands.

---

## 9. Tool History policy

### 9.1 Exposure

`tool_history_enabled` exposes `lc_tool_history`.

### 9.2 Authorization

Tool History reads conversation-owned archived results. It has:

```text
grantScope = none
promptPolicy = no_prompt
```

There is no checkbox and no permission popup.

### 9.3 Toggle-off behavior

When Tool History is off, the tool is absent from the model request. A manually injected call is rejected as `not_exposed` without a popup.

### 9.4 Archiving versus access

The implementation can use the same toggle to enable result archiving and
expose retrieval. These features are related. However, an exposed Tool History
call always runs without a prompt.

### 9.5 Whiteboard history privacy

Tool History does not become a model-facing board-version browser. When it is
on, completed Whiteboard turns use the same generic provider-request stubs as
other tools; active-turn calls and results remain complete. When Tool History
is off, provider requests replay complete historical Whiteboard calls and
results. This matches ordinary explicit tool replay and can consume substantial
context.

Retrieval through `lc_tool_history` applies a separate reference-only privacy
projection. A resolved archived Whiteboard result returns the original action,
a fixed redacted output notice, and no payload Markdown. Message lookup, or
exact-call lookup for any result whose owning assistant has Whiteboard
references, adds those references once at the top level.
List and broad search do not repeat references, and search never indexes board
Markdown. Canonical local messages and conversation archives keep the original
call and result.

If a result cannot be matched to its owning assistant tool call, retrieval
fails closed with an `unknown` name, empty arguments, and generic redacted
output. The unresolved item is excluded from every search field.

---

## 10. Permission modal semantics

### 10.1 Modal inputs

The modal receives a fully validated call plus structured scope information:

```ts
interface PermissionRequest {
  toolName: ToolName;
  modelToolCallId: string;
  argumentsJson: string;
  scopes: readonly GrantScope[];
  conversationTitle: string;
  modelId: string;
  persistenceAllowed: boolean;
}
```

It does not parse raw error messages to discover paths. The conversation title
and exact request model ID come from the generation's immutable execution
snapshot, so switching chats or editing later configuration cannot relabel a
queued prompt.

The header contains only **Permission required** and the close action. The body
shows `Chat:` and `Model:` context, then the sentence `The model is requesting
permission to call <tool_name>.` The chat title, model ID, and canonical tool
name use the accent color and bold weight; the word `call` keeps normal weight.

Directory scopes appear in the `Directory:` or `Directories (n):` block. For
`lc_read_file`, `lc_read_image`, `lc_read_pdf`, `lc_write_file`,
`lc_edit_file`, and `lc_apply_patch`, deduplicated direct file targets appear in
a separate `File:` block immediately below the directories. Directory search
tools and `lc_stat` do not get a file block because their paths can identify
directories. The `Show arguments` disclosure follows the path blocks and is
collapsed by default; expanding it reveals the complete formatted call JSON.

### 10.2 Modal results

```ts
type PermissionDecision =
  | { kind: 'deny' }
  | { kind: 'allow_once' }
  | { kind: 'allow_persistent'; scopes: readonly GrantScope[] };
```

For shell, `persistenceAllowed` is false.

### 10.3 Persistent approval must be visible

A persistent approval is valid only when it updates the corresponding visible checkmark:

- File I/O → directory/tool checkbox
- Web Access → conversation/tool checkbox

Hidden hashes that suppress future popups while the UI remains unchecked violate the policy model.

### 10.4 Concurrent prompts

File I/O and Web Access calls missing the same grant scope may share one in-flight
modal decision when it is persistent or fail-closed. **Allow once is consumed
by the one logical model tool call displayed in that popup. Each queued sibling
that still lacks a grant requires its own decision.** After a persistent
approval, queued calls re-authorize against latest state.

Shell calls never share a modal decision.

### 10.5 Modal failures

If the modal throws, unmounts, or loses its host, resolve the call as
unavailable. Fail closed with `permission_ui_unavailable`. Do not report the
failure as a user denial. The modal serialization chain must recover so later
calls can prompt.

### 10.6 Durable popup audit

Whenever LC persists a `role: "tool"` result for a call covered by a permission
popup, that result must carry the popup evidence. Calls which did not require a
popup have no permission audit. A generation cancelled before its tool result
boundary persists neither the result nor a partial audit. The audit is
conversation data and therefore survives normal message persistence, reload,
clone, conversation archive export/import, and the conversation's Tools panel.

```ts
interface ToolPermissionAudit {
  prompt_id: string;
  requested_at: number; // Unix ms: first covered call requested the popup
  shown_at?: number;     // Unix ms: modal host committed it; absent if never shown
  resolved_at: number;   // Unix ms: user decision, abort, or UI failure settled
  decision: 'allow_once' | 'allow_session' | 'deny' | 'aborted' | 'unavailable';
  displayed_call: {
    tool_call_id: string;
    tool_name: string;
  };
  scopes: string[];      // Canonical directory scopes displayed, in display order
}
```

`prompt_id` is LC-owned and must not be derived from the model's tool-call id.
When §10.4 deduplication lets several calls share one popup, all covered result
messages carry the same prompt id and timestamps. This makes popup order
independent from model call order and tool completion order. Shell invocations
never share an id because each invocation has its own popup.

`displayed_call` identifies the first persisted assistant tool call whose
details actually appeared in the shared modal. Its `tool_call_id` links to the
call's stored arguments without duplicating potentially large argument payloads
on every result. It may differ from the result carrying the audit when multiple
calls were deduplicated, so consumers must not substitute the current result's
call arguments.

`shown_at` is optional because an aborted request or unavailable modal host may
settle without displaying UI. `resolved_at - shown_at` is the observable time
the displayed prompt remained open. `shown_at - requested_at` is serialization
or host wait. The audit records evidence only: it is never consulted as a grant
and never authorizes a retry.

---

## 11. Recommended resolver architecture

### 11.1 Exposure resolver

Pure and synchronous:

```ts
function resolveExposure(config: ToolsConfig): ExposureSnapshot {
  if (!config.enabled) return emptyExposure();

  const names = new Set<ToolName>();
  addAll(names, FOUNDATION_NAMES);
  if (config.file_io_enabled) addAll(names, FILE_IO_NAMES);
  if (config.shell_enabled) names.add('lc_run_shell');
  if (config.web_access_enabled) addAll(names, WEB_ACCESS_NAMES);
  if (config.tool_history_enabled) names.add('lc_tool_history');
  if (config.skills_enabled) names.add('lc_skill');
  if (config.whiteboard_enabled) addAll(names, WHITEBOARD_NAMES);
  if (hasOperationalTool(names)) names.add('lc_tool_help');

  return { workspaceEnabled: true, exposedNames: names };
}
```

No grant field appears in this function.

### 11.2 Authorization resolver

Call-specific and side-effect free:

```ts
async function authorizeCall(
  call: ValidatedToolCall,
  exposure: ExposureSnapshot,
  grants: GrantSnapshot,
): Promise<AuthorizationDecision> {
  if (!exposure.exposedNames.has(call.name)) {
    return { state: 'not_exposed', allowed: false };
  }

  switch (categoryOf(call.name)) {
    case 'foundation':
    case 'tool_help':
    case 'tool_history':
    case 'skills':
    case 'whiteboard':
      return { state: 'no_prompt', allowed: true };

    case 'shell':
      return { state: 'always_prompt', allowed: false, prompt: shellRequest(call) };

    case 'web_access':
      return grants.toolGrants.has(call.name)
        ? { state: 'pregranted', allowed: true }
        : { state: 'prompt', allowed: false, prompt: toolGrantRequest(call) };

    case 'file_io': {
      const targets = await canonicalTargets(call);
      const missing = missingDirectoryToolGrants(targets, call.name, grants);
      return missing.length === 0
        ? { state: 'pregranted', allowed: true, targets }
        : { state: 'prompt', allowed: false, targets, prompt: directoryGrantRequest(call, missing) };
    }
  }
}
```

`missingDirectoryToolGrants` evaluates all containing roots for the requested
tool. It may choose the most-specific containing root that grants that tool for
diagnostics, but it must not choose one most-specific allowed root first and
then stop if that root lacks the tool. That behavior would make an added child grant
silently revoke an ancestor grant for unrelated tools.

### 11.3 Execution coordinator

The coordinator:

1. Resolves exposure from a snapshot
2. Rejects unknown or unexposed tools
3. Validates arguments
4. Obtains canonical targets
5. Authorizes without mutation
6. Obtains a popup result if necessary
7. Applies persistent grants through one store reducer
8. Builds a new immutable per-call context
9. Executes
10. records a structured terminal result.

---

## 12. Persisted state

### 12.1 Recommended target schema

```ts
interface ToolsConfig {
  enabled: boolean;

  file_io_enabled: boolean;         // Master activation sets true.
  shell_enabled: boolean;
  web_access_enabled: boolean;     // Master activation preserves this choice.
  tool_history_enabled: boolean;
  skills_enabled?: boolean;
  skills_initialized?: boolean; // distinguishes first enable from an existing user choice
  enabled_skill_ids?: string[];
  whiteboard_enabled?: boolean;  // Master activation sets true. The category remains independently toggleable.

  allowed_roots: string[];
  dir_permissions: Record<string, ToolName[]>;
  tool_grants: ToolName[]; // Stores conversation-scoped Web Access grants.
  web_access_grants_initialized: boolean; // Distinguishes first explicit enable from an unchecked-all state.

  shell_allowlist?: string;
  max_tool_rounds_per_turn: number;
  max_tool_calls_per_batch: number; // Batch ceiling and executor pool width
  sse_read_timeout_min: number; // Stream idle watchdog and per-tool-round deadline
}
```

There is no persistent shell grant. The hidden grandmaster `*******` allowlist
entry is the sole documented shell popup bypass. It is not a persisted grant
and is intentionally not exposed as a normal UI checkbox.

### 12.2 Persisted-state normalization

LC persists only the current policy shape. Load, import, export, and clone boundaries normalize path separators, redundant separators, dot segments, trailing separators, Windows case, duplicate grants, and unknown tool names. Directory permission entries are retained only when their normalized root is in `allowed_roots` and their tool is a canonical File I/O name.

Normalization canonicalizes current fields only. It does not infer missing
authorization from unrelated metadata. A missing `tools` object remains an
unconfigured conversation.

---

## 13. UI contract

### 13.1 Labels

UI copy should consistently use:

- **Expose** for category toggles
- **Pre-grant**, **Allow without asking**, or equivalent for checkboxes
- **Run once** for shell approval.

Avoid calling a checkbox “enable tool” because that suggests it controls visibility.

### 13.2 File I/O

- File I/O toggle: exposes all ten tools.
- Workspace activation enables File I/O. If that transition changes the
  category from off to on, LC expands the section. The user can disable or
  collapse it afterward.
- Root row: establishes allowed scope.
- Per-tool root checkbox: suppresses popup for that root/tool.
- Roots explicitly added through Workspace: seven read-only boxes checked by default, including `lc_read_pdf`.
- A checked root/tool applies to descendants. Overlapping root rows are
  additive. An unchecked child box does not override a checked ancestor box.
- While File I/O is off, root and grant state remains visible but read-only: no root add/remove, row expansion, or checkbox changes.

### 13.3 Web Access

- Category toggle: exposes all three tools.
- Individual checkbox: suppresses popup for that tool.
- While the category is off, stored checkbox state remains visible but read-only. Exposure state must not be folded into the rendered checked/unchecked value.

### 13.4 Shell

- Category toggle: exposes `lc_run_shell`.
- Binary allowlist: limits eligible executables.
- While Shell is off, the binary allowlist remains visible but read-only.
- No popup-suppression checkbox.

### 13.5 Tool History

- Category toggle: archives/retrieves history and exposes `lc_tool_history`.
- No grant checkbox.

### 13.6 Skills

- Category toggle: exposes `lc_skill`. Workspace activation does not enable it.
- Built-in skills use stable LC-owned IDs (e.g. `lc:builtin:lc-tools`)
  and are resolved from the LC built-in registry at runtime. They cannot be edited
  or deleted.
- Custom skills are imported per-conversation from Markdown files via the Workspace
  side panel. Each receives a conversation-scoped UUID. They are stored in the
  conversation's `custom_skills` field and included in conversation archives.
- Both built-in IDs and custom UUIDs are valid in the conversation's
  `enabled_skill_ids`.
- Per-skill toggle: makes that skill (built-in or custom) available to
  `lc_skill`. It is not a permission grant.
- `lc_skill({})` lists enabled skill IDs, names, descriptions, revisions, and
  `source` (`"builtin"` or `"custom"`). The list accepts at most 100 enabled
  skills.
- `lc_skill({ id })` returns the full Markdown for one enabled skill along with
  its `source`.
- The complete serialized list or retrieve result has a 2 MiB UTF-8 limit.
  Limit failures return a typed error without partial skill content.
- No permission popup, filesystem grant, Web Access grant, or shell authority.

### 13.7 Whiteboard

- Category toggle: exposes `lc_whiteboard` and renders the conversation
  Whiteboard UI while Workspace is on.
- Workspace activation enables Whiteboard. Before LC persists that transition,
  first enable creates the two empty owner baselines. Repeated enablement does
  not create more baselines. The user can disable Whiteboard afterward.
- The standard collapsed Whiteboard section appears after Web Access
  and before Skills. Expansion reveals its description and an `Open whiteboard`
  action; the composer action appears immediately after Attach.
- There is no grant checkbox or permission popup. The model can change only the
  model board, and the user UI can change only the user board.
- Disabling Whiteboard removes the composer action and model tool but preserves
  retained versions, a pending user copy, and all current heads.
- During active generation, the Whiteboard section is exempt from the muted
  Workspace presentation and remains expandable. Its exposure toggle is inert
  with the other execution-affecting settings, while both launch actions and
  the User Edit/Cancel/Save workflow remain usable because they do not change
  the active turn's pinned user version. Administrative package import remains
  unavailable.

### 13.8 Collapsible presentation state

- Collapsed/expanded state is presentation state only and never changes exposure or grants.
- Collapse state belongs to restart-ephemeral UI state keyed by conversation.
  Switching away and back restores that conversation's Workspace disclosures;
  creating a conversation starts from its own defaults. Presentation state must
  not leak between conversations.
- Directly enabling a category may expand that category so its controls are visible.
- Workspace activation expands File I/O and Whiteboard when it changes either
  category from off to on. Explicitly enabling Web Access expands that section
  and applies its automatic grant defaults on first enable. Workspace off/on
  cycles must not reopen an already-enabled category the user collapsed.
- Changing File I/O, Web Access, or any unrelated setting must not expand another category the user collapsed.

### 13.9 Active-generation configuration lock

- While the selected conversation owns a chat admission or response,
  its side-panel Workspace and Parameters bodies remain visible and every
  configuration control in them is inert. No exposure, conversation root,
  grant, category, skill, parameter, or limit mutation is admitted for that
  owner. Selecting an idle sibling restores that sibling's controls. The
  Whiteboard disclosure and `Open whiteboard` presentation action remain active
  for the generating conversation under the exception in §13.7.
- Category and directory expand/collapse stay outside the lock, consistent with
  13.8: collapse state is presentation state only, so reviewing what a running
  generation is configured with never mutates it.
- **See current system instructions** and **Open Settings > Workspace** remain
  active because they inspect or navigate without changing the executing
  generation.
- Settings > Workspace contains application-wide routing, helper, shell, search,
  and default-root configuration. It is inert while any chat admission
  or generation exists. Display and Appearance remain operational because they
  do not affect provider/tool execution. Settings > Conversations keeps the
  Concurrent chats selector live; lowering it changes later admission and does
  not terminate accepted sessions.
- Workspace callbacks re-check active ownership, and profile, model, parameter,
  reset, import, and archive boundaries enforce their parts of the same rule.
  the rendered disabled state is not the only boundary.
- The permission prompt belonging to the active tool call is not an
  out-of-band Workspace edit. It remains available, is bound to the generation's
  abort signal, and may persist a grant only while that owner remains active.

See [Concurrent conversations](../concurrent-conversations.md#configuration-boundaries)
for the target-scoped and application-wide mutation boundary.

---

## 14. Required invariants

These are non-negotiable contract assertions.

### Exposure invariants

1. Workspace off means no tools on the wire.
2. A user-toggle category on means every category member is on the wire.
3. Checkmarks never change the wire-visible set.
4. System prompt, request schemas, token meter, and executor use the same exposed set.
5. Tool Help is exposed exactly when an operational category exposes a tool.

### Grant invariants

6. Unchecked exposed File I/O and Web Access tools prompt.
7. Checked file tools skip popups for their granted canonical directories and
   descendants. Overlapping roots are additive per tool, and child grants never
   broaden to parents or siblings.
8. Checked Web Access tools skip popups for that conversation.
9. Allow once never persists.
10. Persistent approval always changes visible checkmark state.
11. Shell always prompts (except the grandmaster `*******` auto-approve, §8.5).
12. Foundation, Tool Help, Tool History, and Whiteboard never prompt when exposed.
13. Skills never prompts when exposed. Per-skill switches never alter other grants.

### Execution invariants

14. Unknown and not-exposed calls never open a grant popup.
15. Invalid arguments never open a grant popup.
16. A denied call produces a structured terminal result.
17. Every popup promise settles, including UI errors and aborts.
18. Concurrent non-shell prompts can deduplicate by scope. Shell prompts cannot.

---

## 15. Acceptance test matrix

| Workspace | Category | Checkmark | Tool class | Expected wire state | Expected call behavior |
|---:|---:|---:|---|---|---|
| Off | Any | Any | Any | Hidden | `not_exposed`, no popup |
| On | N/A | N/A | Foundation tool | Exposed | Execute silently |
| On | Off | Any | Optional category member | Hidden | `not_exposed`, no popup |
| On | On | Off | Web Access | Exposed | Popup |
| On | On | On | Web Access | Exposed | Execute silently |
| On | On | Off | File tool in allowed root | Exposed | Popup |
| On | On | On for target root | File tool | Exposed | Execute silently |
| On | On | On for different root | File tool | Exposed | Popup for missing root |
| On | On | Any | Shell | Exposed | Popup every invocation (suppressed by grandmaster `*******`) |
| On | Any operational category on | N/A | Tool Help | Exposed | Execute silently |
| On | Only History or Skills on | N/A | Tool Help | Hidden | `not_exposed`, no popup |
| On | On | N/A | Tool History | Exposed | Execute silently |
| On | On | N/A | Skills | Exposed | Execute silently. Return only enabled skill records. |
| On | On | N/A | Whiteboard | Exposed | Execute silently. Read both boards or change only the model board. |

Additional mandatory cases:

- A root explicitly added through Workspace initializes the seven read-only
  grants, including `lc_read_pdf`. Matching calls execute without a popup while
  that checkbox remains checked.
- Popup approval grants only the requested tool and never initializes unrelated read-only grants.
- A read grant on a root covers child directories even after a write-only child
  root is added.
- A write grant on a root covers child directories.
- A write grant on a child does not authorize its parent or siblings.
- If a user unchecks an auto-granted read-only tool, it remains exposed and prompts.
- Multi-file patch with one ungranted target prompts for the missing scope before mutation.
- Persisted state with empty checkmarks still exposes all active category tools.
- Prior approvals never suppress the shell popup.
- Workspace activation enables and expands File I/O when the category was off,
  without creating a directory or changing existing directory grants.
- Workspace activation enables Whiteboard. Disabling and re-enabling its
  category preserves all board state and creates no grant.
- Two exact Whiteboard calls in one model-declared batch both fail with
  `whiteboard_batch_conflict` before either handler runs.
- Three identical Web Access calls receiving a persistent or fail-closed decision
  share one modal. An **Allow once** response prompts once per logical Web Access
  call. Shell also shows one modal per invocation.

---

## 16. Implementation alignment as of 2026-08-31

The active implementation follows this policy model:

1. `resolveExposure()` is shared by wire materialization, execution admission,
   Tool History stubbing, and token estimation. Provider capability is resolved
   before each wire or presentation decision. Native LM Studio REST contributes
   no Workspace policy, structured definitions, tool-call parsing expectation,
   or Tool History estimate.
2. `tool_grants` is the live Web Access authority. Normalization filters it to
   canonical Web Access names. It preserves existing
   values, including an explicit empty array. It also preserves the supplied
   initialization marker. No alternate grant field is used.
3. Pure Workspace transition helpers enable File I/O, Tool History, and
   Whiteboard during master activation. They preserve Web Access, Shell,
   Skills, grants, and presentation state. The first explicit Web Access
   activation initializes all three grants once. Later toggles do not rewrite grants. Roots
   added through Workspace receive the seven read-only File I/O defaults once,
   including `lc_read_pdf`. Popup approval grants only the requested tool.
4. Persistent approvals reread the latest conversation state. They update only
   the requested tool and displayed target scopes. A file batch executes only
   after whole-call approval covers every displayed scope. The popup has no
   per-scope selection. Empty or partial approval makes no filesystem change.
5. Shell exposes only Deny and Run once and never reads or writes persistent grant state.
6. File admission uses canonical target identities before prompting, with native revalidation at execution. Structured native errors remain structured through the runner.
7. Tool History is stubbed only while it is actually exposed, and every archived assistant message receives a distinct stable paired call/result ID.
8. Skills is off by default, is not enabled by Workspace activation, and is exposed only through its category toggle. Per-skill switches filter `lc_skill` results without affecting tool grants.
9. File I/O, Shell, and Web Access grant controls are read-only while their
   category is off. Stored Web Access checkmarks remain visibly checked or
   unchecked. Workspace activation expands File I/O and Whiteboard only when it
   changes that category from off to on. Explicit Web Access activation expands
   that section. Later master cycles and unrelated toggles do not reopen an
   already-enabled collapsed section.
10. File grant resolution is additive across overlapping roots. It selects the
    most-specific containing root that grants the requested tool, so a
    write-only child does not shadow an enclosing read grant, while the child
    write remains confined to that child subtree.
11. Tool Help exposure is derived from the resolved operational set. The same
    snapshot filters help lookup. It has no popup, grant, or persistence field.
12. Foundation membership is resolved by the same exposure snapshot. A
    foundation-only Workspace sends and executes `lc_get_current_time`,
    `lc_todo_write`, and `lc_ask_user` in registry order, but it does not expose
    `lc_tool_help`. Successful todo state
    is reconstructed from current conversation messages and projected only
    when Tool History hides its source arguments.
13. `lc_ask_user` requires no permission decision, but it shares the strict
    application interaction FIFO with permission prompts. A sole valid call
    waits through the global question modal with no ordinary operational
    deadline and a separate 30-minute absolute attention cap. A mixed
    model-declared batch executes no sibling and returns one matching result per
    admitted call ID.
14. The Workspace master transition enables Whiteboard. Its category controls
    both `lc_whiteboard` exposure and UI availability and can be disabled
    afterward. It has no grant or popup. The batch governor admits at most one
    exact Whiteboard call and leaves unrelated siblings under their normal
    rules.
15. Archived Whiteboard retrieval through `lc_tool_history` is action- and
    reference-only. Board Markdown and mutation payloads remain canonical local
    data but are excluded from retrieval output and search candidates.

Regression coverage imports the production policy and execution helpers. Tests that merely asserted a documented claim are not counted as coverage.

---

## 17. Completion definition

The LC policy implementation is complete when a maintainer can answer both questions independently and deterministically for every call:

1. **Was this tool shown to the model?** Answered by Workspace and the relevant
   category toggle, or by derived operational exposure for Tool Help.
2. **Will this call show a popup?** Answered only by the tool's grant strategy, canonical call scope, visible checkmarks, and the shell/history exceptions.

No hidden grant, overloaded field, handler flag, or executor fallback may silently change either answer.
