//! `tool_web_fetch` — fetch a URL with SSRF blocklist, body cap,
//! timeout, and abort-token registration. See `docs/security.md`
//! for the SSRF design and cancellation registry.

use super::{ToolError, ToolHandle, ToolOk};
use serde::Deserialize;
use std::net::{IpAddr, SocketAddr};
use std::time::Duration;
use tokio_util::sync::CancellationToken;

const DEFAULT_MAX_BYTES: u64 = 1024 * 1024; // 1 MiB
const HARD_CAP_MAX_BYTES: u64 = 32 * 1024 * 1024; // 32 MiB hard ceiling
const INITIAL_BODY_CAPACITY_BYTES: u64 = 64 * 1024;
const DEFAULT_TIMEOUT_MS: u64 = 10_000;
const HARD_CAP_TIMEOUT_MS: u64 = 30_000; // docs/tools/tool-reference.md, lc_web_fetch

fn effective_max_bytes(requested: Option<u64>) -> u64 {
    requested
        .unwrap_or(DEFAULT_MAX_BYTES)
        .min(HARD_CAP_MAX_BYTES)
}

fn effective_timeout_ms(requested: Option<u64>) -> u64 {
    requested
        .unwrap_or(DEFAULT_TIMEOUT_MS)
        .min(HARD_CAP_TIMEOUT_MS)
}

/// Wire request from the JS runner. `call_id` is a UUIDv4 generated
/// per-call by the JS side so `abort_tool_calls(call_ids)` can find
/// the in-flight request when the chat's AbortSignal fires.
///
/// Phase 2.1: `group_id` links this operation to its parent model
/// tool call group so `abort_group` can cancel all children at once.
#[derive(Debug, Deserialize)]
pub struct WebFetchRequest {
    pub url: String,
    pub max_bytes: Option<u64>,
    pub timeout_ms: Option<u64>,
    pub call_id: String,
    pub group_id: Option<String>,
    /// "minimal" (default) = keep script blocks, strip style/head/nav/footer;
    /// "clean" = strip everything including scripts;
    /// "raw" = return body as-is.
    pub strip_mode: Option<String>,
}

#[tauri::command]
pub async fn tool_web_fetch(req: WebFetchRequest) -> Result<ToolOk, ToolError> {
    let max_bytes = effective_max_bytes(req.max_bytes);
    let timeout_ms = effective_timeout_ms(req.timeout_ms);

    // 1. Validate URL.
    let parsed = reqwest::Url::parse(&req.url).map_err(|e| ToolError::InvalidUrl(e.to_string()))?;
    let scheme = parsed.scheme();
    if scheme != "http" && scheme != "https" {
        return Err(ToolError::InvalidUrl(format!(
            "scheme must be http or https, got {}",
            scheme
        )));
    }
    // 2. Register cancellation before DNS so abort covers the complete
    // network operation, not only response-body streaming.
    // Phase 2.1: Register with group_id so `abort_group` can
    // cancel all children of one model tool call atomically.
    let token = CancellationToken::new();
    let _guard = super::registry::register_with_group(
        req.call_id.clone(),
        ToolHandle(token.clone()),
        req.group_id.clone(),
    );

    // 3. Resolve and validate each hop, then pin that exact address in
    // reqwest. Automatic redirects are disabled so a blocked redirect
    // is an error rather than a successful 3xx response.
    let fetch_fut = async {
        let mut current_url = parsed;
        let mut redirects = 0usize;
        let mut response = loop {
            let (host, pinned_addr) = resolve_public_target(&current_url).await?;
            let mut client_builder =
                reqwest::Client::builder().redirect(reqwest::redirect::Policy::none());
            if let Some(addr) = pinned_addr {
                client_builder = client_builder.resolve(&host, addr);
            }
            let client = client_builder
                .build()
                .map_err(|e| ToolError::HttpError(format!("client build failed: {}", e)))?;
            let next_response = client.get(current_url.clone()).send().await.map_err(|e| {
                if e.is_timeout() {
                    ToolError::Timeout
                } else {
                    ToolError::HttpError(e.to_string())
                }
            })?;

            if !next_response.status().is_redirection() {
                break next_response;
            }
            let Some(location) = next_response.headers().get(reqwest::header::LOCATION) else {
                break next_response;
            };
            if redirects >= 10 {
                return Err(ToolError::HttpError("too many redirects".into()));
            }
            let location = location
                .to_str()
                .map_err(|_| ToolError::InvalidUrl("redirect Location is not valid text".into()))?;
            current_url = current_url
                .join(location)
                .map_err(|e| ToolError::InvalidUrl(format!("invalid redirect URL: {}", e)))?;
            if !matches!(current_url.scheme(), "http" | "https") {
                return Err(ToolError::BlockedHost(format!(
                    "redirect scheme is not allowed: {}",
                    current_url.scheme()
                )));
            }
            redirects += 1;
        };

        let status = response.status().as_u16();
        let content_type = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        let final_url = response.url().to_string();

        // Stream the response body with a hard cap — never buffer
        // more than max_bytes in RAM regardless of response size.
        let mut body_bytes: Vec<u8> = Vec::with_capacity(initial_body_capacity(max_bytes));
        let mut truncated = false;
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|e| ToolError::HttpError(e.to_string()))?
        {
            let room = max_bytes as usize - body_bytes.len();
            if chunk.len() > room {
                body_bytes.extend_from_slice(&chunk[..room]);
                truncated = true;
                break;
            }
            body_bytes.extend_from_slice(&chunk);
        }
        // Drop the response to close the underlying connection.
        drop(response);

        // Render per content-type. Plain text and unknown types go
        // through lossy-decode; HTML is tag-stripped; JSON is
        // pretty-printed when valid.
        let body_str = String::from_utf8_lossy(&body_bytes).into_owned();
        let raw_mode = req.strip_mode.as_deref() == Some("raw");
        let clean_mode = req.strip_mode.as_deref() == Some("clean");

        let body_out = if raw_mode {
            body_str
        } else if content_type.starts_with("text/html") {
            // Default = minimal (keep script blocks). Only "clean"
            // strips scripts too.
            strip_html_tags(&body_str, !clean_mode)
        } else if content_type.starts_with("application/json") {
            match serde_json::from_str::<serde_json::Value>(&body_str) {
                Ok(v) => serde_json::to_string_pretty(&v).unwrap_or(body_str),
                Err(_) => body_str,
            }
        } else if content_type.starts_with("text/") || content_type.is_empty() {
            body_str
        } else {
            return Err(ToolError::NonTextContent(content_type));
        };

        Ok(serde_json::json!({
            "status": status,
            "final_url": final_url,
            "content_type": content_type,
            "body": body_out,
            "truncated": truncated,
        }))
    };

    // 4. Race the whole operation against cancellation and one total timeout.
    tokio::select! {
        result = tokio::time::timeout(Duration::from_millis(timeout_ms), fetch_fut) => {
            result.unwrap_or(Err(ToolError::Timeout))
        },
        _ = token.cancelled() => Err(ToolError::Aborted),
    }
}

fn initial_body_capacity(max_bytes: u64) -> usize {
    max_bytes.min(INITIAL_BODY_CAPACITY_BYTES) as usize
}

/// Resolve one URL hop, reject it if any answer is non-global, and
/// return one validated address for reqwest's per-host DNS override.
/// IP-literal URLs need no override because the URL already pins them.
async fn resolve_public_target(
    url: &reqwest::Url,
) -> Result<(String, Option<SocketAddr>), ToolError> {
    let host = url
        .host_str()
        .ok_or_else(|| ToolError::InvalidUrl("missing host".into()))?
        .to_string();
    let port = url.port_or_known_default().unwrap_or(80);
    if let Ok(ip) = host.parse::<IpAddr>() {
        if is_blocked_ip(ip) {
            return Err(ToolError::BlockedHost(format!("blocked IP {}", ip)));
        }
        return Ok((host, None));
    }

    let addrs: Vec<SocketAddr> = tokio::net::lookup_host((host.as_str(), port))
        .await
        .map_err(|e| ToolError::BlockedHost(format!("DNS resolve failed for {}: {}", host, e)))?
        .collect();
    if addrs.is_empty() {
        return Err(ToolError::BlockedHost(format!(
            "no IPs resolved for {}",
            host
        )));
    }
    if let Some(blocked) = addrs.iter().find(|addr| is_blocked_ip(addr.ip())) {
        return Err(ToolError::BlockedHost(format!(
            "{} resolves to blocked IP {}",
            host,
            blocked.ip()
        )));
    }
    Ok((host, addrs.first().copied()))
}

/// Returns true when the IP is not a permitted global destination under the
/// current IANA special-purpose registry policy. Used by both production
/// `tool_web_fetch` and the tests below.
fn is_blocked_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_blocked_v4(v4),
        IpAddr::V6(v6) => is_blocked_v6(v6),
    }
}

fn is_blocked_v4(ip: std::net::Ipv4Addr) -> bool {
    let [a, b, c, d] = ip.octets();
    a == 0
        || a == 10
        || a == 127
        || a >= 224
        || (a == 100 && (64..=127).contains(&b))
        || (a == 169 && b == 254)
        || (a == 172 && (16..=31).contains(&b))
        // IETF protocol assignments are confined to 192.0.0.0/24.
        // PCP and TURN anycast (.9/.10) are the globally reachable exceptions.
        || (a == 192 && b == 0 && c == 0 && d != 9 && d != 10)
        || (a == 192 && b == 0 && c == 2)
        || (a == 192 && b == 168)
        || (a == 192 && b == 88 && c == 99)
        || (a == 198 && (18..=19).contains(&b))
        || (a == 198 && b == 51 && c == 100)
        || (a == 203 && b == 0 && c == 113)
}

fn is_global_ietf_protocol_exception(segments: &[u16; 8]) -> bool {
    matches!(
        *segments,
        [0x2001, 0x0001, 0, 0, 0, 0, 0, 1]
            | [0x2001, 0x0001, 0, 0, 0, 0, 0, 2]
            | [0x2001, 0x0001, 0, 0, 0, 0, 0, 3]
    ) || segments[1] == 0x0003 // AMT, 2001:3::/32
        || (segments[1] == 0x0004 && segments[2] == 0x0112) // AS112-v6 /48
        || (segments[1] & 0xfff0) == 0x0020 // ORCHIDv2 /28
        || (segments[1] & 0xfff0) == 0x0030 // Drone Remote ID DETs /28
}

fn well_known_nat64_embedded_v4(segments: &[u16; 8]) -> Option<std::net::Ipv4Addr> {
    if segments[..6] != [0x0064, 0xff9b, 0, 0, 0, 0] {
        return None;
    }
    Some(std::net::Ipv4Addr::new(
        (segments[6] >> 8) as u8,
        segments[6] as u8,
        (segments[7] >> 8) as u8,
        segments[7] as u8,
    ))
}

fn is_blocked_v6(ip: std::net::Ipv6Addr) -> bool {
    if let Some(v4) = ip.to_ipv4_mapped() {
        return is_blocked_v4(v4);
    }
    let segments = ip.segments();
    let first = segments[0];
    if well_known_nat64_embedded_v4(&segments).is_some_and(is_blocked_v4) {
        return true;
    }
    first == 0
        || (first == 0x0064 && segments[1] == 0xff9b && segments[2] == 0x0001)
        || (first == 0x0100 && segments[1] == 0 && segments[2] == 0 && matches!(segments[3], 0 | 1))
        || first == 0x5f00
        || (first & 0xfe00) == 0xfc00
        || (first & 0xffc0) == 0xfe80
        || (first & 0xff00) == 0xff00
        || (first == 0x2001
            && ((segments[1] <= 0x01ff && !is_global_ietf_protocol_exception(&segments))
                || segments[1] == 0x0db8))
        || first == 0x2002
        || (first == 0x3fff && segments[1] < 0x1000)
}

/// HTML-to-text cleaner.  With `minimal = false`, removes script,
/// style, nav, head, and footer blocks (aggressive — best for
/// content-heavy pages).  With `minimal = true`, keeps script
/// blocks (where SPA inline data lives) and only removes style,
/// head, nav, and footer.  Both modes then strip remaining tags,
/// decode entities, and collapse whitespace.
fn strip_html_tags(html: &str, minimal: bool) -> String {
    static BLOCK_CLEAN_RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static BLOCK_MINIMAL_RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static TAG_RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static ENTITY_RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static WS_RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();

    let block_clean = BLOCK_CLEAN_RE.get_or_init(|| {
        regex::Regex::new(
            r"(?is)<(script|style|head|nav|footer|noscript)\b[^>]*>.*?</(script|style|head|nav|footer|noscript)\s*>",
        )
        .unwrap()
    });
    let block_minimal = BLOCK_MINIMAL_RE.get_or_init(|| {
        regex::Regex::new(
            r"(?is)<(style|head|nav|footer|noscript)\b[^>]*>.*?</(style|head|nav|footer|noscript)\s*>",
        )
        .unwrap()
    });
    let tag_re = TAG_RE.get_or_init(|| regex::Regex::new(r"<[^>]*>").unwrap());
    let entity_re = ENTITY_RE
        .get_or_init(|| regex::Regex::new(r"&(amp|lt|gt|quot|#(\d+|[xX][0-9a-fA-F]+));").unwrap());
    let ws_re = WS_RE.get_or_init(|| regex::Regex::new(r"\s+").unwrap());

    // Step 1: remove noise blocks
    let no_blocks = if minimal {
        block_minimal.replace_all(html, " ")
    } else {
        block_clean.replace_all(html, " ")
    };

    // Step 2: strip remaining tags
    let no_tags = tag_re.replace_all(&no_blocks, " ");

    // Step 3: decode entities
    let decoded = entity_re
        .replace_all(&no_tags, |caps: &regex::Captures| match &caps[1] {
            "amp" => "&".to_string(),
            "lt" => "<".to_string(),
            "gt" => ">".to_string(),
            "quot" => "\"".to_string(),
            other if other.starts_with('#') => {
                let body = &other[1..];
                let code = if let Some(hex) = body.strip_prefix(['x', 'X']) {
                    u32::from_str_radix(hex, 16).ok()
                } else {
                    body.parse::<u32>().ok()
                };
                code.and_then(char::from_u32)
                    .map(|c| c.to_string())
                    .unwrap_or_default()
            }
            _ => caps[0].to_string(),
        })
        .to_string();

    // Step 4: collapse whitespace + trim
    ws_re.replace_all(&decoded, " ").trim().to_string()
}

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Ipv4Addr, Ipv6Addr};

    /* ---------------- SSRF blocklist -------------------------- */

    #[test]
    fn response_buffer_initial_capacity_is_bounded() {
        assert_eq!(initial_body_capacity(0), 0);
        assert_eq!(initial_body_capacity(1024), 1024);
        assert_eq!(
            initial_body_capacity(HARD_CAP_MAX_BYTES),
            INITIAL_BODY_CAPACITY_BYTES as usize
        );
    }

    #[test]
    fn caller_limits_default_and_clamp_at_native_boundary() {
        assert_eq!(effective_max_bytes(None), DEFAULT_MAX_BYTES);
        assert_eq!(
            effective_max_bytes(Some(HARD_CAP_MAX_BYTES)),
            HARD_CAP_MAX_BYTES
        );
        assert_eq!(
            effective_max_bytes(Some(HARD_CAP_MAX_BYTES + 1)),
            HARD_CAP_MAX_BYTES
        );
        assert_eq!(effective_timeout_ms(None), DEFAULT_TIMEOUT_MS);
        assert_eq!(
            effective_timeout_ms(Some(HARD_CAP_TIMEOUT_MS)),
            HARD_CAP_TIMEOUT_MS
        );
        assert_eq!(
            effective_timeout_ms(Some(HARD_CAP_TIMEOUT_MS + 1)),
            HARD_CAP_TIMEOUT_MS
        );
    }

    #[test]
    fn blocks_ipv4_loopback() {
        assert!(is_blocked_v4(Ipv4Addr::new(127, 0, 0, 1)));
        assert!(is_blocked_v4(Ipv4Addr::new(127, 255, 255, 254)));
    }

    #[test]
    fn blocks_ipv4_private_10() {
        assert!(is_blocked_v4(Ipv4Addr::new(10, 0, 0, 1)));
        assert!(is_blocked_v4(Ipv4Addr::new(10, 255, 255, 255)));
    }

    #[test]
    fn blocks_ipv4_private_172_16() {
        assert!(is_blocked_v4(Ipv4Addr::new(172, 16, 0, 1)));
        assert!(is_blocked_v4(Ipv4Addr::new(172, 31, 255, 255)));
    }

    #[test]
    fn allows_ipv4_just_outside_172_16_range() {
        // 172.15.x.x and 172.32.x.x are NOT in the 172.16.0.0/12 range.
        assert!(!is_blocked_v4(Ipv4Addr::new(172, 15, 0, 1)));
        assert!(!is_blocked_v4(Ipv4Addr::new(172, 32, 0, 1)));
    }

    #[test]
    fn blocks_ipv4_private_192_168() {
        assert!(is_blocked_v4(Ipv4Addr::new(192, 168, 1, 1)));
    }

    #[test]
    fn blocks_ipv4_link_local_169_254() {
        // Critical: 169.254.169.254 is the AWS instance metadata
        // service. Blocking this prevents the model from exfiltrating
        // cloud creds via the metadata endpoint.
        assert!(is_blocked_v4(Ipv4Addr::new(169, 254, 169, 254)));
        assert!(is_blocked_v4(Ipv4Addr::new(169, 254, 0, 1)));
    }

    #[test]
    fn blocks_ipv4_this_network_boundaries() {
        assert!(is_blocked_v4(Ipv4Addr::new(0, 0, 0, 0)));
        assert!(is_blocked_v4(Ipv4Addr::new(0, 255, 255, 255)));
        assert!(!is_blocked_v4(Ipv4Addr::new(1, 0, 0, 0)));
    }

    #[test]
    fn blocks_ipv4_multicast_reserved_and_broadcast_boundaries() {
        assert!(!is_blocked_v4(Ipv4Addr::new(223, 255, 255, 255)));
        assert!(is_blocked_v4(Ipv4Addr::new(224, 0, 0, 0)));
        assert!(is_blocked_v4(Ipv4Addr::new(239, 255, 255, 255)));
        assert!(is_blocked_v4(Ipv4Addr::new(240, 0, 0, 0)));
        assert!(is_blocked_v4(Ipv4Addr::new(255, 255, 255, 255)));
    }

    #[test]
    fn blocks_ipv4_shared_address_space_boundaries() {
        assert!(!is_blocked_v4(Ipv4Addr::new(100, 63, 255, 255)));
        assert!(is_blocked_v4(Ipv4Addr::new(100, 64, 0, 0)));
        assert!(is_blocked_v4(Ipv4Addr::new(100, 127, 255, 255)));
        assert!(!is_blocked_v4(Ipv4Addr::new(100, 128, 0, 0)));
    }

    #[test]
    fn blocks_ipv4_benchmarking_boundaries() {
        assert!(!is_blocked_v4(Ipv4Addr::new(198, 17, 255, 255)));
        assert!(is_blocked_v4(Ipv4Addr::new(198, 18, 0, 0)));
        assert!(is_blocked_v4(Ipv4Addr::new(198, 19, 255, 255)));
        assert!(!is_blocked_v4(Ipv4Addr::new(198, 20, 0, 0)));
    }

    #[test]
    fn blocks_ipv4_test_net_2_boundaries() {
        assert!(!is_blocked_v4(Ipv4Addr::new(198, 51, 99, 255)));
        assert!(is_blocked_v4(Ipv4Addr::new(198, 51, 100, 0)));
        assert!(is_blocked_v4(Ipv4Addr::new(198, 51, 100, 255)));
        assert!(!is_blocked_v4(Ipv4Addr::new(198, 51, 101, 0)));
    }

    #[test]
    fn blocks_ipv4_test_net_3_boundaries() {
        assert!(!is_blocked_v4(Ipv4Addr::new(203, 0, 112, 255)));
        assert!(is_blocked_v4(Ipv4Addr::new(203, 0, 113, 0)));
        assert!(is_blocked_v4(Ipv4Addr::new(203, 0, 113, 255)));
        assert!(!is_blocked_v4(Ipv4Addr::new(203, 0, 114, 0)));
    }

    #[test]
    fn blocks_ipv4_deprecated_6to4_relay_anycast_boundaries() {
        assert!(!is_blocked_v4(Ipv4Addr::new(192, 88, 98, 255)));
        assert!(is_blocked_v4(Ipv4Addr::new(192, 88, 99, 0)));
        assert!(is_blocked_v4(Ipv4Addr::new(192, 88, 99, 255)));
        assert!(!is_blocked_v4(Ipv4Addr::new(192, 88, 100, 0)));
    }

    #[test]
    fn allows_public_ipv4() {
        assert!(!is_blocked_v4(Ipv4Addr::new(8, 8, 8, 8)));
        assert!(!is_blocked_v4(Ipv4Addr::new(1, 1, 1, 1)));
        assert!(!is_blocked_v4(Ipv4Addr::new(93, 184, 216, 34)));
    }

    #[test]
    fn handles_192_special_purpose_space_without_blocking_the_entire_16() {
        assert!(is_blocked_v4(Ipv4Addr::new(192, 0, 0, 8)));
        assert!(is_blocked_v4(Ipv4Addr::new(192, 0, 0, 170)));
        assert!(is_blocked_v4(Ipv4Addr::new(192, 0, 2, 1)));
        assert!(!is_blocked_v4(Ipv4Addr::new(192, 0, 0, 9)));
        assert!(!is_blocked_v4(Ipv4Addr::new(192, 0, 0, 10)));
        assert!(!is_blocked_v4(Ipv4Addr::new(192, 0, 1, 1)));
    }

    #[test]
    fn blocks_ipv6_loopback() {
        assert!(is_blocked_v6(Ipv6Addr::LOCALHOST));
    }

    #[test]
    fn blocks_ipv6_unique_local_fc00() {
        assert!(is_blocked_v6(Ipv6Addr::new(0xfc00, 0, 0, 0, 0, 0, 0, 1)));
        assert!(is_blocked_v6(Ipv6Addr::new(0xfd00, 0, 0, 0, 0, 0, 0, 1)));
    }

    #[test]
    fn blocks_ipv6_link_local_fe80() {
        assert!(is_blocked_v6(Ipv6Addr::new(0xfe80, 0, 0, 0, 0, 0, 0, 1)));
    }

    #[test]
    fn blocks_ipv6_multicast_boundaries() {
        assert!(is_blocked_v6("ff00::".parse().unwrap()));
        assert!(is_blocked_v6(
            "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff".parse().unwrap()
        ));
        assert!(!is_blocked_v6("2001:4860::1".parse().unwrap()));
    }

    #[test]
    fn blocks_ipv6_6to4_boundaries() {
        assert!(!is_blocked_v6("2001:ffff::".parse().unwrap()));
        assert!(is_blocked_v6("2002::".parse().unwrap()));
        assert!(is_blocked_v6(
            "2002:ffff:ffff:ffff:ffff:ffff:ffff:ffff".parse().unwrap()
        ));
        assert!(!is_blocked_v6("2003::".parse().unwrap()));
    }

    #[test]
    fn blocks_ipv6_documentation_prefix_boundaries() {
        assert!(is_blocked_v6("3fff::".parse().unwrap()));
        assert!(is_blocked_v6(
            "3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff".parse().unwrap()
        ));
        assert!(!is_blocked_v6("3fff:1000::".parse().unwrap()));
    }

    #[test]
    fn ipv6_mask_boundaries_match_registry_policy() {
        for raw in [
            "fc00::",
            "fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
            "fe80::",
            "febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
            "2001:1f::",
            "2001:40::",
        ] {
            assert!(
                is_blocked_v6(raw.parse().unwrap()),
                "expected {raw} blocked"
            );
        }
        for raw in [
            "2001:20::",
            "2001:2f:ffff:ffff:ffff:ffff:ffff:ffff",
            "2001:30::",
            "2001:3f:ffff:ffff:ffff:ffff:ffff:ffff",
        ] {
            assert!(
                !is_blocked_v6(raw.parse().unwrap()),
                "expected {raw} allowed"
            );
        }
    }

    #[test]
    fn blocks_non_global_ipv6() {
        assert!(is_blocked_v6(Ipv6Addr::UNSPECIFIED));
        assert!(is_blocked_v6(Ipv6Addr::new(
            0x2001, 0xdb8, 0, 0, 0, 0, 0, 1
        )));
    }

    #[test]
    fn blocks_current_iana_non_global_ipv6_allocations() {
        for raw in [
            "64:ff9b:1::1",
            "100::1",
            "100:0:0:1::",
            "5f00::1",
            "2001:2::1",
            "2001:10::1",
        ] {
            let ip: Ipv6Addr = raw.parse().unwrap();
            assert!(is_blocked_v6(ip), "expected {raw} to be blocked");
        }
    }

    #[test]
    fn well_known_nat64_checks_the_embedded_ipv4() {
        let private: Ipv6Addr = "64:ff9b::10.0.0.1".parse().unwrap();
        let loopback: Ipv6Addr = "64:ff9b::127.0.0.1".parse().unwrap();
        let public: Ipv6Addr = "64:ff9b::8.8.8.8".parse().unwrap();
        assert!(is_blocked_v6(private));
        assert!(is_blocked_v6(loopback));
        assert!(!is_blocked_v6(public));
    }

    #[test]
    fn allows_globally_reachable_ietf_protocol_exceptions() {
        for raw in [
            "2001:1::1",
            "2001:1::2",
            "2001:1::3",
            "2001:3::1",
            "2001:4:112::1",
            "2001:20::1",
            "2001:30::1",
        ] {
            let ip: Ipv6Addr = raw.parse().unwrap();
            assert!(!is_blocked_v6(ip), "expected {raw} to be allowed");
        }
    }

    #[test]
    fn blocks_ipv4_mapped_private_and_loopback() {
        assert!(is_blocked_v6(Ipv4Addr::new(127, 0, 0, 1).to_ipv6_mapped()));
        assert!(is_blocked_v6(Ipv4Addr::new(10, 0, 0, 1).to_ipv6_mapped()));
        assert!(!is_blocked_v6(Ipv4Addr::new(8, 8, 8, 8).to_ipv6_mapped()));
    }

    #[tokio::test]
    async fn rejects_blocked_redirect_target() {
        let current = reqwest::Url::parse("https://example.com/start").unwrap();
        let redirect = current.join("http://127.0.0.1/private").unwrap();
        assert!(matches!(
            resolve_public_target(&redirect).await,
            Err(ToolError::BlockedHost(_))
        ));
    }

    #[tokio::test]
    async fn rejects_ipv4_mapped_loopback_url() {
        let url = reqwest::Url::parse("http://[::ffff:127.0.0.1]/private").unwrap();
        assert!(matches!(
            resolve_public_target(&url).await,
            Err(ToolError::BlockedHost(_))
        ));
    }

    /* ---------------- URL validation -------------------------- */

    #[test]
    fn rejects_non_http_scheme() {
        // We can test the scheme check via `Url::parse` of the input
        // directly without doing the full fetch. The check happens in
        // `tool_web_fetch` so we duplicate it here.
        for bad in [
            "file:///etc/passwd",
            "ftp://example.com/",
            "data:text/plain,hi",
        ] {
            let parsed = reqwest::Url::parse(bad).unwrap();
            let s = parsed.scheme();
            assert!(
                s != "http" && s != "https",
                "expected non-http scheme, got {}",
                s
            );
        }
    }

    #[test]
    fn rejects_malformed_url() {
        assert!(reqwest::Url::parse("not a url").is_err());
        assert!(reqwest::Url::parse("http://").is_err());
        assert!(reqwest::Url::parse("").is_err());
    }

    /* ---------------- HTML stripper ---------------------------- */

    #[test]
    fn strips_basic_tags() {
        // `<p>`, `<b>`, `</b>`, `</p>` → 4 tags → 4 spaces in output.
        // Tags stripped → whitespace collapsed + trimmed.
        assert_eq!(
            strip_html_tags("<p>hello <b>world</b></p>", true),
            "hello world"
        );
    }

    #[test]
    fn decodes_common_entities() {
        assert_eq!(strip_html_tags("&amp; &lt; &gt; &quot;", false), "& < > \"");
    }

    #[test]
    fn decodes_numeric_entities() {
        assert_eq!(strip_html_tags("&#65; &#x42;", false), "A B");
    }

    #[test]
    fn leaves_unknown_entities_alone() {
        assert_eq!(strip_html_tags("&copy; &nbsp;", false), "&copy; &nbsp;");
    }
}
