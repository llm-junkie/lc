//! Minimal desktop binary entry point.
//!
//! Applies platform startup settings, then delegates to the library's Tauri
//! application builder.

// Prevents additional console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(target_os = "linux")]
    apply_linux_webview_settings();

    llm_client_lib::run::<tauri::Wry>()
}

/// WebKitGTK startup env for the Linux webview. Runs before `run` so the
/// webview process inherits everything. Both settings honor a value the
/// user exports themselves — a pre-set variable is never overwritten.
#[cfg(target_os = "linux")]
fn apply_linux_webview_settings() {
    // Some webkit2gtk builds default to compositing-mode disabled, which
    // forces CPU-side painting even when GPU drivers are installed.
    // Explicitly enable it.
    if std::env::var("WEBKIT_DISABLE_COMPOSITING_MODE").is_err() {
        std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "0");
    }

    // WebKitGTK's DMABUF renderer crashes during startup on the NVIDIA
    // proprietary driver under Wayland: the process dies with
    // "Gdk-Message: Error 71 (Protocol error) dispatching to Wayland
    // display" before any window appears (observed on Fedora Workstation;
    // X11 sessions — e.g. Linux Mint Cinnamon — and other GPUs are
    // unaffected). Fall back to the non-DMABUF renderer for exactly that
    // combination; exporting WEBKIT_DISABLE_DMABUF_RENDERER yourself keeps
    // the GPU-accelerated path reachable when your stack doesn't crash.
    let session_is_wayland = std::env::var_os("WAYLAND_DISPLAY").is_some()
        || std::env::var_os("WAYLAND_SOCKET").is_some();
    let backend_allows_wayland = std::env::var("GDK_BACKEND")
        .map(|backend| backend.contains("wayland"))
        .unwrap_or(true);
    let nvidia_driver_loaded = std::path::Path::new("/sys/module/nvidia_drm").exists()
        || std::path::Path::new("/proc/driver/nvidia/version").exists();
    if session_is_wayland
        && backend_allows_wayland
        && nvidia_driver_loaded
        && std::env::var("WEBKIT_DISABLE_DMABUF_RENDERER").is_err()
    {
        eprintln!(
            "llm-client: NVIDIA + Wayland detected; disabling the WebKitGTK DMABUF renderer \
             to avoid the Wayland protocol crash (Error 71). \
             Export WEBKIT_DISABLE_DMABUF_RENDERER to override this choice."
        );
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
}
