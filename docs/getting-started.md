# LC Getting Started

This guide explains how to launch LC, connect a model server, enable tools
safely, and import custom skills. It also explains the main product boundaries.

## Quick start

LC's JavaScript toolchain requires Node.js 26 (see [`.node-version`](../.node-version)
and [`package.json`](../package.json)). Install the locked dependencies. Then
start the browser development build:

```bash
npm ci
npm run dev
```

Then open `http://127.0.0.1:5173`. Go to **Settings**. Add an API base URL, such
as `http://localhost:1234/v1`. Then select a model. The browser build has no
encrypted key-store backend. Use the desktop build for credentials that you
want to keep.

To run the native desktop application, install Rust. Then install the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your
platform. Run:

```bash
npm run tauri:dev
```

That command stages the generated resources that Tauri validates before launch.
For a command that also installs or refreshes npm dependencies, use
`run_dev.cmd` on Windows or `bash run_dev.sh` on Linux/macOS. See
[Development](./README.md#development) for the complete command reference.

LC expects an API **base URL**, not a complete operation endpoint. The
[provider setup](#provider-setup) section lists examples for each supported API
variant.

## First run

1. Open Settings.
2. Add a server profile.
3. Choose the profile's API variant.
4. Enter its API base URL.
5. Test the connection.
6. Set the profile as active.
7. Choose a model in the model picker.
8. Open Workspace to let the model use tools.
9. If the task needs internet access, enable Web Access explicitly.
10. Add only the working directories that the task requires.
11. Clear any pre-approvals that you do not want.

Workspace enables and expands File I/O automatically. Web Access is off by
default.

When a response starts, LC freezes that conversation's execution configuration
until the pipeline settles. Its Workspace, Parameters, model changes,
execution settings, and quick export are unavailable. Other idle conversations
remain navigable, draftable, and configurable. Server/profile changes, model
load/unload/refresh, global Workspace settings, import, and reset remain
application-wide and are unavailable while any response or provisional
admission exists.

The model picker remains available for inspection and search.
Display and Appearance also continue to work. The side panel keeps its system
instruction and Settings navigation buttons available.

### Parameter presets

Open the **Parameters** tab from the labeled composer button. Built-in presets
apply distinct temperature and reasoning combinations. Top-p, top-k, maximum
output tokens, and repetition penalty remain disabled in every built-in preset.
Selecting a preset starts from a clean generation-control state, applies that
recipe, and writes its short instruction directly into the existing **System
prompt** textarea. The instruction is visible and editable; selecting another
preset replaces it. Stop sequences remain unchanged when switching presets.

**Repeat penalty**, top-p, top-k, and stop sequences are grouped under the
collapsed **Additional parameters** section. Thinking, temperature, maximum
output tokens, and the System prompt remain visible in the expanded-by-default
**Primary parameters** section. The temperature slider gently snaps to `0.6`.
Its compact info button remains available when the override is off and opens an
A–Z model-family reference for current recommended values and provider-specific
exceptions.

Manual generation-control changes produce **Custom**. Editing the System prompt
alone does not change the preset name. **Server default** disables every
generation override and clears the System prompt textarea while preserving stop
sequences. A System prompt entered afterward is still sent, but the label remains
**Server default** because preset detection tracks only generation overrides.
Exact values, provider compatibility notes, and official sources are documented
in [Data model → Built-in parameter presets](./data-model.md#built-in-parameter-presets).

For a desktop release, use the Tauri application to store API keys. The
browser and development build has no encrypted local key-store backend. Treat
its profile storage as ordinary browser storage, not as an encrypted secret
store.

### First-launch security warnings

Release binaries are unsigned and un-notarized, so both macOS and Windows
warn the first time a *downloaded* copy is launched. The warning is a
launch-time check only — once the app is open it runs with full, normal
capabilities, and the same installed copy never asks again. A freshly
downloaded update is a new file and warns once more.

On macOS, Gatekeeper blocks the app with "'LLM Client' can't be opened
because it is from an unidentified developer" (or, sometimes, that the app
is damaged). On macOS 15 Sequoia and later, right-click → Open no longer
bypasses this for unsigned apps; the flow is: attempt to open LC, dismiss
the block dialog, then open **System Settings → Privacy & Security**,
scroll down, and press **Open Anyway**. On older macOS, right-click the
app in Finder and choose **Open**. The terminal alternative that works on
every version strips the quarantine attribute from the extracted app —
run it on the `.app` after copying it out of the dmg, not on the dmg:

```bash
xattr -cr "/Applications/LLM Client.app"
```

On Windows, SmartScreen shows "Windows protected your PC"; choose
**More info → Run anyway**.

The full record, including why this happens, lives in
[Troubleshooting](./troubleshooting.md#macos-gatekeeper-blocks-the-first-launch).

## Concurrent chats

LC generates in two conversations by default. Use **Settings → Chat →
Concurrent chats** to select one, two, or three. The hard maximum is three. Use
three only when the machine and provider can sustain it. Changing this setting
does not cancel responses that already started.

You can switch chats or create a new chat while another response runs. Each
conversation keeps its own draft, staged attachments, edit state, scroll
position, Workspace disclosure state, and preview presentation for the current
application session. A chat beyond the active capacity keeps its editable
draft, but Send stays disabled until a slot opens.

The Sidebar attributes thinking, writing, tool use, permission/user attention,
stopping, final response saving, completion, and failure to the chat that owns
them. Use that row's status control to stop only that response. The control is
disabled after the response becomes terminal while its final storage write is
pending. Idle rows keep their ordinary Rename, Archive, Clone, and Export
actions. Permission and user-question dialogs from different chats appear one
at a time in arrival order and name their owning conversation.

See [Concurrent conversations](./concurrent-conversations.md) for the complete
ownership, persistence, recovery, and configuration contract.

## To-do list preview

When `lc_todo_write` creates task state, an assistant bubble can open the
Preview Overlay at its **To do list** tab. Use **Settings → Chat → To-do list
preview** to choose its presentation:

- **latest only** is the default. It shows only the newest logical list visible
  at the selected assistant message in that user turn.
- **all updates** keeps the earlier multi-list presentation. Updates to the
  same logical list are collapsed to its newest state; distinct lists remain in
  first-seen order.

The setting affects both the visible tab and its Copy action. It does not alter
stored conversation messages, the model-visible task-state projection, or the
checklist button's item-count badge. A selected turn with no accepted to-do
update shows the empty state rather than inheriting a list from an earlier
turn. The choice persists across restarts and portable settings export/import.
Older settings files without the field and **Reset to defaults** both select
**latest only**.

## Provider setup

Server profiles use a **base URL**, not a complete operation endpoint. Include
the provider's API version or base path, but omit `/chat/completions`,
`/responses`, `/messages`, `/interactions`, and `/chat`. Do not put credentials in URL
user-info, query parameters, or structured fragment parameters. Use the
profile's API key field.

| Server | API variant | Protocol | Base URL | Agentic tools |
|---|---|---|---|---|
| LM Studio OpenAI-compatible | OpenAI | Chat Completions or Responses | `http://127.0.0.1:1234/v1` | Yes |
| LM Studio Anthropic-compatible | Anthropic | Messages | `http://127.0.0.1:1234/v1` | Yes |
| LM Studio native REST | LM Studio REST | Chat | `http://127.0.0.1:1234/api/v1` | No. Use a compatible variant for tools. |
| Google Gemini native | Gemini REST | Interactions | `https://generativelanguage.googleapis.com/v1beta` | Yes, with function-capable models; live verification pending |
| OpenAI | OpenAI | Responses or Chat Completions | `https://api.openai.com/v1` | Yes, subject to the selected model |
| Anthropic | Anthropic | Messages | `https://api.anthropic.com/v1` | Yes, subject to the selected model |

The server editor groups its API chips in one bordered block. The first row is
**OpenAI**, **Anthropic**, **Gemini REST**, and **LM Studio REST**. A separator
divides it from the protocol row: **Responses · R** / **Chat Completions · CC**
for OpenAI, **Messages · M** for Anthropic, **Interactions · I** for Gemini, or
**Chat · C** for LM Studio. All variants show this second row, even when there
is only one selected protocol.

Selecting a chip does not fill or replace the Base URL. Enter the appropriate
root from the table yourself. All variants keep the generic placeholder
`http://127.0.0.1:1234/v1`, including Gemini REST.

Gemini REST uses a green `I` badge. Its endpoint hints and the bubble's
model-details popover show `/interactions`; the compact bubble footer does not.
Bubble footers use the same endpoint colors as the model pickers: blue `R` or
`CC`, amber `M`, green `I`, and purple `C`. Historical replies use their saved
endpoint; replies that did not save one retain the gray `O` fallback. See
[Gemini REST](./note-gemini-rest.md) for the native
request, retained history, and verification boundary.

LC appends the operation path selected by the profile. A base URL ending in
`/v1/messages` would therefore produce a duplicated path and fail.

LM Studio's native REST variant checks each request
field against the running server's schema. It returns `400` with the exact
reason when compatible variants usually accept the same request. LC handles
two common rejections. It corrects the text input item type.

It also removes a
`reasoning` value that the loaded model does not support. Each correction adds
one round trip to the first affected turn. For a more permissive path, use an
OpenAI-compatible or Anthropic-compatible profile.

For browser development, use the default proxy or enable CORS on the model
server. Direct routing is useful only when the server accepts browser
requests directly. Tauri can use the local proxy without a browser CORS
preflight.

Model discovery is separate from chat generation. Gemini REST uses native
paginated `/models` discovery and skips LM Studio probes. For other variants,
local and LAN profiles first use LM Studio's metadata-rich native model endpoint
when applicable; remote profiles request the configured base plus `/models`.
An explicit **Model fetching URL** disables the automatic probe sequence.
Gemini still follows pagination from that URL; the other variants request the
override once. See [Modules — Model Discovery](./modules.md#model-discovery).

`lc_web_search` and `lc_web_research` need one search provider configured in
**Settings → Workspace**. LC supports three providers. Exactly one provider
serves each call. LC does not fall back to another provider:

| Provider | Configuration | Notes |
|---|---|---|
| **Brave Search** | API key from [brave.com/search/api](https://brave.com/search/api) | Best general coverage |
| **SearXNG** | Base URL of an instance you run | Requires `json` under `search.formats` in its `settings.yml`. No public instance offers this. |
| **Marginalia** | API key — `public` works without signup | Indexes independent, text-oriented sites. Commercial coverage is narrow. The shared key allows ~3 queries/minute. |

**Search provider** selects the provider. `auto` selects the first configured
provider in the order Brave → SearXNG → Marginalia. The chip shows the current
selection. You can select a provider without deleting a key.

API keys are stored as AES-256-GCM encrypted files in the desktop platform
config directory and are excluded from portable settings exports. LC includes
a SearXNG base URL only under the shared
[URL credential rule](./security.md#url-credential-rule). A URL with user-info
or a recognized credential parameter is not treated as configured. The rule
checks URL queries and structured fragments. A nonempty value that is not a
valid HTTP(S) URL is also unconfigured. Settings import rejects it, and
settings export replaces it with an empty SearXNG value.

Marginalia results are licensed **CC-BY-NC-SA 4.0** under its free and
non-commercial keys. Supply your own key and check its terms against your use.

## Custom skills

Custom skills are Markdown files imported from Workspace into the current
conversation. Each import receives a new conversation-scoped UUID and is
enabled for that conversation immediately. Built-in skills use stable LC-owned
IDs and cannot be edited or exported.

The optional front matter supports these fields:

```markdown
---
name: Release checklist
description: Keep release work complete.
revision: 2
---

# Release checklist

Write the guidance here.
```

`name` defaults to the first Markdown heading and then to the filename.
`description` defaults to the first paragraph. `revision` is informational.
It does not perform version comparison or migration. LC does not retain a
supplied `id` from the file. It assigns a new conversation UUID to the imported
skill.

Skill content is limited to 256 KiB. An `lc_skill` list accepts 100 enabled
skills. Each serialized result has a 2 MiB limit. The Skills category controls
whether LC exposes `lc_skill`. Per-skill checkboxes control which built-in or
custom records the tool can list or retrieve. The first direct Skills activation
selects LC Tool Cheat Sheet and Simplified Technical English by default. Later
off and on cycles preserve the user's selections, including disabled built-in
skills. LC does not automatically inject skill content into the system prompt.

The built-in LC Tool Cheat Sheet is the only dynamic skill. During retrieval
and preview, LC builds it from the Core, File I/O, Shell, Web Access,
Whiteboard, Tool History, and Skills sections. LC keeps the Core section and
the categories currently exposed to the conversation. This filtering does not
expose a tool. Because Web Access starts off, its section appears only after
the category is enabled explicitly. Workspace exposure can change.

Therefore, a model that needs later guidance
should retrieve LC Tool Cheat Sheet again. It should not reuse an older result
from the conversation context or Tool History.

All other built-in and custom skills use static Markdown. Conversation archives
include custom skills.

## Conversation Whiteboard

Whiteboard is an optional two-owner Markdown workspace for one conversation.
Turning on Workspace also enables Whiteboard. Expand **Whiteboard** between
**Web Access** and **Skills** to open it or to disable it independently.
You can also use the Whiteboard action after **Attach** below the composer.

The overlay opens on the **Model** tab. Use the centered **Model** and **User**
tabs to switch boards. Use the previous/date/next controls to inspect retained
versions. The model can read both boards through `lc_whiteboard`. The model can
change only the Model board.

On the User tab, **Edit** exposes Markdown. **Save**
stores the pending board for the next sent message. It then returns to the
rendered preview. **Cancel** restores the last saved value. A User edit saved
during a model response is available to the next turn, not the active turn.

**Export** and eligible **Import** actions live in the footer. The export notice
names the exact Model and User selections that will be written to `model.md`
and `user.md` in the ZIP. Import appears only for an untouched empty Whiteboard
with no pending or active generation state. Disabling Whiteboard hides its tool
and composer action, disables the Workspace launch action, and preserves its
versions and pending User content.

## Important boundaries

- **Filesystem:** Rust canonicalizes paths, resolves symlinks, and rejects
  targets outside explicitly granted roots. Shell approval does not add a
  root.
- **Shell:** `lc_run_shell` prompts on every call and uses a platform-aware
  binary allowlist. Its hidden power-user entries can bypass the binary list.
  The `*******` entry also bypasses the popup. Do not use this entry in shared
  or untrusted conversations.
- **Web fetch:** `lc_web_fetch` blocks loopback, private, link-local, ULA,
  reserved, and other non-global targets, and checks every redirect hop.
- **Patch application:** `lc_apply_patch` commits each file atomically, but a
  multi-file patch is not one cross-file transaction.
- **Output limits:** Resource-intensive tool outputs and selected request
  bodies have explicit tool-specific bounds. The tools can truncate or reject
  large file reads, images, web responses, and search results. They can also
  truncate or reject directory listings, shell input, and patch inputs. See the
  [tool reference](./tools/tool-reference.md). Batch arrays and ordinary text
  fields without a tool-specific cap still remain subject to the model/provider
  request envelope. Do not treat that outer envelope as a per-tool guarantee.
- **Portability:** Encrypted desktop API keys are tied to the machine/user and
  are not included in settings exports. User-defined profile request-header
  names and values are excluded too. LC removes URL user-info and recognized
  credential parameters from queries and structured fragments. Re-enter
  credentials and custom headers after moving settings to another machine.

For the complete authorization contract, see
[TOOL-POLICY-MODEL.md](./tools/TOOL-POLICY-MODEL.md). For the full sandbox and
SSRF design, see [security.md](./security.md).

## Common connection problems

| Symptom | Check |
|---|---|
| `404` on chat | The base URL probably includes a terminal operation path. Remove it. |
| Native LM Studio profile rejected | Use a base ending in `/api/vN`, such as `/api/v1`. |
| `400 invalid_union` on `input` from native LM Studio | The server wants a different text item type than LC sent. LC retries with the type named in the error, so report it if the turn still fails. |
| `400` naming `reasoning` from native LM Studio | The loaded model does not support that reasoning value. LC retries once without the field, and the model then uses its own default. |
| No models found | Test the server's `/models` endpoint or set an exact Model fetching URL. |
| Browser request blocked by CORS | Use proxy routing or enable CORS on the server. |
| `401` or `403` | Check the profile API key and the provider's required API variant. |
| Tools are missing | Use OpenAI-compatible or Anthropic-compatible chat on LM Studio. Native REST does not expose tool calls. |
| Search/research fails | Configure a search provider in Settings → Workspace. |
| SearXNG returns `403` | Its JSON output is off. Add `json` under `search.formats` in `settings.yml` and restart the instance. |
| SearXNG returns `429` | Its limiter is blocking LC. Set `limiter: false` in `settings.yml`. |
| SearXNG returns no results | If every engine is suspended because of a rate limit or CAPTCHA, LC reports this state. Check the instance's engine health. |
| Marginalia returns `429` | The shared `public` key allows ~3 queries/minute. Request your own free key. |
| A recency filter seems ignored | Marginalia has no recency filter. SearXNG supports the `pd`/`pw`/`pm`/`py` presets but not a custom date range, and applies them only to engines that support it. Anything dropped is listed in `ignored_params`. |

## Creating a support report

For a problem that is not resolved by the checks above, open
**Settings → Support → Create support report**. LC creates the report
locally and shows the exact final JSON before anything is copied or saved. It
does not upload the report or make a network request.

Exact model identifiers and sanitized error descriptions are optional and off
by default. Leave them off unless they distinguish a provider or failure class.
Review the preview. Save `lc-support-v1-YYYY-MM-DD-HHmm.json`. Then attach the file
to the GitHub issue. The report excludes conversations, prompts,
reasoning, attachments, tool inputs/results, skill content, private paths,
credentials, exact endpoint hosts, and provider response bodies.

See [Support reports](./support-report.md) for the complete included/excluded
field list, bounds, schema, and GitHub issue workflow.

## Safe Start recovery

In a packaged desktop release, LC records only coarse startup phases. If one
launch ends before `ready`, the next launch still attempts normal startup. If
that second consecutive attempt also ends before `ready`, the following launch
opens Safe Start automatically. Development, browser use, StrictMode, hot
reload, ordinary same-process page reloads, and shutdown after `ready` do not
increase the counter.

Packaged desktop releases run one LC process. Another launch focuses the
existing main window and does not change the startup marker.

Safe Start is a temporary recovery surface, not a chat interface. It shows the
last completed phase and a structured failure code. It uses built-in visual
defaults. It skips conversation restoration, generation, tool calls, skills,
workspace tools, model discovery and synchronization, auto-archive, and
optional startup work. It never retries an interrupted tool call.

Available actions are:

- **Create support report** — previews, copies, or saves the same redacted v1
  report without opening normal stores
- **Retry normal start once** — consumes a one-launch override. If it fails,
  the next launch returns to Safe Start.
- **Reset saved main-window geometry…** — after confirmation, resets only the
  Tauri window-state plugin's saved size and position
- **Open application data directory** — opens the desktop data location for a
  manual backup or inspection without exposing its path in the recovery UI.

For a manual diagnostic launch, start the desktop executable with the exact
`--safe-start` argument. Safe Start does not offer database deletion, database
repair, portable-preference reset, or factory reset. See
[Troubleshooting](./troubleshooting.md) for the recovery sequence and data
guarantees.
