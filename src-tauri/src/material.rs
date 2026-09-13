//! Native window material resolution and activation.
//!
//! The webview CSS alone cannot know whether a *native* window material
//! (Mica / Acrylic on Windows, AppKit vibrancy on macOS) is actually
//! active behind it — and root transparency is only safe when it is.
//! This module owns that decision:
//!
//!   - `desktop_platform` reports the platform compiled into this binary
//!     (no `navigator.platform` guessing).
//!   - `activate_window_material` applies the native effect for the
//!     requested mode and reports success/failure plus a bounded
//!     fallback reason, so the renderer can gate its transparent root
//!     on a confirmed activation and fall back to an opaque matte
//!     surface when activation fails.
//!
//! Linux never gets a native material: the base window config keeps the
//! window opaque there, and the resolver resolves to matte.

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime};

/// Result of a native-material activation attempt, mirrored to the
/// renderer. `reason` is only set when `active` is false and is
/// bounded by `BOUND_REASON_MAX` bytes so it is always safe to
/// include in diagnostics.
#[derive(Serialize, Clone, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MaterialActivation {
    /// The backend that was requested for this platform
    /// (`"mica" | "acrylic" | "vibrancy" | "matte"`).
    pub backend: &'static str,
    /// Whether the native effect is confirmed active.
    pub active: bool,
    /// Bounded human-readable reason when inactive.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// Longest fallback reason we will serialize (bytes of the truncated
/// string; the char boundary cut below guarantees valid UTF-8).
pub const BOUND_REASON_MAX: usize = 120;

/// Truncate a fallback reason to `BOUND_REASON_MAX` bytes on a char
/// boundary, so a driver error string can never bloat diagnostics.
pub fn bound_reason(reason: impl Into<String>) -> String {
    let reason = reason.into();
    if reason.len() <= BOUND_REASON_MAX {
        return reason;
    }
    let mut cut = BOUND_REASON_MAX;
    while cut > 0 && !reason.is_char_boundary(cut) {
        cut -= 1;
    }
    reason[..cut].to_string()
}

/// The desktop platform compiled into this binary. This is the
/// authoritative platform signal for material resolution — the
/// renderer's `navigator.platform` is never consulted.
pub fn compiled_platform() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

/// Windows 11 (build 22000) is where Mica becomes available; older
/// builds get Acrylic. Pure so it can be unit-tested for any build
/// number regardless of the host OS. The only non-test caller is the
/// windows block of `activate_material`, so the function compiles on
/// Windows and under `cargo test` and is absent elsewhere — without
/// the gate, non-Windows builds warn about dead code.
#[cfg(any(target_os = "windows", test))]
pub fn resolve_windows_backend(build_number: u32) -> &'static str {
    if build_number >= 22_000 {
        "mica"
    } else {
        "acrylic"
    }
}

#[cfg(target_os = "windows")]
fn windows_build_number() -> Option<u32> {
    use windows_sys::Wdk::System::SystemServices::RtlGetVersion;
    use windows_sys::Win32::System::SystemInformation::OSVERSIONINFOW;
    // SAFETY: `info` is a plain POD struct of the exact type the API
    // expects; RtlGetVersion only writes to it and reads nothing else.
    let mut info: OSVERSIONINFOW = unsafe { std::mem::zeroed() };
    info.dwOSVersionInfoSize = std::mem::size_of::<OSVERSIONINFOW>() as u32;
    // SAFETY: correct struct type and size set above.
    let ok = unsafe { RtlGetVersion(&mut info) } == 0;
    ok.then(|| info.dwBuildNumber)
}

/// Apply the platform's native material to the main window.
///
/// `requested` mirrors the persisted material mode
/// (`auto | glass | solid`); `dark` is the resolved theme base so the
/// native tint can follow the app theme. Returns the activation
/// result; every failure path resolves to matte, never to an
/// unpainted transparent surface.
pub fn activate_material<R: Runtime>(
    app: &AppHandle<R>,
    requested: &str,
    dark: bool,
) -> MaterialActivation {
    let matte = |reason: &str| MaterialActivation {
        backend: "matte",
        active: false,
        reason: Some(bound_reason(reason)),
    };

    if requested == "solid" {
        return matte("user-solid");
    }

    let Some(window) = app.get_webview_window("main") else {
        return matte("window-unavailable");
    };

    #[cfg(target_os = "windows")]
    {
        let backend = resolve_windows_backend(windows_build_number().unwrap_or(0));
        let result = if backend == "mica" {
            window_vibrancy::apply_mica(&window, Some(dark))
        } else {
            window_vibrancy::apply_acrylic(&window, None)
        };
        match result {
            Ok(()) => MaterialActivation { backend, active: true, reason: None },
            Err(error) => matte(&format!("{backend} activation failed: {error}")),
        }
    }

    #[cfg(target_os = "macos")]
    {
        let backend = "vibrancy";
        match window_vibrancy::apply_vibrancy(
            &window,
            window_vibrancy::NSVisualEffectMaterial::UnderWindowBackground,
            None,
            None,
        ) {
            Ok(()) => MaterialActivation { backend, active: true, reason: None },
            Err(error) => matte(&format!("{backend} activation failed: {error}")),
        }
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = (&window, dark);
        matte("linux-matte")
    }
}

#[tauri::command]
pub fn desktop_platform() -> &'static str {
    compiled_platform()
}

#[tauri::command]
pub fn activate_window_material<R: Runtime>(
    app: AppHandle<R>,
    requested: String,
    dark: Option<bool>,
) -> MaterialActivation {
    activate_material(&app, &requested, dark.unwrap_or(false))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_backend_splits_at_build_22000() {
        assert_eq!(resolve_windows_backend(21_999), "acrylic");
        assert_eq!(resolve_windows_backend(22_000), "mica");
        assert_eq!(resolve_windows_backend(26_200), "mica");
        // Unknown build number must fail toward Acrylic (Windows 10
        // behavior), never toward an unsupported effect.
        assert_eq!(resolve_windows_backend(0), "acrylic");
    }

    #[test]
    fn compiled_platform_is_one_of_three() {
        assert!(matches!(compiled_platform(), "windows" | "macos" | "linux"));
    }

    #[test]
    fn reason_is_bounded_on_char_boundary() {
        let reason = "é".repeat(BOUND_REASON_MAX);
        let bounded = bound_reason(reason);
        assert!(bounded.len() <= BOUND_REASON_MAX);
        // Multi-byte char: the cut must land before the char, not mid-char.
        assert_eq!(bounded.len() % 2, 0);
    }

    #[test]
    fn short_reasons_pass_through_untouched() {
        assert_eq!(bound_reason("mica activation failed"), "mica activation failed");
    }
}
