//! LC desktop Tauri library entry point.
//!
//! Owns application setup, native command registration, HTTP/model proxying,
//! encrypted desktop API-key storage, window state, and the Rust tool modules.

use futures_util::StreamExt;
use regex::Regex;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde::{Deserialize, Serialize};
use std::str::FromStr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use tauri::{ipc::Channel, AppHandle, LogicalPosition, LogicalSize, Manager, Runtime};

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine;
use rand::{rng, RngExt};
use sha2::Sha256;

// Tools module — Tauri command implementations.
// See docs/tools/tools.md for the tool catalog and
// docs/security.md for the sandbox design.
mod tools;

// models.dev integration — cloud API model metadata enrichment.
mod models_dev;

// Native window material (Mica/Acrylic/vibrancy) resolution + activation.
mod material;

mod commands {
    use super::*;
    use crate::tools::file_tx::FileTransaction;
    use std::fs;
    use std::io::Read;
    use std::time::Duration;
    use tauri::Manager;

    // Keep the standalone EXE usable even when someone copies only the
    // binary out of target/release instead of copying its `resources/`
    // directory as well. Packaged Tauri builds still use the external
    // resource first; this is only the self-contained fallback.
    const EMBEDDED_SPINE_BUILDER: &[u8] = include_bytes!("../../theme/spine-builder.html");
    const MAX_PROXY_BODY_BYTES: usize = 64 * 1024 * 1024;
    const MAX_DROPPED_FILE_BYTES: u64 = 25 * 1024 * 1024;
    const MAX_USER_SELECTED_WRITE_BYTES: usize = 1_000_000_000;

    static STREAM_COUNTER: AtomicU64 = AtomicU64::new(0);

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct StartupLaunchOptions {
        safe_start: bool,
    }

    fn contains_safe_start_argument<I, S>(arguments: I) -> bool
    where
        I: IntoIterator<Item = S>,
        S: AsRef<std::ffi::OsStr>,
    {
        arguments
            .into_iter()
            .any(|argument| argument.as_ref() == std::ffi::OsStr::new("--safe-start"))
    }

    /// Cross-platform command-line options consumed by the pre-App renderer
    /// bootstrap. Tauri exposes no shell parsing here: only an exact, bounded
    /// `--safe-start` flag is recognized.
    #[tauri::command]
    pub fn startup_launch_options() -> StartupLaunchOptions {
        StartupLaunchOptions {
            safe_start: contains_safe_start_argument(std::env::args_os()),
        }
    }

    #[cfg(test)]
    mod startup_launch_tests {
        use super::contains_safe_start_argument;

        #[test]
        fn safe_start_flag_is_exact_and_platform_neutral() {
            assert!(contains_safe_start_argument(["lc", "--safe-start"]));
            assert!(!contains_safe_start_argument(["lc", "--safe-start=true"]));
            assert!(!contains_safe_start_argument(["lc", "--SAFE-START"]));
        }
    }

    /// Shared reqwest client for short-lived requests (model lists,
    /// health checks, etc.).  Connection pooling is enabled so
    /// repeated calls reuse TCP+TLS connections.
    fn req_client() -> &'static reqwest::Client {
        static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
        CLIENT.get_or_init(|| {
            reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(30))
                .tcp_keepalive(Duration::from_secs(60))
                .tcp_nodelay(true)
                .pool_idle_timeout(Duration::from_secs(90))
                .pool_max_idle_per_host(2)
                .build()
                .expect("static reqwest req_client build")
        })
    }

    /// Shared reqwest client for SSE streaming requests.  TCP keepalive
    /// (60 s) prevents intermediate NAT / routers / cloud load-
    /// balancers from dropping idle connections during reasoning pauses.
    ///
    /// Connection pooling is DISABLED (pool_max_idle_per_host = 0).
    /// Streaming requests are long-lived POSTs — if a pooled connection
    /// goes stale between streams, reqwest does NOT retry POST on the
    /// dead connection (only idempotent GET / HEAD are retried), so the
    /// request fails with a connection-reset error.  A fresh TCP+TLS
    /// handshake per stream is cheap compared to the stream duration.
    ///
    /// No connection pool — every stream gets a fresh TCP connection
    /// with `Connection: close`.  Connection reuse (`keep-alive`)
    /// causes LM Studio's OpenAI-compat endpoint to return 500 on
    /// rapid re-streams during tool loops (the second request on the
    /// same connection fails while the first succeeds).
    fn stream_client() -> &'static reqwest::Client {
        static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
        CLIENT.get_or_init(|| {
            reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(30))
                .tcp_keepalive(Duration::from_secs(60))
                .tcp_nodelay(true)
                .pool_max_idle_per_host(0)
                .build()
                .expect("static reqwest stream_client build")
        })
    }

    #[derive(Debug, Deserialize)]
    pub struct ProxyRequest {
        pub url: String,
        pub method: String,
        pub headers: Vec<(String, String)>,
        pub body: Option<String>,
        #[serde(default, rename = "responseTimeoutMs")]
        pub response_timeout_ms: Option<u64>,
    }

    #[derive(Debug, Serialize, Clone)]
    pub struct StreamPayload {
        #[serde(skip_serializing_if = "Option::is_none")]
        chunk: Option<String>,
        done: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        status: Option<u16>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    }

    fn parse_proxy_url(path: &str) -> Option<(String, String, String)> {
        static RE: OnceLock<Regex> = OnceLock::new();
        let re = RE.get_or_init(|| Regex::new(r"^/lc-proxy/(https?)\+([^/]+)(/.*)?$").unwrap());
        let caps = re.captures(path)?;
        let proto = caps.get(1)?.as_str().to_string();
        let host = caps.get(2)?.as_str().to_string();
        let rest = caps.get(3).map(|m| m.as_str()).unwrap_or("/");
        Some((proto, host, rest.to_string()))
    }

    fn validate_proxy_body(body: Option<&str>) -> Result<(), String> {
        let bytes = body.map_or(0, str::len);
        validate_proxy_body_len(bytes)
    }

    fn validate_proxy_body_len(bytes: usize) -> Result<(), String> {
        if bytes > MAX_PROXY_BODY_BYTES {
            return Err(format!(
                "Proxy request body is {bytes} bytes. The native limit is {MAX_PROXY_BODY_BYTES} bytes."
            ));
        }
        Ok(())
    }

    async fn read_proxy_body_limited(response: reqwest::Response) -> Result<String, String> {
        if response
            .content_length()
            .is_some_and(|length| length > MAX_PROXY_BODY_BYTES as u64)
        {
            return Err(format!(
                "Proxy response body exceeds the native {MAX_PROXY_BODY_BYTES}-byte limit."
            ));
        }
        let mut stream = response.bytes_stream();
        let mut body = Vec::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|error| format!("Failed to read body: {error}"))?;
            if chunk.len() > MAX_PROXY_BODY_BYTES.saturating_sub(body.len()) {
                return Err(format!(
                    "Proxy response body exceeds the native {MAX_PROXY_BODY_BYTES}-byte limit."
                ));
            }
            body.extend_from_slice(&chunk);
        }
        Ok(String::from_utf8_lossy(&body).into_owned())
    }

    #[tauri::command]
    pub async fn proxy_request(req: ProxyRequest) -> Result<serde_json::Value, String> {
        validate_proxy_body(req.body.as_deref())?;
        // Two URL forms are accepted:
        //   1. /lc-proxy/{proto}+{host}/... — explicit proxy form. We
        //      strip the prefix and forward to {proto}://{host}/...
        //   2. http://host/path or https://host/path — direct form
        //      (used when the JS client picks "Direct" routing). Forward
        //      the URL as-is, with no rewriting.
        let target = if let Some((proto, host, rest)) = parse_proxy_url(&req.url) {
            format!("{}://{}{}", proto, host, rest)
        } else if req.url.starts_with("http://") || req.url.starts_with("https://") {
            // Direct routing — use the URL verbatim.
            req.url.clone()
        } else {
            return Err(format!("Invalid proxy URL: {}", req.url));
        };

        let client = req_client();

        let mut headers = HeaderMap::new();
        for (k, v) in &req.headers {
            if k.to_lowercase() == "host" || k.to_lowercase() == "connection" {
                continue;
            }
            if let (Ok(name), Ok(value)) = (HeaderName::from_str(k), HeaderValue::from_str(v)) {
                headers.insert(name, value);
            }
        }

        let method = reqwest::Method::from_str(&req.method.to_uppercase())
            .map_err(|e| format!("Invalid method: {}", e))?;

        let mut request = client
            .request(method, &target)
            .headers(headers)
            .timeout(Duration::from_secs(120));
        if let Some(body) = req.body {
            request = request.body(body);
        }

        let response = request
            .send()
            .await
            .map_err(|e| format!("Upstream request failed: {}", e))?;

        let status = response.status().as_u16();
        let resp_headers: Vec<(String, String)> = response
            .headers()
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
            .collect();
        let body = read_proxy_body_limited(response).await?;

        Ok(serde_json::json!({
            "status": status,
            "headers": resp_headers,
            "body": body,
        }))
    }

    /// Phase 2.3: UTF-8 safe streaming proxy with cancellation.
    ///
    /// Returns a stream ID immediately. The JS side supplies an IPC channel
    /// before the native relay starts and reads chunks until `done` is true.
    /// The first message has the HTTP status; subsequent messages carry text
    /// chunks; the final message has `done: true`.
    ///
    /// Fixes vs pre-2.3:
    ///   - UTF-8 safe: uses split_utf8_safe() so multi-byte sequences
    ///     split across network chunks are never corrupted.
    ///   - Cancellable: registers a CancellationToken so abort_tool_calls
    ///     can stop in-flight streams.
    ///   - Terminal events: abort/error/complete all produce a done event.
    #[tauri::command]
    pub async fn proxy_stream(
        req: ProxyRequest,
        on_event: Channel<StreamPayload>,
    ) -> Result<String, String> {
        validate_proxy_body(req.body.as_deref())?;
        let id = STREAM_COUNTER.fetch_add(1, Ordering::SeqCst).to_string();
        let response_timeout_ms = req
            .response_timeout_ms
            .unwrap_or(300_000)
            .clamp(1, 3_600_000);

        // Accept both proxy-form (/lc-proxy/...) and direct-form URLs.
        let target = if let Some((proto, host, rest)) = parse_proxy_url(&req.url) {
            format!("{}://{}{}", proto, host, rest)
        } else if req.url.starts_with("http://") || req.url.starts_with("https://") {
            req.url.clone()
        } else {
            return Err(format!("Invalid proxy URL: {}", req.url));
        };

        // Phase 2.3: Cancellation token for the streaming task.
        let cancel_token = tokio_util::sync::CancellationToken::new();
        let stream_call_id = format!("lc-stream-{}", id);
        let cancel_guard = tools::registry::register_with_group(
            stream_call_id,
            tools::registry::ToolHandle(cancel_token.clone()),
            None,
        );

        let client = stream_client();
        let mut headers = HeaderMap::new();
        for (k, v) in &req.headers {
            if k.to_lowercase() == "host" || k.to_lowercase() == "connection" {
                continue;
            }
            if let (Ok(name), Ok(value)) = (HeaderName::from_str(k), HeaderValue::from_str(v)) {
                headers.insert(name, value);
            }
        }
        let method = reqwest::Method::from_str(&req.method.to_uppercase())
            .map_err(|e| format!("Invalid method: {}", e))?;
        let mut request = client.request(method, &target).headers(headers);
        if let Some(body) = req.body {
            request = request.body(body);
        }

        // Spawn the streaming task
        tauri::async_runtime::spawn(async move {
            // Keep the registry entry alive for the full relay lifetime.
            // Previously this guard was dropped when proxy_stream returned,
            // so abort_tool_calls could not find or cancel spawned relays.
            let _cancel_guard = cancel_guard;

            let response_result = tokio::select! {
                _ = cancel_token.cancelled() => {
                    let _ = on_event.send(StreamPayload {
                        chunk: None, done: true, status: None,
                        error: Some("aborted".into()),
                    });
                    return;
                }
                result = tokio::time::timeout(
                    Duration::from_millis(response_timeout_ms),
                    request.send(),
                ) => match result {
                    Ok(response) => response,
                    Err(_) => {
                        let _ = on_event.send(StreamPayload {
                            chunk: None, done: true, status: None,
                            error: Some(format!(
                                "Upstream response timed out after {}ms",
                                response_timeout_ms,
                            )),
                        });
                        return;
                    }
                },
            };
            let response = match response_result {
                Ok(r) => r,
                Err(e) => {
                    let _ = on_event.send(StreamPayload {
                        chunk: None,
                        done: true,
                        status: None,
                        error: Some(format!("Upstream request failed: {}", e)),
                    });
                    return;
                }
            };

            let status = response.status().as_u16();
            let _ = on_event.send(StreamPayload {
                chunk: None,
                done: false,
                status: Some(status),
                error: None,
            });

            if !response.status().is_success() {
                let body_result = tokio::select! {
                    _ = cancel_token.cancelled() => {
                        let _ = on_event.send(StreamPayload {
                            chunk: None, done: true, status: Some(status),
                            error: Some("aborted".into()),
                        });
                        return;
                    }
                    result = tokio::time::timeout(
                        Duration::from_millis(response_timeout_ms),
                        read_limited_stream_error_body(response),
                    ) => match result {
                        Ok(body) => body,
                        Err(_) => {
                            let _ = on_event.send(StreamPayload {
                                chunk: None, done: true, status: Some(status),
                                error: Some(format!(
                                    "Upstream error body timed out after {}ms",
                                    response_timeout_ms,
                                )),
                            });
                            return;
                        }
                    },
                };
                match body_result {
                    Ok(body) => {
                        let _ = on_event.send(StreamPayload {
                            chunk: Some(body),
                            done: true,
                            status: Some(status),
                            error: None,
                        });
                    }
                    Err(e) => {
                        let _ = on_event.send(StreamPayload {
                            chunk: None,
                            done: true,
                            status: Some(status),
                            error: Some(format!("Failed to read body: {}", e)),
                        });
                    }
                }
                return;
            }

            // Phase 2.3: UTF-8 safe streaming with stateful tail-buffer.
            let mut stream = response.bytes_stream();
            let mut pending: Vec<u8> = Vec::new();

            loop {
                let next = tokio::select! {
                    _ = cancel_token.cancelled() => {
                        let _ = on_event.send(StreamPayload {
                            chunk: None, done: true, status: Some(status),
                            error: Some("aborted".into()),
                        });
                        return;
                    }
                    next = stream.next() => next,
                };
                let Some(chunk_result) = next else { break };

                match chunk_result {
                    Ok(bytes) => {
                        let chunk_bytes: Vec<u8> = if pending.is_empty() {
                            bytes.to_vec()
                        } else {
                            let mut combined = std::mem::take(&mut pending);
                            combined.extend_from_slice(&bytes);
                            combined
                        };

                        let (text, tail) = split_utf8_safe(&chunk_bytes);
                        pending.extend_from_slice(tail);

                        if !text.is_empty() {
                            let _ = on_event.send(StreamPayload {
                                chunk: Some(text.to_string()),
                                done: false,
                                status: Some(status),
                                error: None,
                            });
                        }
                    }
                    Err(e) => {
                        let _ = on_event.send(StreamPayload {
                            chunk: None,
                            done: true,
                            status: Some(status),
                            error: Some(format!("Stream read error: {}", e)),
                        });
                        return;
                    }
                }
            }

            // Emit any remaining pending bytes at stream end.
            if !pending.is_empty() {
                let text = String::from_utf8_lossy(&pending);
                let _ = on_event.send(StreamPayload {
                    chunk: Some(text.to_string()),
                    done: false,
                    status: Some(status),
                    error: None,
                });
            }

            // Terminal event: stream completed normally.
            let _ = on_event.send(StreamPayload {
                chunk: None,
                done: true,
                status: Some(status),
                error: None,
            });
        });

        Ok(id)
    }

    const MAX_STREAM_ERROR_BODY_BYTES: usize = 64 * 1024;
    const STREAM_ERROR_BODY_TRUNCATED: &str = "\n[LC truncated the upstream error body at 64 KiB]";

    fn append_limited_error_body(body: &mut Vec<u8>, chunk: &[u8], limit: usize) -> bool {
        let remaining = limit.saturating_sub(body.len());
        if chunk.len() <= remaining {
            body.extend_from_slice(chunk);
            return false;
        }
        body.extend_from_slice(&chunk[..remaining]);
        true
    }

    fn finish_limited_error_body(body: &[u8], truncated: bool) -> String {
        let mut text = String::from_utf8_lossy(body).into_owned();
        if truncated {
            text.push_str(STREAM_ERROR_BODY_TRUNCATED);
        }
        text
    }

    async fn read_limited_stream_error_body(
        response: reqwest::Response,
    ) -> Result<String, reqwest::Error> {
        let mut stream = response.bytes_stream();
        let mut body = Vec::with_capacity(MAX_STREAM_ERROR_BODY_BYTES);
        let mut truncated = false;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            if append_limited_error_body(&mut body, &chunk, MAX_STREAM_ERROR_BODY_BYTES) {
                truncated = true;
                break;
            }
        }
        Ok(finish_limited_error_body(&body, truncated))
    }

    #[cfg(test)]
    mod stream_error_body_tests {
        use super::{
            append_limited_error_body, finish_limited_error_body, validate_proxy_body_len,
            validate_user_selected_write_len, MAX_PROXY_BODY_BYTES, MAX_STREAM_ERROR_BODY_BYTES,
            MAX_USER_SELECTED_WRITE_BYTES, STREAM_ERROR_BODY_TRUNCATED,
        };

        #[test]
        fn accumulated_error_body_stops_at_the_native_byte_cap() {
            let mut body = Vec::new();
            assert!(!append_limited_error_body(
                &mut body,
                &vec![b'a'; MAX_STREAM_ERROR_BODY_BYTES - 8],
                MAX_STREAM_ERROR_BODY_BYTES,
            ));
            assert!(append_limited_error_body(
                &mut body,
                &[b'b'; 16],
                MAX_STREAM_ERROR_BODY_BYTES,
            ));
            assert_eq!(body.len(), MAX_STREAM_ERROR_BODY_BYTES);
            assert_eq!(&body[MAX_STREAM_ERROR_BODY_BYTES - 8..], &[b'b'; 8]);
            assert!(finish_limited_error_body(&body, true).ends_with(STREAM_ERROR_BODY_TRUNCATED));
        }

        #[test]
        fn native_proxy_and_export_writes_enforce_exact_byte_boundaries() {
            assert!(validate_proxy_body_len(MAX_PROXY_BODY_BYTES).is_ok());
            assert!(validate_proxy_body_len(MAX_PROXY_BODY_BYTES + 1).is_err());
            assert!(validate_user_selected_write_len(MAX_USER_SELECTED_WRITE_BYTES).is_ok());
            assert!(validate_user_selected_write_len(MAX_USER_SELECTED_WRITE_BYTES + 1).is_err());
        }
    }

    /// Phase 2.3: Split a byte slice at the last valid UTF-8 character
    /// boundary. Returns (valid_prefix, incomplete_tail).
    fn split_utf8_safe(data: &[u8]) -> (&str, &[u8]) {
        let len = data.len();
        let mut boundary = len;
        for i in 0..4.min(len) {
            let pos = len - i;
            if std::str::from_utf8(&data[..pos]).is_ok() {
                boundary = pos;
                break;
            }
        }
        let valid = std::str::from_utf8(&data[..boundary]).unwrap_or("");
        (valid, &data[boundary..])
    }

    /// Set the webview's zoom factor. This uses the OS-level
    /// zoom (WebView2 on Windows, WebKit on macOS) rather than a
    /// CSS `zoom` or `transform: scale()` — so the entire webview
    /// scales as a single GPU surface, just like pressing Ctrl++
    /// in a browser. This avoids all the layout/clipping issues
    /// that come with CSS-based zoom.
    ///
    /// `zoom` of 1.0 is the default. 0.8 zooms out, 1.25 zooms in.
    /// Values outside the 0.25..=5.0 range may be rejected by the
    /// underlying webview.
    #[tauri::command]
    pub fn set_webview_zoom<R: Runtime>(
        webview: tauri::Webview<R>,
        zoom: f64,
    ) -> Result<(), String> {
        webview
            .set_zoom(zoom)
            .map_err(|e| format!("Failed to set webview zoom: {e}"))
    }

    /// Write a UTF-8 text string to an absolute file path. Used by the
    /// web side after the user picks a save location via the dialog
    /// plugin. The path is the full OS path the user selected, not a
    /// directory inside the app sandbox.
    #[tauri::command]
    pub fn write_text_file(path: String, contents: String) -> Result<(), String> {
        validate_user_selected_write_len(contents.len())?;
        fs::write(&path, contents).map_err(|e| format!("Write failed: {e}"))
    }

    /// Return the current user's home directory as an absolute path.
    /// On Windows reads `USERPROFILE`, on Unix reads `HOME`.
    /// Used by the JS side to inject environment context into the
    /// system prompt so the model knows where it's operating.
    #[tauri::command]
    pub fn get_home_dir() -> Result<String, String> {
        std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .map_err(|_| "Could not determine home directory".to_string())
    }

    /// Reveal a file or directory in the OS file manager
    /// (Explorer on Windows, Finder on macOS, etc.).
    /// On Windows uses `explorer /select,<path>`.
    /// On macOS uses `open -R <path>`.
    /// On Linux uses `xdg-open <parent>`.
    #[tauri::command]
    pub fn reveal_in_explorer(path: String) -> Result<(), String> {
        // Normalize to backslashes on Windows — the JS side may
        // build paths with forward slashes (e.g. "C:\\dev/file.md").
        #[cfg(target_os = "windows")]
        let path = path.replace('/', "\\");

        let p = std::path::Path::new(&path);
        #[cfg(target_os = "windows")]
        {
            // /select,<path> must be a single argument (no space after comma).
            std::process::Command::new("explorer")
                .arg(format!("/select,{}", p.display()))
                .spawn()
                .map_err(|e| format!("Failed to open Explorer: {e}"))?;
        }
        #[cfg(target_os = "macos")]
        {
            std::process::Command::new("open")
                .arg("-R")
                .arg(p)
                .spawn()
                .map_err(|e| format!("Failed to reveal in Finder: {e}"))?;
        }
        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        {
            // Linux / other: open the parent directory.
            let dir = p.parent().unwrap_or(p);
            std::process::Command::new("xdg-open")
                .arg(dir)
                .spawn()
                .map_err(|e| format!("Failed to open file manager: {e}"))?;
        }
        Ok(())
    }

    /// Open LC's Tauri/WebView application-data directory without exposing
    /// its private absolute path to the renderer. This is a manual backup and
    /// inspection aid; it does not read, create, migrate, or delete user data.
    #[tauri::command]
    pub fn open_app_data_directory<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
        let directory = app
            .path()
            .app_local_data_dir()
            .map_err(|e| format!("Could not resolve application data directory: {e}"))?;
        if !directory.is_dir() {
            return Err("Application data directory is unavailable".to_string());
        }
        use tauri_plugin_opener::OpenerExt;
        app.opener()
            .open_path(directory.to_string_lossy().as_ref(), None::<&str>)
            .map_err(|e| format!("Could not open application data directory: {e}"))
    }

    /// Open a local file path in the system's default web browser.
    /// For the Spine Theme Builder, the packaged Tauri resource is tried
    /// first. If a standalone EXE was copied without its `resources/`
    /// directory, the embedded page is materialized under the app cache.
    /// The opener plugin is preferred, with an OS-shell fallback.
    #[tauri::command]
    pub fn open_in_browser<R: Runtime>(
        app: tauri::AppHandle<R>,
        path: String,
    ) -> Result<(), String> {
        // Resolve from the packaged resource directory in release builds.
        // Source-tree fallbacks are debug-only so a production binary can
        // never open a file from the developer's checkout.
        let res_dir = app
            .path()
            .resource_dir()
            .map_err(|e| format!("Failed to resolve resource dir: {e}"))?;
        #[allow(unused_mut)]
        let mut candidates = vec![res_dir.join(&path), res_dir.join("resources").join(&path)];

        #[cfg(debug_assertions)]
        {
            let p = std::path::Path::new(&path);
            let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
            let workspace_root = manifest_dir.parent();

            candidates.insert(0, p.to_path_buf());
            candidates.extend([
                manifest_dir.join(&path),
                manifest_dir.join("resources").join(&path),
            ]);
            if let Some(root) = workspace_root {
                candidates.extend([
                    root.join(&path),
                    root.join("theme").join(&path),
                    root.join("public").join(&path),
                ]);
            }
        }

        let resolved =
            if let Some(resolved) = candidates.into_iter().find(|candidate| candidate.is_file()) {
                resolved
            } else {
                // A raw production EXE may be copied without its adjacent
                // resource directory. Materialize the embedded page into
                // the app cache so the system browser can still open it.
                let cache_dir = app
                    .path()
                    .app_cache_dir()
                    .map_err(|e| format!("Failed to resolve app cache directory: {e}"))?;
                fs::create_dir_all(&cache_dir)
                    .map_err(|e| format!("Failed to create app cache directory: {e}"))?;
                let cached_path = cache_dir.join("spine-builder.html");
                fs::write(&cached_path, EMBEDDED_SPINE_BUILDER)
                    .map_err(|e| format!("Failed to materialize Spine Theme Builder: {e}"))?;
                cached_path
            };

        use tauri_plugin_opener::OpenerExt;
        let resolved_string = resolved.to_string_lossy().into_owned();
        match app.opener().open_path(&resolved_string, None::<&str>) {
            Ok(()) => Ok(()),
            Err(opener_error) => {
                // Keep a Windows fallback for packaged builds where the
                // opener plugin may be unavailable or blocked by the host
                // shell policy. Pass the absolute path directly; `start`
                // then uses the user's registered HTML browser.
                #[cfg(target_os = "windows")]
                {
                    std::process::Command::new("cmd")
                        .args(["/c", "start", "", &resolved_string])
                        .spawn()
                        .map(|_| ())
                        .map_err(|fallback_error| {
                            format!(
                                "Failed to open browser via opener ({opener_error}) or Windows shell ({fallback_error})"
                            )
                        })
                }
                #[cfg(target_os = "macos")]
                {
                    std::process::Command::new("open")
                        .arg(&resolved_string)
                        .spawn()
                        .map(|_| ())
                        .map_err(|fallback_error| {
                            format!(
                                "Failed to open browser via opener ({opener_error}) or macOS shell ({fallback_error})"
                            )
                        })
                }
                #[cfg(not(any(target_os = "windows", target_os = "macos")))]
                {
                    std::process::Command::new("xdg-open")
                        .arg(&resolved_string)
                        .spawn()
                        .map(|_| ())
                        .map_err(|fallback_error| {
                            format!(
                                "Failed to open browser via opener ({opener_error}) or system shell ({fallback_error})"
                            )
                        })
                }
            }
        }
    }

    /// Detect the OS-level color scheme.  Uses the `dark-light` crate
    /// which checks platform-specific sources (portal on Linux, registry
    /// on Windows, `AppleInterfaceStyle` on macOS).  More reliable than
    /// the CSS `prefers-color-scheme` media query in Tauri's webview,
    /// especially on Linux where webkit2gtk may not pick up the desktop
    /// theme correctly.
    #[tauri::command]
    pub fn detect_system_theme() -> &'static str {
        match dark_light::detect() {
            dark_light::Mode::Dark => "dark",
            dark_light::Mode::Light => "light",
            // Default (Unspecified) — fall back to light.
            _ => "light",
        }
    }

    /// Wipe the saved window state and snap the current window
    /// back to the conf-default geometry. Called by the web
    /// side's reset paths (`clearAndResetWindowState` in
    /// `utils/windowState.ts`, driven by the full wipe in
    /// `utils/import.ts`).
    ///
    /// Why not just delete the file? The plugin's `RunEvent::Exit`
    /// handler writes the in-memory cache back to disk, and
    /// the in-memory cache has the current geometry — so a
    /// plain delete gets undone before the next launch reads.
    /// Overwriting with `null` short-circuits that (the
    /// plugin's loader rejects it and returns an empty cache),
    /// but on a `window.location.reload()` the OS still has
    /// the current geometry because the conf defaults are
    /// only applied at *window creation*, not on every load.
    /// So we also explicitly reposition/resize the window to
    /// the conf defaults right now. That makes the visible
    /// reset happen on this process, not just the next one.
    #[tauri::command]
    pub fn reset_window_state<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
        // 1. Move the window to conf-default geometry RIGHT NOW.
        // The conf values from tauri.conf.json are read into
        // the App's config at build time; we re-encode the
        // relevant ones here. If these drift from
        // tauri.conf.json, update both places.
        if let Some(w) = app.get_webview_window("main") {
            // Center on the primary monitor. Tauri's
            // `set_position(LogicalPosition::new(x, y))`
            // honors monitor scale_factor automatically.
            if let Ok(Some(monitor)) = w.primary_monitor() {
                let sf = monitor.scale_factor();
                let mw = monitor.size().width as f64 / sf;
                let mh = monitor.size().height as f64 / sf;
                let cx = ((mw - 1280.0) / 2.0).max(0.0) as i32;
                let cy = ((mh - 800.0) / 2.0).max(0.0) as i32;
                let _ = w.set_position(LogicalPosition::new(cx, cy));
            } else {
                // Fallback: top-left of the primary work area,
                // which is close enough to the conf default.
                let _ = w.set_position(LogicalPosition::new(0, 0));
            }
            let _ = w.set_size(LogicalSize::new(1280, 800));
        }

        // 2. Overwrite the plugin's state file with `null` so
        // the next launch's loader rejects it, falling back
        // to an empty cache (no restore, conf defaults used
        // — but those are reapplied by the conf already, so
        // this is mostly belt-and-suspenders).
        let dir = app
            .path()
            .app_config_dir()
            .map_err(|e| format!("Could not resolve app config dir: {e}"))?;
        let _ = fs::create_dir_all(&dir);
        let path = dir.join(".window-state.json");
        fs::write(&path, b"null").map_err(|e| format!("Reset window state failed: {e}"))?;
        Ok(())
    }

    /// Write raw bytes to an absolute file path. Used for binary
    /// exports (e.g. the .zip conversation archive). `bytes` is a
    /// JSON-serialized `Vec<u8>` because Tauri commands take
    /// JSON-serializable args; we keep it as a plain array (no
    /// base64) so the data round-trips losslessly.
    #[tauri::command]
    pub fn write_blob_file(path: String, bytes: Vec<u8>) -> Result<(), String> {
        validate_user_selected_write_len(bytes.len())?;
        fs::write(&path, &bytes).map_err(|e| format!("Write failed: {e}"))
    }

    fn validate_user_selected_write_len(bytes: usize) -> Result<(), String> {
        if bytes > MAX_USER_SELECTED_WRITE_BYTES {
            return Err(format!(
                "Write is {} bytes. The native limit is {} bytes.",
                bytes, MAX_USER_SELECTED_WRITE_BYTES
            ));
        }
        Ok(())
    }

    /// Read a file's bytes by absolute path. Used by the JS side when
    /// the user drops a file from File Explorer onto the window —
    /// Tauri gives us the path, we give the JS side the bytes. The
    /// returned `mime` is best-effort: extension-driven, since we
    /// don't have a content sniff. Returns an error if the path is
    /// empty or the file is unreadable.
    #[tauri::command]
    pub fn read_dropped_file(path: String) -> Result<DroppedFile, String> {
        if path.is_empty() {
            return Err("Empty path".to_string());
        }
        let metadata = fs::metadata(&path).map_err(|e| format!("Read failed: {e}"))?;
        if !metadata.is_file() {
            return Err("Read failed: path is not a regular file".into());
        }
        if metadata.len() > MAX_DROPPED_FILE_BYTES {
            return Err(format!(
                "Read failed: file is {} bytes. The attachment limit is {} bytes.",
                metadata.len(),
                MAX_DROPPED_FILE_BYTES
            ));
        }
        let file = fs::File::open(&path).map_err(|e| format!("Read failed: {e}"))?;
        let mut bytes = Vec::with_capacity(metadata.len() as usize);
        file.take(MAX_DROPPED_FILE_BYTES.saturating_add(1))
            .read_to_end(&mut bytes)
            .map_err(|e| format!("Read failed: {e}"))?;
        if bytes.len() as u64 > MAX_DROPPED_FILE_BYTES {
            return Err(format!(
                "Read failed: file grew beyond the {MAX_DROPPED_FILE_BYTES}-byte attachment limit."
            ));
        }
        let size = bytes.len();
        let name = std::path::Path::new(&path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("file")
            .to_string();
        let mime = guess_mime_from_name(&name);
        Ok(DroppedFile {
            path,
            name,
            mime,
            size,
            bytes,
        })
    }

    const MAX_BOUNDED_FILE_READ_BYTES: u64 = 128 * 1024;
    const BOUNDED_FILE_EMPTY_PATH: &str = "bounded_file_empty_path";
    const BOUNDED_FILE_INVALID_LIMIT: &str = "bounded_file_invalid_limit";
    const BOUNDED_FILE_NOT_FILE: &str = "bounded_file_not_file";
    const BOUNDED_FILE_TOO_LARGE: &str = "bounded_file_too_large";
    const BOUNDED_FILE_READ_FAILED: &str = "bounded_file_read_failed";
    const BOUNDED_FILE_SIZE_UNSUPPORTED: &str = "bounded_file_size_unsupported";

    fn read_bounded_file_after_metadata<F>(
        path: String,
        max_bytes: u64,
        after_metadata: F,
    ) -> Result<DroppedFile, String>
    where
        F: FnOnce(),
    {
        if path.is_empty() {
            return Err(BOUNDED_FILE_EMPTY_PATH.to_string());
        }
        if max_bytes == 0 || max_bytes > MAX_BOUNDED_FILE_READ_BYTES {
            return Err(BOUNDED_FILE_INVALID_LIMIT.to_string());
        }

        let metadata = fs::metadata(&path).map_err(|_| BOUNDED_FILE_READ_FAILED.to_string())?;
        if !metadata.is_file() {
            return Err(BOUNDED_FILE_NOT_FILE.to_string());
        }
        if metadata.len() > max_bytes {
            return Err(BOUNDED_FILE_TOO_LARGE.to_string());
        }
        after_metadata();

        let capacity = usize::try_from(metadata.len())
            .map_err(|_| BOUNDED_FILE_SIZE_UNSUPPORTED.to_string())?;
        let file = fs::File::open(&path).map_err(|_| BOUNDED_FILE_READ_FAILED.to_string())?;
        let mut bytes = Vec::with_capacity(capacity);
        file.take(max_bytes + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| BOUNDED_FILE_READ_FAILED.to_string())?;
        if bytes.len() as u64 > max_bytes {
            return Err(BOUNDED_FILE_TOO_LARGE.to_string());
        }

        let size = bytes.len();
        let name = std::path::Path::new(&path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("file")
            .to_string();
        let mime = guess_mime_from_name(&name);
        Ok(DroppedFile {
            path,
            name,
            mime,
            size,
            bytes,
        })
    }

    /// Read a regular file only when it fits within the caller's bounded limit.
    /// Metadata is checked before opening or allocating for the file, and the
    /// limited reader protects against the file growing after that check.
    #[tauri::command]
    pub fn read_bounded_file(path: String, max_bytes: u64) -> Result<DroppedFile, String> {
        read_bounded_file_after_metadata(path, max_bytes, || {})
    }

    #[cfg(test)]
    mod bounded_file_read_tests {
        use super::{
            read_bounded_file, read_bounded_file_after_metadata, read_dropped_file,
            BOUNDED_FILE_EMPTY_PATH, BOUNDED_FILE_INVALID_LIMIT, BOUNDED_FILE_NOT_FILE,
            BOUNDED_FILE_TOO_LARGE, MAX_BOUNDED_FILE_READ_BYTES, MAX_DROPPED_FILE_BYTES,
        };

        fn temporary_file_path(label: &str) -> std::path::PathBuf {
            std::env::temp_dir().join(format!(
                "lc-bounded-read-{label}-{}-{:016x}.zip",
                std::process::id(),
                rand::random::<u64>()
            ))
        }
        #[test]
        fn accepts_a_file_at_the_requested_limit() {
            let path = temporary_file_path("exact");
            let expected = b"test";
            std::fs::write(&path, expected).unwrap();

            let result = read_bounded_file(path.to_string_lossy().into_owned(), 4);
            let _ = std::fs::remove_file(&path);

            let picked = result.unwrap();
            assert_eq!(picked.name, path.file_name().unwrap().to_string_lossy());
            assert_eq!(picked.mime, "application/octet-stream");
            assert_eq!(picked.size, expected.len());
            assert_eq!(picked.bytes, expected);
        }
        #[test]
        fn rejects_an_oversized_file_before_reading_it() {
            let path = temporary_file_path("oversized");
            std::fs::write(&path, b"12345").unwrap();

            let result = read_bounded_file(path.to_string_lossy().into_owned(), 4);
            let _ = std::fs::remove_file(&path);

            assert_eq!(result.unwrap_err(), BOUNDED_FILE_TOO_LARGE);
        }


        #[test]
        fn dropped_file_reader_rejects_oversized_files_before_allocation() {
            let path = temporary_file_path("oversized-drop");
            let file = std::fs::File::create(&path).unwrap();
            file.set_len(MAX_DROPPED_FILE_BYTES + 1).unwrap();

            let result = read_dropped_file(path.to_string_lossy().into_owned());
            let _ = std::fs::remove_file(&path);

            assert!(result.unwrap_err().contains("attachment limit"));
        }

        #[test]
        fn rejects_a_file_that_grows_after_the_metadata_check() {
            let path = temporary_file_path("growing");
            std::fs::write(&path, b"1234").unwrap();
            let grow_path = path.clone();

            let result =
                read_bounded_file_after_metadata(path.to_string_lossy().into_owned(), 4, || {
                    std::fs::write(&grow_path, b"12345").unwrap()
                });
            let _ = std::fs::remove_file(&path);

            assert_eq!(result.unwrap_err(), BOUNDED_FILE_TOO_LARGE);
        }

        #[test]
        fn rejects_limits_outside_the_native_ceiling() {
            assert_eq!(
                read_bounded_file("unused".to_string(), 0).unwrap_err(),
                BOUNDED_FILE_INVALID_LIMIT
            );
            assert_eq!(
                read_bounded_file("unused".to_string(), MAX_BOUNDED_FILE_READ_BYTES + 1)
                    .unwrap_err(),
                BOUNDED_FILE_INVALID_LIMIT
            );
        }

        #[test]
        fn rejects_empty_paths_and_directories_with_valid_limits() {
            assert_eq!(
                read_bounded_file(String::new(), 4).unwrap_err(),
                BOUNDED_FILE_EMPTY_PATH
            );

            let path = temporary_file_path("directory");
            std::fs::create_dir(&path).unwrap();
            let result = read_bounded_file(path.to_string_lossy().into_owned(), 4);
            std::fs::remove_dir(&path).unwrap();
            assert_eq!(result.unwrap_err(), BOUNDED_FILE_NOT_FILE);
        }
    }

    /// Best-effort MIME from filename extension. Matches the same
    /// list we accept in the web composer so a dropped `.py` is
    /// recognized as `text/x-python`, etc. The JS side falls back to
    /// its own detector if this returns `application/octet-stream`.
    fn guess_mime_from_name(name: &str) -> String {
        let lower = name.to_lowercase();
        // Extensionless text files (LICENSE, NOTICE, Makefile, …) have no
        // extension for the match below to key off — `rsplit('.')` on a
        // dotless name yields the whole name, which falls through to
        // octet-stream. Answer them by name first, mirroring
        // `isKnownExtensionlessTextName` in `src/utils/attachments.ts`;
        // without this a dropped LICENSE arrives tagged as a binary and
        // the composer rejects it.
        if is_extensionless_text_name(&lower) {
            return "text/plain".to_string();
        }
        let ext = lower.rsplit('.').next().unwrap_or("");
        let mime = match ext {
            // images
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "gif" => "image/gif",
            "webp" => "image/webp",
            "bmp" => "image/bmp",
            // text / source
            "txt" | "md" | "markdown" => "text/plain",
            "json" => "application/json",
            "xml" => "application/xml",
            "html" | "htm" => "text/html",
            "css" | "scss" | "sass" | "less" => "text/css",
            "js" | "mjs" | "cjs" | "jsx" => "text/javascript",
            "ts" | "tsx" => "text/typescript",
            "py" | "pyi" => "text/x-python",
            "rb" => "text/x-ruby",
            "rs" => "text/x-rust",
            "go" => "text/x-go",
            "java" | "kt" | "kts" => "text/x-java",
            "swift" => "text/x-swift",
            "c" | "h" | "cc" | "cpp" | "cxx" | "hpp" | "cs" => "text/x-csrc",
            "php" => "text/x-php",
            "sh" | "bash" | "zsh" => "text/x-shellscript",
            "sql" => "application/sql",
            "yaml" | "yml" => "application/yaml",
            "toml" => "application/toml",
            "lua" => "text/x-lua",
            "vim" => "text/x-vim",
            "tex" => "text/x-tex",
            "proto" => "text/x-protobuf",
            "ps1" => "text/x-powershell",
            "bat" | "cmd" => "text/x-bat",
            "dart" => "text/x-dart",
            "env" | "ini" | "cfg" | "conf" => "text/plain",
            _ => "application/octet-stream",
        };
        mime.to_string()
    }

    /// Extensions that are never text. Mirrors `BINARY_EXT` in
    /// `src/utils/attachments.ts`.
    ///
    /// This veto is load-bearing on THIS side of the wire, not just for
    /// tidiness: the composer's first acceptance gate is
    /// `/^text\//.test(file.type)`, and `file.type` on a dropped file is
    /// whatever this function returns. Reporting `text/plain` for
    /// `LICENSE.exe` would let it in through that gate before the
    /// name-based rules in `attachments.ts` ever ran.
    const BINARY_EXT: &[&str] = &[
        // executables, libraries, installers
        "exe", "dll", "so", "dylib", "msi", "msix", "app", "appimage", "deb", "rpm", "apk", "aab",
        "dmg", "pkg", "bin", "o", "obj", "a", "lib", "pdb", "wasm", "node", "jar", "war", "ear",
        "class", "nupkg", // archives
        "zip", "gz", "tar", "tgz", "bz2", "xz", "7z", "rar", "zst", "lz", "lzma", "cab", "iso",
        "img", // audio / video
        "mp3", "mp4", "m4a", "m4v", "mkv", "avi", "mov", "wmv", "flv", "webm", "wav", "flac",
        "ogg", "oga", "ogv", "aac", "opus", "mpg", "mpeg",
        // images that are not accepted as attachments
        "psd", "ai", "eps", "tif", "tiff", "ico", "icns", "heic", "heif", "avif", "raw", "cr2",
        "nef", "arw", "svgz", // office / portable documents
        "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "rtf",
        // fonts
        "ttf", "otf", "ttc", "woff", "woff2", "eot", // databases / opaque data
        "db", "sqlite", "sqlite3", "mdb", "accdb", "dat", "pack", "idx", "bak", "dmp",
    ];

    /// The dot-suffix of a basename, or `""` when there is none. A leading
    /// dot is part of the name (`.gitignore`), so only a dot at index > 0
    /// counts. `name` must already be lowercased.
    fn dot_suffix(name: &str) -> &str {
        match name.rfind('.') {
            Some(i) if i > 0 => &name[i + 1..],
            _ => "",
        }
    }

    /// Conventional text files that carry no extension. Kept in step with
    /// `EXTENSIONLESS_TEXT_NAMES` + `LICENSE_FAMILY` in
    /// `src/utils/attachments.ts` — that list is the one the composer
    /// validates against, this one decides the MIME we report for a
    /// dropped file. `name` must already be lowercased.
    fn is_extensionless_text_name(name: &str) -> bool {
        // A binary extension wins over every name below.
        if BINARY_EXT.contains(&dot_suffix(name)) {
            return false;
        }
        const NAMES: &[&str] = &[
            "authors",
            "changelog",
            "changes",
            "codeowners",
            "contributing",
            "contributors",
            "copying",
            "copyright",
            "history",
            "install",
            "license",
            "licence",
            "maintainers",
            "manifest",
            "news",
            "notice",
            "readme",
            "security",
            "todo",
            "version",
            "brewfile",
            "containerfile",
            "dockerfile",
            "gemfile",
            "gnumakefile",
            "jenkinsfile",
            "justfile",
            "makefile",
            "procfile",
            "rakefile",
            "vagrantfile",
            ".babelrc",
            ".dockerignore",
            ".editorconfig",
            ".eslintrc",
            ".gitattributes",
            ".gitignore",
            ".gitmodules",
            ".npmignore",
            ".npmrc",
            ".nvmrc",
            ".prettierrc",
        ];
        if NAMES.contains(&name) {
            return true;
        }
        // The license family with a variant qualifier: LICENSE-MIT,
        // COPYING.LESSER, NOTICE-third-party.
        ["license", "licence", "notice", "copying", "copyright"]
            .iter()
            .any(|stem| {
                name.strip_prefix(stem)
                    .and_then(|rest| rest.chars().next())
                    .is_some_and(|c| c == '-' || c == '.' || c == '_')
            })
    }

    #[derive(Debug, Serialize)]
    pub struct DroppedFile {
        pub path: String,
        pub name: String,
        pub mime: String,
        pub size: usize,
        pub bytes: Vec<u8>,
    }

    // ── Keychain (AES-256-GCM encrypted API key storage) ──────────
    // Stores keys as encrypted files under the OS config directory.
    //
    // Initial format: base64(0x01 || salt[16] || nonce[12] || ciphertext)
    //   Key = PBKDF2-HMAC-SHA256(…, session salt, configurable iters)

    const PBKDF2_ITERATIONS: u32 = 96_000;
    const SALT_LEN: usize = 16;
    const KEY_FORMAT_VERSION: u8 = 0x01;
    const MAX_KEY_VALUE_BYTES: usize = 64 * 1024;
    const MAX_KEY_FILE_BYTES: u64 = 128 * 1024;

    /// Session-level salt + derived key cache. PBKDF2 runs ONCE per
    /// process lifetime, not per file. All keys share the same salt
    /// (nonce-per-message AES-GCM ensures ciphertext uniqueness).
    static SESSION_KEY: std::sync::OnceLock<([u8; 32], [u8; SALT_LEN])> =
        std::sync::OnceLock::new();

    fn session_salt_and_key() -> ([u8; 32], &'static [u8; SALT_LEN]) {
        let (key, salt) = SESSION_KEY.get_or_init(|| {
            let mut salt = [0u8; SALT_LEN];
            rng().fill(&mut salt);
            let mut key = [0u8; 32];
            pbkdf2::pbkdf2_hmac::<Sha256>(
                key_material().as_bytes(),
                &salt,
                PBKDF2_ITERATIONS,
                &mut key,
            );
            (key, salt)
        });
        (*key, salt)
    }

    fn key_material() -> String {
        let host = hostname::get()
            .map(|h| h.to_string_lossy().into_owned())
            .unwrap_or_default();
        let user = std::env::var("USERNAME")
            .or_else(|_| std::env::var("USER"))
            .unwrap_or_default();
        format!("lc::{}::{}", host, user)
    }

    /// PBKDF2-HMAC-SHA256 for the initial key format.
    fn derive_key(salt: &[u8]) -> [u8; 32] {
        let mut key = [0u8; 32];
        pbkdf2::pbkdf2_hmac::<Sha256>(key_material().as_bytes(), salt, PBKDF2_ITERATIONS, &mut key);
        key
    }

    fn keys_dir() -> std::path::PathBuf {
        dirs::config_dir()
            .unwrap_or_else(|| std::path::PathBuf::from("."))
            .join("lc")
            .join("keys")
    }

    fn validate_key_ref(key: &str) -> Result<(), String> {
        if matches!(key, "brave-search-key" | "marginalia-search-key") {
            return Ok(());
        }
        let Some(profile_id) = key.strip_prefix("profile.") else {
            return Err("invalid keychain reference".into());
        };
        let mut characters = profile_id.chars();
        let valid_first = characters
            .next()
            .is_some_and(|character| character.is_ascii_lowercase() || character.is_ascii_digit());
        let valid_rest = characters.all(|character| {
            character.is_ascii_lowercase()
                || character.is_ascii_digit()
                || matches!(character, '.' | '_' | '-')
        });
        if profile_id.len() > 128 || !valid_first || !valid_rest {
            return Err("invalid keychain reference".into());
        }
        Ok(())
    }

    fn key_file_path(key: &str) -> std::path::PathBuf {
        let safe: String = key
            .chars()
            .map(|c| {
                if c.is_alphanumeric() || c == '.' || c == '-' || c == '_' {
                    c
                } else {
                    '_'
                }
            })
            .collect();
        keys_dir().join(safe)
    }

    fn write_key_file(path: &std::path::Path, encrypted: &str) -> Result<(), String> {
        let mut transaction = FileTransaction::new(path).map_err(|e| format!("stage: {}", e))?;
        transaction
            .write_str(encrypted)
            .map_err(|e| format!("write: {}", e))?;
        transaction.commit().map_err(|e| format!("commit: {}", e))
    }

    #[cfg(test)]
    mod keychain_storage_tests {
        use super::{key_file_path, validate_key_ref, write_key_file};
        use std::collections::HashSet;

        #[test]
        fn key_file_replacement_commits_without_leaving_staging_files() {
            let root = std::env::temp_dir().join(format!(
                "lc-keychain-storage-{}-{:016x}",
                std::process::id(),
                rand::random::<u64>()
            ));
            let path = root.join("profile.test");
            std::fs::create_dir_all(&root).unwrap();

            write_key_file(&path, "first").unwrap();
            write_key_file(&path, "second").unwrap();

            assert_eq!(std::fs::read_to_string(&path).unwrap(), "second");
            let entries: Vec<_> = std::fs::read_dir(&root)
                .unwrap()
                .map(|entry| entry.unwrap().path())
                .collect();
            assert_eq!(entries, vec![path]);
            std::fs::remove_dir_all(root).unwrap();
        }

        #[test]
        fn keychain_references_are_collision_free_application_names() {
            let valid = [
                "brave-search-key",
                "marginalia-search-key",
                "profile.01234567-89ab-cdef",
                "profile.a_b",
                "profile.a.b",
            ];
            for reference in valid {
                assert!(validate_key_ref(reference).is_ok());
                assert_eq!(
                    key_file_path(reference).file_name().unwrap(),
                    std::ffi::OsStr::new(reference)
                );
            }
            let paths: HashSet<_> = valid.into_iter().map(key_file_path).collect();
            assert_eq!(paths.len(), valid.len());

            assert!(validate_key_ref("profile.profile/a").is_err());
            assert!(validate_key_ref("profile.UPPER").is_err());
            assert!(validate_key_ref("unowned-key").is_err());
            assert!(validate_key_ref(&format!("profile.{}", "a".repeat(128))).is_ok());
            assert!(validate_key_ref(&format!("profile.{}", "a".repeat(129))).is_err());
        }
    }

    /// Encrypt plaintext with the current AES-256-GCM format.
    /// Uses a session-level PBKDF2 key — derived once, reused for all files.
    /// Returns base64(0x01 || session_salt[16] || nonce[12] || ciphertext).
    fn encrypt(plaintext: &[u8]) -> Result<String, String> {
        let (key, salt) = session_salt_and_key();
        let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| format!("cipher init: {}", e))?;
        let mut nonce_bytes = [0u8; 12];
        rng().fill(&mut nonce_bytes);
        let nonce = Nonce::from(nonce_bytes);
        let ciphertext = cipher
            .encrypt(&nonce, plaintext)
            .map_err(|e| format!("encrypt: {}", e))?;
        let mut combined = Vec::with_capacity(1 + SALT_LEN + 12 + ciphertext.len());
        combined.push(KEY_FORMAT_VERSION);
        combined.extend_from_slice(salt);
        combined.extend_from_slice(&nonce_bytes);
        combined.extend_from_slice(&ciphertext);
        Ok(base64::engine::general_purpose::STANDARD.encode(&combined))
    }

    /// Decrypt a current-format base64(version_byte || ... ) value.
    fn decrypt(data: &[u8]) -> Result<String, String> {
        let encoded = std::str::from_utf8(data).map_err(|e| format!("utf8: {}", e))?;
        let combined = base64::engine::general_purpose::STANDARD
            .decode(encoded.trim())
            .map_err(|e| format!("base64: {}", e))?;
        if combined.is_empty() {
            return Err("empty ciphertext".into());
        }

        if combined[0] != KEY_FORMAT_VERSION {
            return Err("unsupported key format version".into());
        }
        if combined.len() < 1 + SALT_LEN + 12 {
            return Err("ciphertext too short".into());
        }
        let salt = &combined[1..1 + SALT_LEN];
        let nonce_bytes = &combined[1 + SALT_LEN..1 + SALT_LEN + 12];
        let ciphertext = &combined[1 + SALT_LEN + 12..];
        let (cached_key, session_salt) = session_salt_and_key();
        let key: [u8; 32] = if salt == session_salt.as_slice() {
            cached_key
        } else {
            derive_key(salt)
        };
        let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| format!("cipher init: {}", e))?;
        let nonce = Nonce::try_from(nonce_bytes).unwrap();
        let plaintext = cipher
            .decrypt(&nonce, ciphertext)
            .map_err(|e| format!("decrypt: {}", e))?;
        String::from_utf8(plaintext).map_err(|e| format!("utf8: {}", e))
    }

    /// Pre-warm the session key so the first keychain_get / keychain_set
    /// doesn't block on PBKDF2. Call this in a background task at startup.
    #[tauri::command]
    pub async fn keychain_warm() -> Result<(), String> {
        tokio::task::spawn_blocking(|| {
            session_salt_and_key();
        })
        .await
        .map_err(|e| format!("warm: {}", e))
    }

    #[tauri::command]
    pub async fn keychain_set(key: String, value: String) -> Result<(), String> {
        validate_key_ref(&key)?;
        if value.len() > MAX_KEY_VALUE_BYTES {
            return Err(format!(
                "keychain value is {} bytes. The native limit is {} bytes.",
                value.len(),
                MAX_KEY_VALUE_BYTES
            ));
        }
        tokio::task::spawn_blocking(move || {
            let dir = keys_dir();
            std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {}", e))?;
            let path = key_file_path(&key);
            let encrypted = encrypt(value.as_bytes())?;
            write_key_file(&path, &encrypted)
        })
        .await
        .map_err(|e| format!("set: {}", e))?
    }

    #[tauri::command]
    pub async fn keychain_get(key: String) -> Result<Option<String>, String> {
        validate_key_ref(&key)?;
        tokio::task::spawn_blocking(move || {
            let path = key_file_path(&key);
            match std::fs::metadata(&path) {
                Ok(metadata) if !metadata.is_file() => Err("read: key path is not a file".into()),
                Ok(metadata) if metadata.len() > MAX_KEY_FILE_BYTES => Err(format!(
                    "read: key file is {} bytes. The native limit is {} bytes.",
                    metadata.len(),
                    MAX_KEY_FILE_BYTES
                )),
                Ok(_) => {
                    let file =
                        std::fs::File::open(&path).map_err(|error| format!("read: {error}"))?;
                    let mut data = Vec::new();
                    file.take(MAX_KEY_FILE_BYTES.saturating_add(1))
                        .read_to_end(&mut data)
                        .map_err(|error| format!("read: {error}"))?;
                    if data.len() as u64 > MAX_KEY_FILE_BYTES {
                        return Err("read: key file grew beyond the native limit".into());
                    }
                    let decrypted = decrypt(&data)?;
                    Ok(Some(decrypted))
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
                Err(e) => Err(format!("read: {}", e)),
            }
        })
        .await
        .map_err(|e| format!("get: {}", e))?
    }

    #[tauri::command]
    pub async fn keychain_delete(key: String) -> Result<(), String> {
        validate_key_ref(&key)?;
        tokio::task::spawn_blocking(move || {
            let path = key_file_path(&key);
            match std::fs::remove_file(&path) {
                Ok(()) => Ok(()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(e) => Err(format!("delete: {}", e)),
            }
        })
        .await
        .map_err(|e| format!("delete: {}", e))?
    }
}

/// Read the plugin's state file path for the given app handle.
/// The plugin stores its file at `<app_config_dir>/.window-state.json`
/// regardless of whether the binary is portable or installed —
/// there's no portable mode in the plugin itself, so the
/// portable case ends up writing to %APPDATA% too (since
/// the OS config dir is the only one the plugin's
/// `app.path().app_config_dir()` knows about). This helper
/// just returns that single canonical path.
fn state_file_path_for_check<R: Runtime>(app: &AppHandle<R>) -> std::path::PathBuf {
    use tauri::Manager as _;
    if let Ok(dir) = app.path().app_config_dir() {
        return dir.join(".window-state.json");
    }
    std::path::PathBuf::from(".window-state.json")
}

/// One-shot Wayland CSD repair for tao 0.35 — see the `on_window_event`
/// hook in `run` for the full story. A no-op outside Wayland sessions.
#[cfg(target_os = "linux")]
fn nudge_wayland_csd_once<R: Runtime>(window: &tauri::Window<R>) {
    use std::sync::atomic::{AtomicBool, Ordering};
    static DONE: AtomicBool = AtomicBool::new(false);
    let on_wayland = std::env::var_os("WAYLAND_DISPLAY").is_some()
        || std::env::var_os("WAYLAND_SOCKET").is_some();
    if !on_wayland || DONE.swap(true, Ordering::Relaxed) {
        return;
    }
    let _ = window.set_resizable(false);
    let _ = window.set_resizable(true);
}

/// tao 0.35 builds its Wayland decoration from a GTK `HeaderBar` but
/// leaves `has-subtitle` at GTK's default `true`. LC has no subtitle, so
/// disable the unused reservation before first show to keep the native
/// titlebar compact without replacing its controls or drag behavior.
/// The downcasts deliberately make this a no-op if tao changes its CSD
/// widget tree; remove and re-evaluate it when upgrading to tao 0.36.
#[cfg(target_os = "linux")]
fn compact_wayland_csd<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    use gtk::prelude::*;

    let on_wayland = std::env::var_os("WAYLAND_DISPLAY").is_some()
        || std::env::var_os("WAYLAND_SOCKET").is_some();
    if !on_wayland {
        return;
    }

    let Ok(gtk_window) = window.gtk_window() else {
        return;
    };
    let Some(titlebar) = gtk_window.titlebar() else {
        return;
    };
    let Ok(event_box) = titlebar.downcast::<gtk::EventBox>() else {
        return;
    };
    let Some(header_widget) = event_box.child() else {
        return;
    };
    let Ok(header) = header_widget.downcast::<gtk::HeaderBar>() else {
        return;
    };

    header.set_has_subtitle(false);
}

pub fn run<R: Runtime>() {
    tauri::Builder::<R>::new()
        // Register this first. A second native process must not read or advance
        // the startup marker while the owning process is still starting.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        // tauri-plugin-opener is the official, cross-platform way to
        // hand a URL off to the OS's default browser. We use it from
        // the link-click handler in the chat bubbles: when the user
        // clicks an <a> in a markdown message we open the Quick
        // Preview overlay in the webview, but they can also choose
        // "Open in browser" from the overlay's toolbar to bounce
        // the URL out to Chrome / Edge / Safari / Firefox. On the
        // web build there's no plugin — the JS side falls back to
        // `window.open(url, '_blank', 'noopener,noreferrer')`.
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                // Skip the plugin's automatic restore on
                // on_window_ready. The setup hook below does
                // it instead, after the window is fully
                // constructed — that ordering eliminates the
                // ~1-frame flash of the conf-default geometry
                // that would otherwise appear between window
                // creation and the plugin's set_position call.
                .skip_initial_state("main")
                .build(),
        )
        .setup(|app| {
            // Restore the window geometry ourselves instead of
            // letting tauri-plugin-window-state do it during
            // on_window_ready. The plugin's default behavior is:
            //   1. Plugin's on_window_ready calls restore_state
            //   2. restore_state sets position/size from disk
            //   3. restore_state calls self.show() (overriding
            //      our `visible: false` from tauri.conf.json)
            //
            // On Windows, the few-millisecond gap between
            // window creation and the plugin's set_position/
            // set_size calls paints a frame of the window at
            // the conf-default size (1280×800) before the
            // saved geometry is applied — a visible flash.
            //
            // Skipping the plugin's auto-restore and calling
            // it ourselves after position+size are already in
            // place eliminates the flash. The plugin still
            // auto-saves on Moved/Resized, so the save path
            // is unaffected.
            //
            // For maximized state, the plugin's restore is
            // double-buggy: it uses `prev_x`/`prev_y` for
            // position (which often fails the monitor
            // intersects check, landing the window at a
            // random spot) AND the saved size gets clamped
            // by the OS. We handle maximized by computing
            // the target monitor's work area ourselves and
            // setting position+size directly — visually
            // equivalent to maximize() (with taskbar
            // accounted for via the work area) and reliable.
            if let Some(window) = app.get_webview_window("main") {
                #[cfg(target_os = "linux")]
                compact_wayland_csd(&window);

                use tauri_plugin_window_state::{StateFlags, WindowExt};
                // `visible: false` in tauri.conf.json keeps
                // the window hidden until we explicitly show
                // it. We must show() AFTER setting size and
                // position so the first paint already has the
                // correct geometry — otherwise the user sees
                // a single frame of the conf-default size.
                // The plugin's `restore_state` does the same
                // thing internally (set_position → set_size
                // → show) but we're skipping its auto-restore
                // via `skip_initial_state("main")`, so we
                // own the whole sequence.
                let state_path = state_file_path_for_check(app.handle());
                let saved = std::fs::read_to_string(&state_path).ok();
                let saved_maximized = saved
                    .as_deref()
                    .map(|s| s.contains("\"maximized\": true") || s.contains("\"maximized\":true"))
                    .unwrap_or(false);
                if saved_maximized {
                    // When the user closes the app while
                    // maximized, the next launch should come
                    // up at the *pre-maximize* geometry — the
                    // position is in `prev_x`/`prev_y` (the
                    // plugin only tracks position, not the
                    // pre-maximize size). The plugin's own
                    // restore path uses these but the
                    // monitor-intersects check often fails
                    // for them, landing the window at a
                    // random spot. We extract them ourselves
                    // and apply directly, with no plugin
                    // involvement. The size is whatever the
                    // last `Resized` event reported — which
                    // is the maximized size. The OS will
                    // clamp it to fit the monitor on
                    // apply, so the user sees a window that
                    // fits the screen at the pre-maximize
                    // position.
                    if let Ok(state_json) = saved.ok_or(()) {
                        let extract_i32 = |key: &str| -> Option<i32> {
                            let needle = format!("\"{}\":", key);
                            if let Some(idx) = state_json.find(&needle) {
                                let rest = &state_json[idx + needle.len()..];
                                let num: String = rest
                                    .chars()
                                    .skip_while(|c| c.is_whitespace())
                                    .take_while(|c| c.is_ascii_digit() || *c == '-')
                                    .collect();
                                num.parse().ok()
                            } else {
                                None
                            }
                        };
                        let px = extract_i32("prev_x");
                        let py = extract_i32("prev_y");
                        let w = extract_i32("width");
                        let h = extract_i32("height");
                        if let (Some(x), Some(y), Some(w), Some(h)) = (px, py, w, h) {
                            let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
                            let _ = window.set_size(tauri::PhysicalSize::new(w as u32, h as u32));
                        }
                    }
                } else {
                    let _ = window.restore_state(
                        StateFlags::POSITION
                            | StateFlags::SIZE
                            | StateFlags::VISIBLE
                            | StateFlags::DECORATIONS
                            | StateFlags::FULLSCREEN,
                    );
                }
                // Make the window visible now that the
                // geometry is in place. restore_state
                // already calls show() for the non-maximized
                // path, but a defensive second call here is
                // a no-op if it's already shown.
                let _ = window.show();
            }
            Ok(())
        })
        // tao 0.35 (the windowing crate in the tauri 2.11 train) draws
        // its own client-side decorations on Wayland, and the
        // input-stealing container it installs leaves the native
        // minimize/maximize/close buttons dead on first show — they only
        // start working after a maximize/restore cycle re-lays the
        // header out (tauri#13440). Our `visible: false` + `show()`
        // startup is exactly the pattern that trips it. Toggling
        // resizable once on first focus forces the same re-layout with
        // no visible flicker (workaround from tauri#11856). tao 0.36 /
        // tauri 2.12 revert to GTK's own CSD and fix this for good —
        // delete this hook when we move to that train.
        .on_window_event(|window, event| {
            #[cfg(target_os = "linux")]
            if let tauri::WindowEvent::Focused(true) = event {
                nudge_wayland_csd_once(window);
            }
            #[cfg(not(target_os = "linux"))]
            let _ = (window, event);
        })
        .invoke_handler(tauri::generate_handler![
            commands::startup_launch_options,
            material::desktop_platform,
            material::activate_window_material,
            commands::proxy_request,
            commands::proxy_stream,
            commands::set_webview_zoom,
            commands::read_dropped_file,
            commands::read_bounded_file,
            commands::write_text_file,
            commands::write_blob_file,
            commands::detect_system_theme,
            commands::reset_window_state,
            commands::open_app_data_directory,
            commands::get_home_dir,
            commands::reveal_in_explorer,
            commands::open_in_browser,
            commands::keychain_warm,
            commands::keychain_get,
            commands::keychain_set,
            commands::keychain_delete,
            // Tool-calling commands. See src-tauri/src/tools/.
            tools::fs_ops::tool_read_file,
            tools::fs_ops::tool_write_file,
            tools::fs_ops::tool_list_dir,
            tools::fs_ops::tool_check_path,
            tools::fs_ops::tool_resolve_path,
            tools::fs_ops::tool_stat,
            tools::fs_ops::tool_read_image,
            tools::fs_ops::tool_analyze_images,
            tools::pdf::tool_read_pdf,
            tools::web::tool_web_fetch,
            tools::shell::tool_run_shell,
            tools::grep::tool_grep,
            tools::edit::tool_edit,
            tools::web_search::tool_web_search,
            tools::glob::tool_glob_files,
            tools::apply_patch::tool_apply_patch_targets,
            tools::apply_patch::tool_apply_patch_preflight,
            tools::apply_patch::tool_apply_patch,
            tools::registry::abort_tool_calls,
            tools::registry::abort_group,
            // models.dev background sync + manual refresh + metadata lookup.
            models_dev::lookup_models_dev,
            models_dev::sync_models_dev,
            models_dev::download_models_dev,
            models_dev::rebuild_models_dev_cache,
            models_dev::clear_models_dev_cache,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
