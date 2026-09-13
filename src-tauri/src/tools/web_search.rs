//! `tool_web_search` — search the web via the user's configured provider.
//!
//! One of Brave Search, Marginalia, or a self-hosted SearXNG instance. The
//! provider and its credential are resolved from user settings on the
//! TypeScript side and arrive on the request — the model never chooses which
//! index is queried, nor the SearXNG host that is contacted.
//!
//! Exactly one provider serves a call; there is no fallback chain. See
//! `docs/search-providers.md` for the measurements and rationale.

use super::registry::{ToolHandle, ToolRegistryEntry, ToolRegistryGuard};
use super::{ToolError, ToolOk};
use futures_util::StreamExt;
use serde::Deserialize;
use std::error::Error;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

const DEFAULT_MAX_RESULTS: usize = 5;
const HARD_CAP_RESULTS: usize = 10;

fn effective_max_results(requested: Option<usize>) -> usize {
    requested
        .unwrap_or(DEFAULT_MAX_RESULTS)
        .min(HARD_CAP_RESULTS)
}
const TIMEOUT_SECS: u64 = 30;
/// Max retries for transient network errors (DNS, connect-reset, etc.)
const MAX_RETRIES: u32 = 2;
const RETRY_DELAY_MS: u64 = 3000;
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;

fn text_preview(bytes: &[u8], max_chars: usize) -> String {
    String::from_utf8_lossy(bytes)
        .chars()
        .take(max_chars)
        .collect()
}

/// Walk the `source()` chain of a `dyn Error` and produce a
/// colon-separated message that includes every layer so the
/// user can see the true root cause (e.g. DNS failure,
/// TLS alert, connection-reset) rather than just the outer
/// reqwest wrapper.
fn error_chain(e: &dyn std::error::Error) -> String {
    let mut s = e.to_string();
    let mut source = e.source();
    while let Some(inner) = source {
        s.push_str(" | cause: ");
        s.push_str(&inner.to_string());
        source = inner.source();
    }
    s
}

/// Return `true` when the reqwest error looks transient (we should
/// retry once or twice).
fn is_transient_error(e: &reqwest::Error) -> bool {
    if e.is_timeout() {
        return true;
    }
    if e.is_connect() {
        return true;
    }
    // Walk the source chain looking for I/O errors that suggest a
    // transient failure (connection-reset, broken-pipe, dns, etc.).
    let mut src: Option<&dyn std::error::Error> = e.source();
    while let Some(inner) = src {
        let msg = inner.to_string();
        let lower = msg.to_lowercase();
        if lower.contains("dns") || lower.contains("connection reset")
            || lower.contains("broken pipe")
            || lower.contains("connection refused")
            || lower.contains("tls") // transient TLS alerts
            || lower.contains("unreachable")
        {
            return true;
        }
        src = inner.source();
    }
    false
}

/// Which backend serves this request. Resolved from user settings on the
/// TypeScript side — the model never picks it. Defaults to Brave so an older
/// caller that omits the field behaves exactly as before.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum SearchProvider {
    #[default]
    Brave,
    Searxng,
    Marginalia,
}

impl SearchProvider {
    fn label(self) -> &'static str {
        match self {
            SearchProvider::Brave => "brave",
            SearchProvider::Searxng => "searxng",
            SearchProvider::Marginalia => "marginalia",
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct WebSearchRequest {
    pub query: String,
    pub max_results: Option<usize>,
    #[serde(default)]
    pub provider: SearchProvider,
    pub api_key: Option<String>,
    /// Base URL of the user's SearXNG instance. Only read for that provider.
    pub base_url: Option<String>,
    /// Brave freshness filter: "pd" (past day), "pw" (past week),
    /// "pm" (past month), "py" (past year), or a custom date range
    /// like "2024-01-01to2024-06-30". Omit for all time.
    pub freshness: Option<String>,
    /// Request up to 5 additional alternative excerpts per result.
    pub extra_snippets: Option<bool>,
    #[serde(default)]
    pub call_id: Option<String>,
    #[serde(default)]
    pub group_id: Option<String>,
    #[serde(default)]
    pub deadline_ms: Option<u64>,
}

#[derive(Debug, serde::Deserialize)]
struct BraveWebResult {
    title: String,
    url: String,
    description: String,
    #[serde(default)]
    extra_snippets: Option<Vec<String>>,
}

#[derive(Debug, serde::Deserialize)]
struct BraveWeb {
    results: Vec<BraveWebResult>,
}

#[derive(Debug, serde::Deserialize)]
struct BraveResponse {
    web: Option<BraveWeb>,
}

/// Marginalia's `api2.marginalia-search.com/search` response.
///
/// Deliberately lenient: every field beyond `url` defaults, so a shape change
/// on their side degrades to a thinner result rather than failing the whole
/// call. Their extra fields (`quality`, `format`, `resultsFromDomain`,
/// `details`) are not used.
#[derive(Debug, serde::Deserialize)]
struct MarginaliaResult {
    url: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    description: String,
}

#[derive(Debug, serde::Deserialize)]
struct MarginaliaResponse {
    #[serde(default)]
    results: Vec<MarginaliaResult>,
}

/// SearXNG's `/search?format=json` response.
///
/// Verified against a live instance (2026.8.3): the snippet field is
/// `content`, not `description` as in the other two providers. Every field
/// defaults — including `url` — so a partial entry degrades to something
/// skippable rather than failing the whole call. SearXNG merges results from
/// many engines and entries carry a `template` (`default.html`,
/// `images.html`, …); entries without a usable URL are dropped below.
#[derive(Debug, serde::Deserialize)]
struct SearxngResult {
    #[serde(default)]
    url: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    content: String,
}

#[derive(Debug, serde::Deserialize)]
struct SearxngResponse {
    #[serde(default)]
    results: Vec<SearxngResult>,
    /// `[["brave","too many requests"],["startpage","CAPTCHA"]]`.
    ///
    /// Kept because an empty result set means two very different things: the
    /// query genuinely matched nothing, or every engine failed. Held as
    /// `Value` so an unexpected shape cannot break the parse.
    #[serde(default)]
    unresponsive_engines: Vec<serde_json::Value>,
}

/// Render `unresponsive_engines` as `brave (too many requests), startpage (CAPTCHA)`.
fn describe_unresponsive(entries: &[serde_json::Value]) -> String {
    entries
        .iter()
        .filter_map(|e| {
            let parts = e.as_array()?;
            let name = parts.first()?.as_str()?;
            match parts.get(1).and_then(|r| r.as_str()) {
                Some(reason) if !reason.is_empty() => Some(format!("{} ({})", name, reason)),
                _ => Some(name.to_string()),
            }
        })
        .collect::<Vec<_>>()
        .join(", ")
}

/// Is this a Brave custom freshness window, `YYYY-MM-DDtoYYYY-MM-DD`?
///
/// The previous implementation checked `len() == 21` with dashes at 15 and 18.
/// The real value is **22** bytes with dashes at 16 and 19, so the branch was
/// dead and every custom range was dropped — the request went out with no
/// `freshness` at all and the model was told nothing, which is precisely the
/// silent-filter failure the provider design exists to prevent.
///
/// Digits are validated too. The old check did not, so `----------to--------`
/// would have passed had the lengths lined up.
fn is_brave_custom_range(f: &str) -> bool {
    let b = f.as_bytes();
    if b.len() != 22 {
        return false;
    }
    let digits = |range: std::ops::Range<usize>| range.clone().all(|i| b[i].is_ascii_digit());
    digits(0..4)
        && b[4] == b'-'
        && digits(5..7)
        && b[7] == b'-'
        && digits(8..10)
        && b[10] == b't'
        && b[11] == b'o'
        && digits(12..16)
        && b[16] == b'-'
        && digits(17..19)
        && b[19] == b'-'
        && digits(20..22)
}

/// Build a Brave Search URL.
///
/// Extracted from the request path so it can be unit-tested: the custom-range
/// defect above survived because nothing exercised this builder.
fn brave_url(
    query: &str,
    max_results: usize,
    freshness: Option<&str>,
    extra_snippets: bool,
) -> String {
    let mut url = format!(
        "https://api.search.brave.com/res/v1/web/search?q={}&count={}",
        urlencoding(query),
        max_results,
    );
    if let Some(f) = freshness {
        // Presets and custom windows are both forwarded; anything else is
        // dropped rather than sent, since Brave would reject the request.
        if matches!(f, "pd" | "pw" | "pm" | "py") || is_brave_custom_range(f) {
            url.push_str(&format!("&freshness={}", f));
        }
    }
    if extra_snippets {
        url.push_str("&extra_snippets=true");
    }
    url
}

/// Build a SearXNG search URL from the user's configured base.
///
/// The base URL is typed by the user into Settings and never supplied or
/// influenced by the model, which is why a private/loopback address is allowed
/// here when `lc_web_fetch` would reject one — a self-hosted instance is
/// almost always `http://localhost:8080` or a LAN host. The scheme is still
/// checked so a hand-edited settings file cannot point this at `file://` or
/// anything else exotic.
fn searxng_url(base: &str, query: &str, freshness: Option<&str>) -> Result<String, ToolError> {
    let trimmed = base.trim().trim_end_matches('/');
    let lower = trimmed.to_ascii_lowercase();
    // A bare scheme passes a `starts_with` check but yields `http:///search`
    // and an opaque reqwest failure at call time, so require a host too.
    let host = lower
        .strip_prefix("http://")
        .or_else(|| lower.strip_prefix("https://"))
        .filter(|rest| !rest.is_empty() && !rest.starts_with('/'));
    if host.is_none() {
        return Err(ToolError::Io(format!(
            "SearXNG base URL must be http://host or https://host (got \"{}\"). \
             Fix it in LC Settings → Workspace → SearXNG base URL.",
            trimmed
        )));
    }
    // No result-count parameter: SearXNG returns whatever its engine set
    // produces for the first page and ignores `count` entirely (measured —
    // 26 results whether asked for 3 or 5). The cap is applied client-side
    // after parsing. Sending `count` anyway would imply a limit that is not
    // honoured.
    let mut url = format!("{}/search?q={}&format=json", trimmed, urlencoding(query));
    if let Some(range) = searxng_time_range(freshness) {
        url.push_str("&time_range=");
        url.push_str(range);
    }
    Ok(url)
}

/// Map Brave's `freshness` presets onto SearXNG's `time_range`.
///
/// The four presets correspond exactly. Note that `week` is **not** listed in
/// SearXNG's published API docs, which give `[day, month, year]` — but a live
/// instance accepts it and rejects anything outside `day|week|month|year` with
/// HTTP 400, so the documented set is simply incomplete.
///
/// Brave's custom `YYYY-MM-DDtoYYYY-MM-DD` range has no equivalent and is
/// dropped here; the TypeScript side reports it in `ignored_params` so the
/// model is told its filter was not applied.
///
/// Whether a given search actually honours the range depends on which engines
/// the instance has enabled — SearXNG applies it only to engines that support
/// it. That is the operator's configuration, not something LC can detect.
fn searxng_time_range(freshness: Option<&str>) -> Option<&'static str> {
    match freshness? {
        "pd" => Some("day"),
        "pw" => Some("week"),
        "pm" => Some("month"),
        "py" => Some("year"),
        _ => None,
    }
}

#[tauri::command]
pub async fn tool_web_search(req: WebSearchRequest) -> Result<ToolOk, ToolError> {
    let (cancel_token, _guard) = if let Some(ref call_id) = req.call_id {
        let token = CancellationToken::new();
        let entry = ToolRegistryEntry {
            handle: ToolHandle(token.clone()),
            group_id: req.group_id.clone(),
        };
        super::registry::registry()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(call_id.clone(), entry);
        (
            Some(token),
            Some(ToolRegistryGuard {
                call_id: call_id.clone(),
            }),
        )
    } else {
        (None, None)
    };
    // Credential differs per provider: brave/marginalia authenticate with a
    // key, searxng is identified purely by the base URL the user configured.
    let credential = match req.provider {
        SearchProvider::Searxng => req.base_url.as_deref(),
        _ => req.api_key.as_deref(),
    }
    .map(str::trim)
    .filter(|c| !c.is_empty())
    .ok_or_else(|| {
        ToolError::Io(match req.provider {
            SearchProvider::Brave => "No Brave Search API key configured. Get a key at \
                 https://brave.com/search/api/, then add it in \
                 LC Settings → Workspace → Brave Search API key."
                .to_string(),
            SearchProvider::Marginalia => "No Marginalia API key configured. Add one in \
                 LC Settings → Workspace → Marginalia API key."
                .to_string(),
            SearchProvider::Searxng => "No SearXNG base URL configured. Add the URL of your \
                 instance in LC Settings → Workspace → SearXNG base URL."
                .to_string(),
        })
    })?;

    let max_results = effective_max_results(req.max_results);

    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(
            req.deadline_ms
                .unwrap_or(TIMEOUT_SECS * 1000)
                .clamp(1, TIMEOUT_SECS * 1000),
        ))
        .user_agent("llm-client/1.0")
        .build()
        .map_err(|e| ToolError::Io(e.to_string()))?;

    let url = match req.provider {
        SearchProvider::Brave => brave_url(
            &req.query,
            max_results,
            req.freshness.as_deref(),
            req.extra_snippets.unwrap_or(false),
        ),
        // The legacy api.marginalia.nu host is deliberately not used: roughly
        // a third of cold queries there hang forever rather than erroring,
        // which is the worst possible failure inside a tool call. api2 returns
        // a fast 429 instead. See docs/search-providers.md §4.1 "Marginalia".
        SearchProvider::Marginalia => format!(
            "https://api2.marginalia-search.com/search?query={}&count={}",
            urlencoding(&req.query),
            max_results,
        ),
        SearchProvider::Searxng => searxng_url(credential, &req.query, req.freshness.as_deref())?,
    };

    // Retry loop for transient network errors (DNS blips, TLS
    // alerts, connection-reset, etc.).  These happen *sometimes*
    // even when the Brave API is healthy.
    let mut last_err: Option<reqwest::Error> = None;
    for attempt in 0..=MAX_RETRIES {
        if attempt > 0 {
            if let Some(ref token) = cancel_token {
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_millis(RETRY_DELAY_MS)) => {},
                    _ = token.cancelled() => return Err(ToolError::Aborted),
                }
            } else {
                tokio::time::sleep(Duration::from_millis(RETRY_DELAY_MS)).await;
            }
        }

        // Brave authenticates with X-Subscription-Token, Marginalia with a
        // plain API-Key header.
        let request = client.get(&url).header("Accept", "application/json");
        let send = match req.provider {
            SearchProvider::Brave => request.header("X-Subscription-Token", credential),
            SearchProvider::Marginalia => request.header("API-Key", credential),
            // A self-hosted instance needs no credential — the base URL is
            // the whole configuration.
            SearchProvider::Searxng => request,
        }
        .send();
        let response = if let Some(ref token) = cancel_token {
            tokio::select! {
                result = send => result,
                _ = token.cancelled() => return Err(ToolError::Aborted),
            }
        } else {
            send.await
        };

        match response {
            Ok(resp) => {
                let status = resp.status();
                // Respect Retry-After header for 429 (rate limit).
                if status.as_u16() == 429 && attempt < MAX_RETRIES {
                    let retry_after = resp
                        .headers()
                        .get("retry-after")
                        .and_then(|v| v.to_str().ok())
                        .and_then(|v| v.parse::<u64>().ok())
                        .unwrap_or(RETRY_DELAY_MS / 1000);
                    let delay = Duration::from_secs(retry_after.clamp(1, 30));
                    if let Some(ref token) = cancel_token {
                        tokio::select! {
                            _ = tokio::time::sleep(delay) => {},
                            _ = token.cancelled() => return Err(ToolError::Aborted),
                        }
                    } else {
                        tokio::time::sleep(delay).await;
                    }
                    continue;
                }
                let mut body_bytes = Vec::new();
                let mut stream = resp.bytes_stream();
                loop {
                    let next = if let Some(ref token) = cancel_token {
                        tokio::select! {
                            chunk = stream.next() => chunk,
                            _ = token.cancelled() => return Err(ToolError::Aborted),
                        }
                    } else {
                        stream.next().await
                    };
                    let Some(chunk) = next else { break };
                    let chunk = chunk.map_err(|e| {
                        ToolError::HttpError(format!("Failed to read response: {}", e))
                    })?;
                    if body_bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
                        return Err(ToolError::TooLarge(format!(
                            "{} response exceeded {} bytes",
                            req.provider.label(),
                            MAX_RESPONSE_BYTES
                        )));
                    }
                    body_bytes.extend_from_slice(&chunk);
                }

                if !status.is_success() {
                    let preview = text_preview(&body_bytes, 300);
                    // Marginalia's shared `public` key is rate-limited to
                    // roughly 3 queries/minute and answers 429 in ~0.2s. Say
                    // so, or the user reads it as an outage.
                    let hint = if req.provider == SearchProvider::Marginalia
                        && status.as_u16() == 429
                    {
                        " — the shared `public` key allows roughly 3 queries \
                         per minute; request your own free key at \
                         contact@marginalia-search.com for more headroom"
                    } else if req.provider == SearchProvider::Searxng && status.as_u16() == 403 {
                        // Confirmed against a real instance: SearXNG answers
                        // 403 with an HTML body for `format=json` when the
                        // format is not enabled, while HTML search on the same
                        // host returns 200. Without this the user sees a bare
                        // "403 Forbidden" and reasonably concludes the
                        // instance is down or needs auth.
                        " — this instance has not enabled JSON output. Add \
                         `json` under `search.formats` in its settings.yml \
                         and restart it"
                    } else if req.provider == SearchProvider::Searxng && status.as_u16() == 429 {
                        " — the instance's limiter is rate-limiting LC; set \
                         `limiter: false` in its settings.yml, or allow this \
                         client"
                    } else {
                        ""
                    };
                    return Err(ToolError::HttpError(format!(
                        "{} returned HTTP {}{}: {}",
                        req.provider.label(),
                        status.as_u16(),
                        hint,
                        preview
                    )));
                }

                let parse_err = |e: serde_json::Error, body: &[u8]| {
                    ToolError::Io(format!(
                        "Failed to parse {} response: {}. Body: {}",
                        req.provider.label(),
                        e,
                        text_preview(body, 400)
                    ))
                };

                let results: Vec<serde_json::Value> = match req.provider {
                    SearchProvider::Brave => {
                        let brave: BraveResponse = serde_json::from_slice(&body_bytes)
                            .map_err(|e| parse_err(e, &body_bytes))?;
                        brave
                            .web
                            .map(|w| {
                                w.results
                                    .into_iter()
                                    .map(|r| {
                                        let mut obj = serde_json::json!({
                                            "title": r.title,
                                            "url": r.url,
                                            "snippet": r.description,
                                        });
                                        if let Some(ref snippets) = r.extra_snippets {
                                            if !snippets.is_empty() {
                                                obj["extra_snippets"] = serde_json::json!(snippets);
                                            }
                                        }
                                        obj
                                    })
                                    .collect()
                            })
                            .unwrap_or_default()
                    }
                    SearchProvider::Marginalia => {
                        let m: MarginaliaResponse = serde_json::from_slice(&body_bytes)
                            .map_err(|e| parse_err(e, &body_bytes))?;
                        // api2 honours `count`, but clamp anyway so a server
                        // that ignores it cannot blow past the tool's cap.
                        m.results
                            .into_iter()
                            .take(max_results)
                            .map(|r| {
                                serde_json::json!({
                                    "title": r.title,
                                    "url": r.url,
                                    "snippet": r.description,
                                })
                            })
                            .collect()
                    }
                    SearchProvider::Searxng => {
                        let s: SearxngResponse = serde_json::from_slice(&body_bytes)
                            .map_err(|e| parse_err(e, &body_bytes))?;
                        // SearXNG ignores `count`, so the cap is applied here.
                        // Entries without a URL are unusable as search results.
                        let hits: Vec<serde_json::Value> = s
                            .results
                            .into_iter()
                            .filter(|r| !r.url.trim().is_empty())
                            .take(max_results)
                            .map(|r| {
                                serde_json::json!({
                                    "title": r.title,
                                    "url": r.url,
                                    "snippet": r.content,
                                })
                            })
                            .collect();
                        // Nothing found and every engine failed are different
                        // outcomes. Reporting both as "no results" teaches the
                        // model that the information does not exist, when in
                        // fact the instance never managed to ask.
                        if hits.is_empty() && !s.unresponsive_engines.is_empty() {
                            return Err(ToolError::Io(format!(
                                "SearXNG returned no results because every engine failed: {}. \
                                 This is an instance problem, not an absence of information.",
                                describe_unresponsive(&s.unresponsive_engines)
                            )));
                        }
                        hits
                    }
                };

                return Ok(serde_json::json!({
                    "results": results,
                    "source": req.provider.label(),
                }));
            }
            Err(e) => {
                if is_transient_error(&e) && attempt < MAX_RETRIES {
                    // Will retry — stash the error in case we run
                    // out of attempts.
                    last_err = Some(e);
                    continue;
                }
                // Non-transient or out of retries — surface the
                // full cause chain so the user can diagnose.
                return Err(ToolError::HttpError(format!(
                    "{} request failed (attempt {}/{}): {}",
                    req.provider.label(),
                    attempt + 1,
                    MAX_RETRIES + 1,
                    error_chain(&e),
                )));
            }
        }
    }

    // Exhausted all retries — last_err is guaranteed Some here.
    let e = last_err.unwrap();
    Err(ToolError::HttpError(format!(
        "{} request failed after {} retries. {}",
        req.provider.label(),
        MAX_RETRIES,
        error_chain(&e),
    )))
}

fn urlencoding(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            b' ' => out.push('+'),
            _ => {
                out.push('%');
                out.push(hex(b >> 4));
                out.push(hex(b & 0x0F));
            }
        }
    }
    out
}

fn hex(n: u8) -> char {
    match n {
        0..=9 => (b'0' + n) as char,
        _ => (b'A' + (n - 10)) as char,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn result_limit_defaults_and_clamps_at_native_boundary() {
        assert_eq!(effective_max_results(None), DEFAULT_MAX_RESULTS);
        assert_eq!(
            effective_max_results(Some(HARD_CAP_RESULTS)),
            HARD_CAP_RESULTS
        );
        assert_eq!(
            effective_max_results(Some(HARD_CAP_RESULTS + 1)),
            HARD_CAP_RESULTS
        );
    }

    fn url_of(base: &str) -> String {
        searxng_url(base, "rust async", None).expect("should build")
    }

    #[test]
    fn builds_a_json_search_url() {
        assert_eq!(
            url_of("http://192.168.31.7:8080"),
            "http://192.168.31.7:8080/search?q=rust+async&format=json"
        );
    }

    #[test]
    fn tolerates_trailing_slashes_and_padding() {
        // Users paste URLs; a trailing slash must not produce `//search`.
        for base in [
            "http://localhost:8080/",
            "http://localhost:8080///",
            "  http://localhost:8080  ",
        ] {
            assert_eq!(
                url_of(base),
                "http://localhost:8080/search?q=rust+async&format=json",
                "base {:?}",
                base
            );
        }
    }

    #[test]
    fn allows_private_and_loopback_hosts() {
        // Deliberate: a self-hosted instance is normally on localhost or the
        // LAN, and the base URL comes from Settings, never from the model.
        for base in [
            "http://localhost:8080",
            "http://127.0.0.1:8080",
            "http://192.168.31.7:8080",
            "https://searx.example.internal",
        ] {
            assert!(
                searxng_url(base, "q", None).is_ok(),
                "base {:?} must be allowed",
                base
            );
        }
    }

    #[test]
    fn rejects_non_http_schemes() {
        // Defence in depth against a hand-edited settings file. The model
        // cannot reach this value, but the check is cheap.
        for base in [
            "file:///etc/passwd",
            "ftp://host",
            "javascript:alert(1)",
            "localhost:8080",
            // Bare schemes: pass a naive starts_with check, then produce
            // `http:///search` and an opaque reqwest error at call time.
            "http://",
            "https://",
            "http:///",
        ] {
            assert!(
                searxng_url(base, "q", None).is_err(),
                "base {:?} must be rejected",
                base
            );
        }
    }

    #[test]
    fn rejecting_a_scheme_names_the_offending_value() {
        let err = searxng_url("localhost:8080", "q", None).unwrap_err();
        let msg = format!("{:?}", err);
        assert!(
            msg.contains("localhost:8080"),
            "message should quote the input: {}",
            msg
        );
    }

    #[test]
    fn encodes_the_query() {
        let url = searxng_url("http://h:8080", "a&b=c d", None).unwrap();
        assert!(url.contains("q=a%26b%3Dc+d"), "unescaped query in {}", url);
        assert!(!url.contains("a&b=c d"));
    }

    #[test]
    fn parses_a_searxng_payload_using_content_as_the_snippet() {
        // SearXNG names the snippet field `content`, unlike Brave and
        // Marginalia which both use `description`.
        let body = br#"{"query":"x","results":[
            {"url":"https://a.example/1","title":"First","content":"snippet one","engine":"google"},
            {"url":"https://b.example/2"}
        ]}"#;
        let parsed: SearxngResponse = serde_json::from_slice(body).expect("should parse");
        assert_eq!(parsed.results.len(), 2);
        assert_eq!(parsed.results[0].content, "snippet one");
        assert_eq!(parsed.results[0].title, "First");
        // A result carrying only a URL must degrade, not fail the whole call.
        assert_eq!(parsed.results[1].title, "");
        assert_eq!(parsed.results[1].content, "");
    }

    #[test]
    fn an_empty_or_unexpected_payload_yields_no_results_rather_than_an_error() {
        let empty: SearxngResponse = serde_json::from_slice(b"{}").expect("should parse");
        assert!(empty.results.is_empty());
    }
}

#[cfg(test)]
mod searxng_payload_tests {
    use super::*;

    /// Trimmed from a real response captured from a SearXNG 2026.8.3 instance.
    /// Field names and the `unresponsive_engines` shape are as observed.
    const LIVE_SAMPLE: &[u8] = br#"{
      "query": "rust async runtime",
      "results": [
        {"url":"https://rust-lang.github.io/async-book/08_ecosystem/00_chapter.html",
         "title":"The Async Ecosystem - Asynchronous Programming in Rust",
         "content":"Learn about async runtimes, libraries, and traits.",
         "template":"default.html","engine":"duckduckgo","score":1.0},
        {"url":"https://tokio.rs/tokio/tutorial/async",
         "title":"Async in depth | Tokio",
         "content":"Tokio is a runtime for writing reliable applications.",
         "template":"default.html","engine":"google","score":0.9}
      ],
      "answers": [],
      "corrections": [],
      "infoboxes": [],
      "suggestions": [],
      "unresponsive_engines": [["brave","too many requests"],["startpage","CAPTCHA"]]
    }"#;

    #[test]
    fn parses_the_live_payload() {
        let d: SearxngResponse =
            serde_json::from_slice(LIVE_SAMPLE).expect("live shape must parse");
        assert_eq!(d.results.len(), 2);
        assert_eq!(
            d.results[0].title,
            "The Async Ecosystem - Asynchronous Programming in Rust"
        );
        assert_eq!(
            d.results[0].content,
            "Learn about async runtimes, libraries, and traits."
        );
        assert_eq!(d.results[1].url, "https://tokio.rs/tokio/tutorial/async");
    }

    #[test]
    fn unknown_fields_do_not_break_parsing() {
        // Real results carry ~23 keys (img_src, pubdate, positions, …). None
        // are used, and new ones must not fail the call.
        let d: SearxngResponse = serde_json::from_slice(LIVE_SAMPLE).unwrap();
        assert!(!d.results.is_empty());
    }

    #[test]
    fn describes_unresponsive_engines_readably() {
        let d: SearxngResponse = serde_json::from_slice(LIVE_SAMPLE).unwrap();
        assert_eq!(
            describe_unresponsive(&d.unresponsive_engines),
            "brave (too many requests), startpage (CAPTCHA)"
        );
    }

    #[test]
    fn unresponsive_engines_survives_an_unexpected_shape() {
        // Held as Value precisely so a format change degrades the message
        // rather than failing the whole search.
        let body = br#"{"results":[],"unresponsive_engines":[["solo"],"bare",42,[]]}"#;
        let d: SearxngResponse = serde_json::from_slice(body).expect("must not fail");
        assert_eq!(describe_unresponsive(&d.unresponsive_engines), "solo");
    }

    #[test]
    fn entries_without_a_url_are_skipped_not_fatal() {
        let body =
            br#"{"results":[{"title":"no url","content":"x"},{"url":"https://ok.example"}]}"#;
        let d: SearxngResponse = serde_json::from_slice(body).expect("must not fail");
        let usable: Vec<_> = d
            .results
            .iter()
            .filter(|r| !r.url.trim().is_empty())
            .collect();
        assert_eq!(usable.len(), 1);
        assert_eq!(usable[0].url, "https://ok.example");
    }

    #[test]
    fn no_results_with_no_failed_engines_is_a_genuine_empty() {
        let body = br#"{"results":[],"unresponsive_engines":[]}"#;
        let d: SearxngResponse = serde_json::from_slice(body).unwrap();
        assert!(d.results.is_empty());
        assert!(
            d.unresponsive_engines.is_empty(),
            "must not be mistaken for an instance failure"
        );
    }
}

#[cfg(test)]
mod searxng_time_range_tests {
    use super::*;

    #[test]
    fn maps_every_brave_preset_one_to_one() {
        // Verified against a live instance: all four are accepted, and
        // anything outside day|week|month|year returns HTTP 400.
        assert_eq!(searxng_time_range(Some("pd")), Some("day"));
        assert_eq!(searxng_time_range(Some("pw")), Some("week"));
        assert_eq!(searxng_time_range(Some("pm")), Some("month"));
        assert_eq!(searxng_time_range(Some("py")), Some("year"));
    }

    #[test]
    fn week_is_supported_despite_being_absent_from_the_docs() {
        // SearXNG's published API docs list only [day, month, year]. A live
        // instance accepts `week`. This test exists so a future reader who
        // checks the docs does not "correct" the mapping back.
        assert_eq!(searxng_time_range(Some("pw")), Some("week"));
    }

    #[test]
    fn a_custom_date_range_has_no_equivalent_and_is_dropped() {
        // Reported to the model via ignored_params on the TypeScript side.
        assert_eq!(searxng_time_range(Some("2024-01-01to2024-06-30")), None);
    }

    #[test]
    fn unknown_or_absent_freshness_sends_nothing() {
        // Sending an unrecognised value would make the instance answer 400 and
        // fail the whole search rather than merely skipping the filter.
        assert_eq!(searxng_time_range(None), None);
        assert_eq!(searxng_time_range(Some("")), None);
        assert_eq!(searxng_time_range(Some("all")), None);
        assert_eq!(searxng_time_range(Some("hour")), None);
    }

    #[test]
    fn the_url_carries_time_range_only_when_mapped() {
        let with = searxng_url("http://h:8080", "q", Some("pw")).unwrap();
        assert!(with.ends_with("&time_range=week"), "got {}", with);

        let without = searxng_url("http://h:8080", "q", Some("2024-01-01to2024-06-30")).unwrap();
        assert!(!without.contains("time_range"), "got {}", without);

        let none = searxng_url("http://h:8080", "q", None).unwrap();
        assert!(!none.contains("time_range"), "got {}", none);
    }
}

#[cfg(test)]
mod brave_url_tests {
    use super::*;

    #[test]
    fn a_custom_date_range_is_forwarded() {
        // Regression for a dead `len() == 21` check that dropped every custom
        // window: the value is 22 bytes with dashes at 16 and 19, so the
        // branch could never fire and Brave was queried with no freshness at
        // all while the model was told its filter had been applied.
        let url = brave_url("q", 5, Some("2024-01-01to2024-06-30"), false);
        assert!(
            url.contains("&freshness=2024-01-01to2024-06-30"),
            "custom range must reach Brave, got {}",
            url
        );
    }

    #[test]
    fn every_preset_is_forwarded() {
        for p in ["pd", "pw", "pm", "py"] {
            let url = brave_url("q", 5, Some(p), false);
            assert!(url.contains(&format!("&freshness={}", p)), "{} dropped", p);
        }
    }

    #[test]
    fn junk_freshness_is_not_forwarded() {
        // Brave would reject the request outright, failing the whole search
        // rather than merely skipping the filter.
        for bad in [
            "yesterday",
            "",
            "2024-01-01",
            "2024-01-01to",
            "2024-01-01to2024-06-3",   // 21 chars — the old length
            "2024-01-01to2024-06-301", // 23 chars
            "abcd-ef-ghtoijkl-mn-op",  // right shape, not digits
            "2024/01/01to2024/06/30",  // slashes
        ] {
            let url = brave_url("q", 5, Some(bad), false);
            assert!(
                !url.contains("freshness"),
                "{:?} should be dropped, got {}",
                bad,
                url
            );
        }
    }

    #[test]
    fn custom_range_predicate_is_exact() {
        assert!(is_brave_custom_range("2024-01-01to2024-06-30"));
        assert!(is_brave_custom_range("1999-12-31to2000-01-01"));
        assert!(!is_brave_custom_range("2024-01-01to2024-06-3"));
        assert!(!is_brave_custom_range("2024-01-01TO2024-06-30"));
        assert!(!is_brave_custom_range("----------to----------"));
    }

    #[test]
    fn count_and_extra_snippets_are_carried() {
        let url = brave_url("q", 7, None, true);
        assert!(url.contains("&count=7"), "got {}", url);
        assert!(url.contains("&extra_snippets=true"), "got {}", url);

        let plain = brave_url("q", 3, None, false);
        assert!(!plain.contains("extra_snippets"), "got {}", plain);
        assert!(!plain.contains("freshness"), "got {}", plain);
    }

    #[test]
    fn the_query_is_encoded() {
        let url = brave_url("a&b=c d", 5, None, false);
        assert!(url.contains("q=a%26b%3Dc+d"), "got {}", url);
    }
}
