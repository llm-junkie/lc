# Troubleshooting

Start with the connection table in [Getting Started](./getting-started.md) for
provider, URL, CORS, model-discovery, and API-key problems. This page covers
failures that prevent LC from finishing desktop startup.

## When Safe Start appears

Automatic Safe Start is enabled only in packaged Tauri releases. A first
launch that ends before `ready` is counted as incomplete, but the next launch
still tries normal startup. If that second consecutive launch also ends early,
the third launch opens Safe Start. A successful normal startup resets the count
to zero.

The marker distinguishes a fresh native process from a reload. StrictMode,
Vite hot reload, browser and development launches, and ordinary same-process
reloads do not create additional incomplete starts. A normal shutdown after
`ready` also does not change the count. If marker or session storage is
unavailable, LC attempts normal startup. It reports a structured
marker-unavailable code instead of estimating the count.

Packaged desktop releases run one LC process. If LC is already running, another
launch focuses its main window. The second launch does not increase the
incomplete-start count.

You can request the recovery surface directly by launching the desktop binary
with `--safe-start`. This is a diagnostic override, not a permanent operating
mode. The shell always reports the recorded number of incomplete launches. An
explicit `--safe-start` on a healthy installation shows zero. A failed one-shot
retry shows the number of launches that had already ended early. It shows one
after a manual `--safe-start` and two after an automatic Safe Start.

A failed one-shot retry returns to Safe Start on the next launch. This rule also
applies when `--safe-start` opened the first recovery session. The shell reports
one incomplete start after that manual retry. It reports two after an automatic
Safe Start retry.

## If the recovery interface itself cannot load

The Safe Start and Startup Failure shells are separate dynamic chunks. If LC
cannot import either chunk, it shows a minimal **inline fallback**. This
fallback is compiled into the entry page and prevents a blank window. It
offers no support report, retry button, window-geometry reset, or data-directory
button. These controls cannot depend on a dynamic chunk.

The fallback shows
the bounded failure code. It also shows the last completed startup phase when
one was recorded.

A `startup-interface-unavailable` code means that the recovery shell chunk
failed to load. It does not mean that your data is damaged.

If you see this code, close LC. Then relaunch it once. A fresh launch tries to
load the dynamic chunks again. If the same screen returns, reinstall or restore
the application files. Include the `resources/` directory beside the
executable. Then relaunch LC.

These actions do not change conversations, settings, profiles, or keys. That
data remains in the application data directory. You can open this directory
from the OS file manager to make a copy before reinstallation.

## Conversation crash recovery

Conversation recovery is separate from Safe Start. Safe Start protects the
startup path. The conversation store protects message history during a
generation.

LC can own up to three generation sessions in different conversations. Each
admission writes a minimal journal row containing only conversation,
generation, and assistant ownership. While a response is streaming, LC
checkpoints that assistant and following tool results to Dexie/IndexedDB every
five seconds through a per-conversation lane. A complete generation receives a
terminal full-history barrier. LC releases its capacity slot only after the
barrier settles and compare-deletes the matching journal row.

If the process, WebView, or machine stops unexpectedly, startup discovers and
marks every remaining journal row. This includes more than three rows left by
an earlier interrupted recovery. Selecting each affected conversation
performs idempotent lazy repair. The conversation reopens from the latest successful
checkpoint, marked interrupted rather than complete. The most recent
uncheckpointed changes are not guaranteed to survive.

When you select a conversation after a restart, LC checks its assistant tool
calls against the stored tool-result messages. LC repairs an unresolved call
once. The deterministic error result states that completion and side effects
are unknown. LC never replays the tool automatically. A side effect might have
occurred even if LC did not save the result. LC writes the idempotent repair to
the conversation.

Recovery never resumes a model request or replays a tool whose completion is
unknown. Plain text, unanswered tool calls, and Whiteboard working rows are
reconciled against their own conversation/generation identity. Repeating a
crash during recovery is safe: deterministic repair rows and generation-fenced
journal retirement make the next load repeat only unfinished repair.

Persistence failures use a non-deleting fallback when LC cannot prove that the
in-memory history is complete. LC preserves existing durable rows. It shows a
storage warning instead of replacing them with a partial snapshot. With
concurrent generations, unresolved failures remain keyed by conversation. A
second chat's failure cannot erase the first. The Sidebar retains an unread
failure badge until the affected chat is viewed.

## Partially persisted assistant metadata

Assistant footer metadata is intentionally optional because a crash can occur
between the message checkpoint and the metadata/finalization update. The
footer therefore has a display-only fallback for every metadata chip:

- missing preset or generation parameters: `-` values in the preset chip and
  parameter popover
- missing model: `-` in the model chip, and `o` for its endpoint tag
- missing endpoint, server, or base URL: `-` in the model-details popover
- missing token counts, cache data, or duration: `-` in the token chip
- missing completion status: `-` in the status chip.

LC does not write these placeholders to the message. The placeholders do not
repair or infer provider data. They do not change the conversation archive.
They only keep an older or partial assistant reply renderable. The details
popovers use the same fallback. Therefore, a damaged reply can open without
every optional field.

## Render crashes

The top-level React error boundary replaces an unexpected render failure with a
reload screen. It does not retry the failed component automatically. Reloading
re-enters the normal startup and conversation-loading paths above. It does not
resume a generation or replay an interrupted tool call.

## Recovery sequence

1. Note the last completed startup phase and failure code.
2. Create a support report.
3. Review the exact JSON. Then copy or save it. Safe Start does not open
   settings, profiles, models, or conversation storage to make the report.
   Therefore, unavailable counts are expected.

   `collection.sections` names
   the collected and unavailable sections. The file is
   `lc-support-v1-YYYY-MM-DD-HHmm.json`. Settings and Safe Start emit the same
   schema. Preview, Copy, and Save receive byte-identical JSON. See

   [Support reports](./support-report.md).
4. If the window itself is unusable, choose **Reset saved main-window
   geometry…** and confirm the exact size/position reset. Tauri's restore layer
   already rejects malformed or off-screen saved geometry where supported.
5. Optionally open the application data directory. Make a manual copy before
   you make changes outside LC. Do not edit live WebView/IndexedDB files while
   LC is running.
6. Choose **Retry normal start once**. LC reloads into the normal bootstrap
   exactly once. If the retry fails, the next launch returns to Safe Start.
   LC does not reload repeatedly.

## What Safe Start does not do

Safe Start does not load an active conversation. It does not start or resume
generation. It does not execute or retry tools. It does not load custom skills
or workspace tools. It does not discover or synchronize models. It does not
run auto-archive.

Safe Start does not automatically delete or rewrite data. It also
does not migrate, reset, or repair data. This data includes conversations,
messages, attachments, profiles, API keys, tool grants, and workspace roots.
It also includes workspace files, skills, portable settings, and the
conversation database.

Interrupted tool calls are never assumed safe to repeat because their side
effects may already have occurred. When normal startup later succeeds and the
conversation is selected, LC's existing interrupted tool-round repair inserts
a durable unknown-completion result rather than replaying the call.

There is no database deletion, database repair, portable-preference reset, or
factory-reset action in Safe Start. If manual inspection suggests corrupted
data, preserve a backup and attach a redacted support report to the issue before
making external changes.

## Linux: WebKitGTK exits at launch on NVIDIA + Wayland

**Symptom.** Launching LC on a Wayland session with the NVIDIA proprietary
driver (seen on Fedora Workstation) exits before any window appears, printing
`Gdk-Message: Error 71 (Protocol error) dispatching to Wayland display.` when
started from a terminal. X11 sessions — Linux Mint Cinnamon, for example —
and other GPUs are not affected.

**Cause.** A defect in WebKitGTK's DMABUF renderer when it shares buffers
with the NVIDIA driver over Wayland. It is a webview-engine crash upstream
of LC; no LC code runs first.

**What LC does.** At startup the desktop binary detects this exact
combination — a Wayland session (`WAYLAND_DISPLAY` or `WAYLAND_SOCKET`), a
GDK backend that permits Wayland, and the NVIDIA driver present in
`/sys/module/nvidia_drm` or `/proc/driver/nvidia/version` — and exports
`WEBKIT_DISABLE_DMABUF_RENDERER=1` before creating the webview, which routes
WebKitGTK around the crashing renderer. The same launch from a `.desktop`
entry and from a terminal now behave identically.

**Overrides.** Exporting `WEBKIT_DISABLE_DMABUF_RENDERER` yourself (any
value) takes precedence; LC never overwrites a pre-set variable, so a driver
or WebKitGTK update that fixes the crash can restore the GPU-accelerated
path. `WEBKIT_DISABLE_COMPOSITING_MODE=1` is a heavier manual fallback that
also sidesteps the crash at the cost of CPU-side compositing.

Engineering mechanics and the removal condition are recorded in
[linux-platform.md](./linux-platform.md).

## Linux: native window buttons dead at first launch (Wayland)

**Symptom.** On a Wayland session (seen on Fedora Workstation; Linux Mint
Cinnamon's X11 session is unaffected) the native minimize / maximize / close
buttons do nothing when clicked. After double-clicking the titlebar to
maximize and double-clicking again to restore, the buttons work for the rest
of the session.

**Cause.** A defect in tao 0.35 — the windowing crate used by the tauri
2.11 releases LC currently builds on — which draws its own client-side
decorations on Wayland and installs an input container that swallows the
first clicks on the titlebar buttons. A window that is created hidden and
shown later, which is how LC starts, always trips it. The defect is fixed
upstream in tao 0.36 / tauri 2.12, which returns decoration handling to
GTK itself.

**What LC does.** On the first focus of the main window under a Wayland
session, LC toggles resizability off and back on. That forces GTK to
re-lay out the header — the same repair as the maximize/restore dance —
without any visible flicker, so the buttons work from the first click.
The toggle runs once per process and does nothing on X11, Windows, or
macOS. When LC moves to the tauri 2.12 train the workaround hook is
removed; the buttons then work natively. Engineering mechanics and the
removal checklist are recorded in [linux-platform.md](./linux-platform.md).

## macOS: Gatekeeper blocks the first launch

**Symptom.** A downloaded `LLM Client.app` (or an app copied out of a
downloaded dmg) refuses to open. macOS reports that the app "can't be
opened because it is from an unidentified developer" or that it "is
damaged and can't be opened." On macOS 15 Sequoia and later, the
right-click → Open shortcut no longer offers a bypass for this class of
app.

**Cause.** LC's release binaries are not code-signed and not notarized.
Gatekeeper attaches a quarantine attribute to files downloaded from the
internet and refuses to launch apps it cannot verify. On Apple Silicon
the binary carries an ad-hoc signature — required for any arm64
executable to run at all — but an ad-hoc signature does not satisfy
Gatekeeper. This is a property of the distribution channel, not of the
app itself.

**What to do.** Approve the app once per downloaded copy: attempt to open
it, then use **System Settings → Privacy & Security → Open Anyway**
(Sequoia and later), or right-click → **Open** on older macOS, or strip
the quarantine attribute from the extracted app with
`xattr -cr "/Applications/LLM Client.app"`. Once opened, LC runs with
full, normal capabilities — Gatekeeper is a launch-time check, not a
sandbox, and an approved copy never asks again. A freshly downloaded
update is a new quarantined file and warns once more. Code signing and
notarization would remove the prompt entirely, but they require an Apple
Developer ID wired into the release workflow.

Windows shows the equivalent SmartScreen dialog for the same reason;
**More info → Run anyway** is the one-time approval. Step-by-step
instructions for both systems are in
[Getting Started](./getting-started.md#first-launch-security-warnings).
