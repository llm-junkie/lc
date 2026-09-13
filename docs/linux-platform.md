# Linux platform notes

Engineering record for Linux-specific platform behaviors LC ships with:
which of them are expected, which are upstream defects LC works around in
app code, and what removes each workaround. The user-facing
symptom/override documentation for the two startup defects lives in
[troubleshooting.md](./troubleshooting.md) — this page records the
mechanics and the maintenance contracts for developers.

Everything here was established against Linux Mint 22.3 Cinnamon (X11) and
Fedora 44 Workstation (GNOME, Wayland, NVIDIA proprietary driver), with
Windows 11 as the unaffected baseline. LC was manually tested and certified
working on all three systems on 2026-08-28.

## Linux uses an opaque native window

Linux never receives a native window material. The frontend does not request
native activation on Linux, the Rust activation fallback is matte, and the base
window stays opaque (`transparent: false` in `src-tauri/tauri.conf.json`). An
explicit Glass selection can still use translucent CSS surfaces inside the
app, but it cannot blur the desktop behind the LC window. Windows gets Mica
(build ≥ 22000) or Acrylic; macOS gets AppKit vibrancy.

LC currently uses one window-material policy for Linux instead of varying it by
desktop or compositor. The policy was introduced for Linux Mint Cinnamon,
where the tested desktop did not provide the OS-level blur path LC needed, and
was retained for Fedora/GNOME without a compositor capability probe. Other
compositors may support blur. Supporting them requires capability-based native
integration and runtime validation; until then, **LC does not provide desktop
blur on Linux.**

## Native window decorations follow LC's resolved theme

Linux keeps the desktop's native window decorations; LC does not replace the
titlebar or border with a custom frame. `ThemeProvider` passes the resolved
light/dark base to Tauri's typed `Window.setTheme` API, so GTK decorations
follow built-in themes, custom-theme bases, and system-theme updates. Tauri's
Linux theme operation is application-wide rather than scoped to one window.

Use the typed API rather than invoking `plugin:window|set_theme` directly. Its
IPC field is named `value`; an object shaped like `{ theme: base }` omits that
field and silently requests the system/default theme instead of LC's resolved
theme. On a dark Fedora desktop that can leave tao's client-side decoration
light even though the webview is dark.

This synchronization only selects the native decoration's light or dark
variant. Replacing the complete Linux frame remains separate future work.

### Compact tao 0.35 Wayland titlebar

tao 0.35 constructs LC's Wayland decoration as a GTK `HeaderBar` wrapped in
an `EventBox`. GTK's `has-subtitle` property defaults to `true`, reserving
vertical room for a subtitle even though LC does not have one. Before the
hidden main window is first shown, `compact_wayland_csd` finds that native
header and sets `has-subtitle` to `false`. The title, drag surface, and native
window buttons remain GTK-owned; only the unused subtitle reservation is
removed.

The hook runs only in Linux Wayland sessions and safely does nothing if the
expected tao widget tree is absent. X11 decorations remain controlled by the
window manager, while Windows and macOS do not compile this code. Reassess and
remove the hook when upgrading to tao 0.36, whose decoration path changes.

## Shift-key state must not trust Shift's own keyup flag

WebKitGTK (Linux webview) reports `shiftKey === true` on the `keyup` event
of the Shift key itself — the modifier still counts as held during its own
release event. WebView2 (Windows) reports `false` there. Code that stored
`event.shiftKey` on Shift's own keyup therefore armed Linux-only "stuck"
states: the sidebar's shift-to-arm delete button stayed showing Delete
after Shift was released. The release path also differed by display
server — X11 delivered a window blur that cleared the state, Wayland did
not — which is why Mint recovered on focus switch and Fedora did not.

The tracker and application-wide external store in
`src/ui/chat/shift-key-listeners.ts` implement the resulting contract:

1. Shift's own `keydown`/`keyup` derive held/released from the **event
   type**, never from the modifier flag.
2. Every other keystroke re-reads the live `shiftKey` state, so a keyup
   that never reaches the page (focus lost mid-hold, IME grab) self-heals
   on the next key press.
3. `pointerdown` and `pointermove` re-read the live modifier state too —
   recovery paths hover-driven arm states need on Wayland, where the webview
   may never see the blur. The press check also repairs display state before
   the later click handler runs.
4. Window `blur` and document `visibilitychange` release the state outright;
   the latter must be registered on `document`, where the browser dispatches
   it, rather than on `window`.
5. Duplicate notifications are suppressed; consumers only re-render on
   actual transitions.
6. Every React consumer shares that one store and therefore one DOM listener
   set. A long transcript does not add a `pointermove` listener per message.

`useShiftHeld` in `src/ui/chat/use-shift-held.ts` binds the external store to
a React surface through `useSyncExternalStore`, with an `active` flag for
surfaces that need not subscribe (the sidebar disables its subscription while
a rename input is open; the model picker disables it while closed; message
bubbles subscribe only when they expose Re-send). Consumers today:
`src/ui/layout/Sidebar.tsx` (conversation delete arm),
`src/ui/chat/MessageBubble.tsx` (re-send arm),
`src/ui/chat/ModelPicker.tsx` (row Hide arm),
`src/ui/settings/ModelVisibilityPanel.tsx` (row delete arm), and the
custom-skill rows in `src/ui/chat/SidePanel.tsx` (hover-gated).

Rule for new surfaces: never read `event.shiftKey` on Shift's own keyup — use
the hook for presentation. Any Shift-gated mutation must still validate the
current click event's `shiftKey`; reactive state controls what the user sees,
not authorization for a destructive action.

## WebKitGTK DMABUF renderer crash on NVIDIA + Wayland

WebKitGTK's DMABUF renderer crashes during startup on the NVIDIA
proprietary driver under Wayland, dying with
`Gdk-Message: Error 71 (Protocol error) dispatching to Wayland display`
before any window appears. X11 sessions and other GPUs are unaffected.

`apply_linux_webview_settings` in `src-tauri/src/main.rs` detects the
exact combination — a Wayland session (`WAYLAND_DISPLAY` or
`WAYLAND_SOCKET`), a `GDK_BACKEND` that permits Wayland, and the NVIDIA
driver present in `/sys/module/nvidia_drm` or
`/proc/driver/nvidia/version` — and exports
`WEBKIT_DISABLE_DMABUF_RENDERER=1` before the webview is created. A
user-exported value is never overwritten, so the GPU-accelerated path
stays reachable when a driver or WebKitGTK update fixes the crash. The
same function keeps `WEBKIT_DISABLE_COMPOSITING_MODE=0` (explicitly
enabled) as before.

Removal condition: a WebKitGTK release that renders DMABUF + NVIDIA +
Wayland without the protocol error. Independent of the tauri version.

## Dead native window buttons on Wayland (tao 0.35)

tao 0.35 — the windowing crate of the tauri 2.11 train LC builds on —
draws custom client-side decorations on Wayland and installs an
input-stealing container that leaves the native minimize/maximize/close
buttons dead on first show. A window created hidden and shown later
(LC's `visible: false` + `show()` startup) always trips it; a
maximize/restore cycle re-lays out the header and repairs it, which is
the user-visible "double-click the titlebar twice" workaround. Tracked
upstream as tauri issue 13440; fixed in tao 0.36, which reverts to GTK's
own CSD.

Until LC moves to a tauri release that carries tao ≥ 0.36, the
`on_window_event` hook in `src-tauri/src/lib.rs` performs the documented
interim repair: on the **first focus** of the main window under a Wayland
session it toggles `set_resizable(false)` then `set_resizable(true)`,
forcing the same header re-layout with no visible flicker. The toggle
runs once per process and is a complete no-op on X11, Windows, and macOS.

Removal condition: the tauri 2.12 train (tao 0.36 / wry 0.56). At that
upgrade, delete the hook and `nudge_wayland_csd_once`, then verify on a
Wayland session that the buttons respond to the first click — and that
the button set matches the desktop's decoration-layout preference, since
tao 0.36 hands decoration handling back to GTK/the compositor.

## Upgrade checklist for the tauri 2.12 train

1. Bump `tauri` and `tauri-build` in `src-tauri/Cargo.toml`; run
   `cargo update` and confirm `Cargo.lock` resolves tao ≥ 0.36 and the
   matching wry.
2. Delete the Wayland CSD hook in `src-tauri/src/lib.rs` (see above) and
   re-verify first-click buttons on Wayland.
3. Keep the NVIDIA + Wayland DMABUF guard in `src-tauri/src/main.rs`
   until WebKitGTK itself fixes the crash — it is independent of tao.
4. Re-check window-state restore behavior on Wayland after the upgrade;
   tao 0.36 changes the decoration path, so geometry save/restore should
   be smoke-tested on both X11 and Wayland.
