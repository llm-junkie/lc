//! Provider-scoped compact model metadata cache.
//!
//! Each provider block carries its `api` field so the runtime lookup can
//! match a profile's baseUrl against the right provider.  Only the 5 fields
//! LC uses are kept per model.  Built from models.dev by
//! `scripts/build-models-cache.mjs`.
//!
//! Background refresh fetches https://models.dev/api.json, converts to
//! compact format, and saves to app data dir.  Cached copy preferred if <24h.
//!
//! Manual refresh (Manage models ⭳): `download_models_dev` stores the raw
//! snapshot as `models-dev.json`; `rebuild_models_dev_cache` reduces it to
//! `models-cache.json` and swaps the in-memory cache.  Both share
//! `full_to_compact()` with the background path, so all three produce the
//! same compact bytes.

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::RwLock;
use std::time::Duration;

// ---- Compact on-disk format ----

/// One provider block: api URL + model map.
#[derive(Debug, Deserialize, Serialize, Clone)]
struct ProviderEntry {
    api: String,
    m: HashMap<String, CompactModel>,
}

/// Per-model metadata (single-letter keys for compactness).
///
/// The capability flags are `Option<bool>`, not `bool`. A sparse, legacy, or
/// hand-edited compact entry that omits `v`/`r`/`t` is saying *nothing* about
/// those capabilities, and `#[serde(default)] bool` turned that silence into an
/// explicit `false` — which the Guess flow would then offer the user as a
/// capability to save, overwriting what the server actually reported. `None`
/// means Inherit and travels to the frontend as an absent field.
///
/// `skip_serializing_if` keeps a sparse entry sparse on rewrite. Entries this
/// app generates always carry `Some(bool)` for all three, so the on-disk shape
/// of a current cache is byte-identical to before.
#[derive(Debug, Deserialize, Serialize, Clone)]
struct CompactModel {
    #[serde(default)]
    c: Option<u64>, // context_window
    #[serde(default)]
    n: Option<String>, // display_name
    #[serde(default, skip_serializing_if = "Option::is_none")]
    v: Option<bool>, // vision
    #[serde(default, skip_serializing_if = "Option::is_none")]
    r: Option<bool>, // reasoning
    #[serde(default, skip_serializing_if = "Option::is_none")]
    t: Option<bool>, // tools
}

type ProviderCache = HashMap<String, ProviderEntry>;
static CACHE: RwLock<Option<ProviderCache>> = RwLock::new(None);
const MAX_MODELS_DEV_BYTES: usize = 64 * 1024 * 1024;
const MAX_COMPACT_CACHE_BYTES: usize = 16 * 1024 * 1024;
const MAX_MODELS_DEV_PROVIDERS: usize = 1_024;
const MAX_MODELS_DEV_MODELS: usize = 65_536;

// ---- JS-facing wire types ----

/// Provider/model counts for the manual download/rebuild commands, so the
/// UI can toast a minimal "what arrived" figure without shipping the payload.
#[derive(Debug, Clone, Serialize)]
pub struct ModelsDevSummary {
    pub providers: u64,
    pub models: u64,
}

fn compact_summary(compact: &ProviderCache) -> ModelsDevSummary {
    ModelsDevSummary {
        providers: compact.len() as u64,
        models: compact.values().map(|p| p.m.len() as u64).sum(),
    }
}

/// What `lookup_models_dev` hands back per requested model id.
///
/// Absent fields are OMITTED rather than serialized as `null`, so the
/// TypeScript side sees `undefined` and can distinguish "models.dev has no
/// opinion" from a real value. This is only the metadata-lookup wire shape;
/// no tool-execution protocol depends on it.
#[derive(Debug, Clone, Serialize)]
pub struct ModelMeta {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<ModelCapabilities>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ModelCapabilities {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vision: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<bool>,
}

// ---- Full-format types (models.dev download/rebuild) ----

#[derive(Debug, Deserialize)]
struct FullProvider {
    #[serde(default)]
    api: Option<String>,
    #[serde(default)]
    models: HashMap<String, FullModel>,
}

#[derive(Debug, Deserialize)]
struct FullModel {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    limit: Option<FullLimit>,
    #[serde(default)]
    modalities: Option<FullModalities>,
    #[serde(default)]
    reasoning: Option<bool>,
    #[serde(default)]
    tool_call: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct FullLimit {
    context: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct FullModalities {
    input: Option<Vec<String>>,
}

// ---- Provider matching ----

/// Extract the "domain root" from a base URL (scheme + host, no path suffix).
/// "https://api.minimax.io/v1" → "https://api.minimax.io"
/// "https://api.deepseek.com"  → "https://api.deepseek.com"
fn domain_root(url: &str) -> &str {
    if let Some(after_scheme) = url.strip_prefix("https://") {
        if let Some(slash) = after_scheme.find('/') {
            &url[..8 + slash] // "https://" + host
        } else {
            url
        }
    } else if let Some(after_scheme) = url.strip_prefix("http://") {
        if let Some(slash) = after_scheme.find('/') {
            &url[..7 + slash]
        } else {
            url
        }
    } else {
        url
    }
}

/// Find all providers whose `api` field contains the given domain root.
/// Falls back to all providers if none match (covers local servers).
fn find_providers<'a>(cache: &'a ProviderCache, base_url: &str) -> Vec<&'a ProviderEntry> {
    let root = domain_root(base_url);
    let matched: Vec<&ProviderEntry> = cache.values().filter(|p| p.api.contains(root)).collect();
    if matched.is_empty() {
        cache.values().collect()
    } else {
        matched
    }
}

fn model_to_meta(m: &CompactModel) -> ModelMeta {
    // No flags at all → no capability object, rather than one full of
    // invented `false`s. Partial entries carry through exactly what is there.
    let capabilities = if m.v.is_none() && m.r.is_none() && m.t.is_none() {
        None
    } else {
        Some(ModelCapabilities {
            vision: m.v,
            reasoning: m.r,
            tools: m.t,
        })
    };
    ModelMeta {
        context_window: m.c,
        display_name: m.n.clone(),
        capabilities,
    }
}

/// Look up a model ID in matched providers.  Tries exact match first, then
/// case-insensitive.  Returns the first match found.
fn lookup_in_providers(providers: &[&ProviderEntry], api_id: &str) -> Option<ModelMeta> {
    let lower = api_id.to_lowercase();
    for p in providers {
        if let Some(m) = p.m.get(api_id) {
            return Some(model_to_meta(m));
        }
        for (key, m) in &p.m {
            if key.to_lowercase() == lower {
                return Some(model_to_meta(m));
            }
        }
    }
    None
}

// ---- File I/O ----

fn read_file_limited(path: &Path, max_bytes: usize, label: &str) -> Result<Vec<u8>, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("read {label}: {e}"))?;
    if file
        .metadata()
        .map_err(|e| format!("stat {label}: {e}"))?
        .len()
        > max_bytes as u64
    {
        return Err(format!("{label} exceeds the {max_bytes}-byte limit"));
    }
    let mut bytes = Vec::new();
    file.take(max_bytes as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("read {label}: {e}"))?;
    if bytes.len() > max_bytes {
        return Err(format!("{label} exceeds the {max_bytes}-byte limit"));
    }
    Ok(bytes)
}

fn load_compact(path: &Path) -> Result<ProviderCache, String> {
    let bytes = read_file_limited(path, MAX_COMPACT_CACHE_BYTES, "cache")?;
    let cache: ProviderCache =
        serde_json::from_slice(&bytes).map_err(|e| format!("parse cache: {e}"))?;
    validate_compact_entries(&cache)?;
    Ok(cache)
}

fn validate_compact_entries(cache: &ProviderCache) -> Result<(), String> {
    let summary = compact_summary(cache);
    if summary.providers as usize > MAX_MODELS_DEV_PROVIDERS
        || summary.models as usize > MAX_MODELS_DEV_MODELS
    {
        return Err("compact models.dev cache exceeds its entry limit".into());
    }
    Ok(())
}

fn serialize_compact_limited(cache: &ProviderCache) -> Result<Vec<u8>, String> {
    validate_compact_entries(cache)?;
    let bytes = serde_json::to_vec(cache).map_err(|e| format!("serialize: {e}"))?;
    if bytes.len() > MAX_COMPACT_CACHE_BYTES {
        return Err(format!(
            "compact models.dev cache exceeds the {MAX_COMPACT_CACHE_BYTES}-byte limit"
        ));
    }
    Ok(bytes)
}

fn cache_file_is_fresh(path: &Path) -> bool {
    std::fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .is_some_and(|modified| {
            modified.elapsed().unwrap_or(Duration::MAX) < Duration::from_secs(86_400)
        })
}

fn load_preferred_compact(downloaded: &Path, bundled: &Path) -> Result<ProviderCache, String> {
    if downloaded.exists() && cache_file_is_fresh(downloaded) {
        match load_compact(downloaded) {
            Ok(cache) => return Ok(cache),
            Err(downloaded_error) => {
                return load_compact(bundled).map_err(|bundled_error| {
                    format!(
                        "downloaded cache unusable ({downloaded_error}); bundled cache unusable ({bundled_error})"
                    )
                });
            }
        }
    }
    load_compact(bundled)
}

fn ensure_loaded(app_data: &Path) -> Result<(), String> {
    if CACHE.read().unwrap().is_some() {
        return Ok(());
    }

    let cache_file = app_data.join("models-cache.json");
    let bundled = bundled_path();
    let cache = load_preferred_compact(&cache_file, &bundled)?;
    *CACHE.write().unwrap() = Some(cache);
    Ok(())
}

fn app_data_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("lc")
}

fn bundled_path() -> PathBuf {
    #[cfg(not(debug_assertions))]
    {
        std::env::current_exe()
            .unwrap()
            .parent()
            .unwrap()
            .join("resources")
            .join("models-cache.json")
    }
    #[cfg(debug_assertions)]
    {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("models-cache.json")
    }
}

/// Raw models.dev snapshot written by `download_models_dev` and read back by
/// `rebuild_models_dev_cache`. Same split as the `scripts/fetch-models-dev.mjs`
/// → `scripts/build-models-cache.mjs` pair, so the manual refresh in Manage
/// models mirrors the developer refresh exactly.
fn raw_snapshot_path() -> PathBuf {
    app_data_dir().join("models-dev.json")
}

fn models_cache_path() -> PathBuf {
    app_data_dir().join("models-cache.json")
}

/// Download the full models.dev catalogue. 10 s connect, 30 s total — the
/// same budget `sync_models_dev` has always used.
async fn fetch_full_api_json() -> Result<Vec<u8>, String> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("reqwest: {e}"))?;

    let resp = client
        .get("https://models.dev/api.json")
        .header("Accept", "application/json")
        .header("User-Agent", "llm-client/1.0")
        .send()
        .await
        .map_err(|e| format!("fetch: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }

    if resp
        .content_length()
        .is_some_and(|length| length > MAX_MODELS_DEV_BYTES as u64)
    {
        return Err(format!(
            "models.dev response exceeds the {MAX_MODELS_DEV_BYTES}-byte limit"
        ));
    }
    let mut bytes = Vec::new();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("read: {e}"))?;
        if chunk.len() > MAX_MODELS_DEV_BYTES.saturating_sub(bytes.len()) {
            return Err(format!(
                "models.dev response exceeds the {MAX_MODELS_DEV_BYTES}-byte limit"
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn parse_full(bytes: &[u8]) -> Result<HashMap<String, FullProvider>, String> {
    let full: HashMap<String, FullProvider> =
        serde_json::from_slice(bytes).map_err(|e| format!("parse: {e}"))?;
    let providers = full.len();
    let models: usize = full.values().map(|provider| provider.models.len()).sum();
    if providers > MAX_MODELS_DEV_PROVIDERS {
        return Err(format!(
            "models.dev exceeds {MAX_MODELS_DEV_PROVIDERS} providers"
        ));
    }
    if models > MAX_MODELS_DEV_MODELS {
        return Err(format!("models.dev exceeds {MAX_MODELS_DEV_MODELS} models"));
    }
    Ok(full)
}

/// Full models.dev format → compact provider-scoped format. One conversion,
/// shared by `sync_models_dev`, `rebuild_models_dev_cache`, and (as
/// `build-models-cache.mjs`) the shipped artefact — they must agree.
fn full_to_compact(full: &HashMap<String, FullProvider>) -> ProviderCache {
    let mut compact: ProviderCache = HashMap::new();
    for (pid, fp) in full {
        let api = fp.api.as_deref().unwrap_or("");
        if !api.starts_with("http") {
            continue;
        }
        let mut models: HashMap<String, CompactModel> = HashMap::new();
        for m in fp.models.values() {
            let key = m.id.as_deref().unwrap_or("unknown");
            if models.contains_key(key) {
                continue;
            }
            let ctx = m.limit.as_ref().and_then(|l| l.context);
            let has_vision = m
                .modalities
                .as_ref()
                .and_then(|mods| mods.input.as_ref())
                .map(|v| v.iter().any(|s| s == "image"))
                .unwrap_or(false);
            let reasoning = m.reasoning.unwrap_or(false);
            let tools = m.tool_call.unwrap_or(true);
            if ctx.is_none() && m.name.is_none() && !has_vision && !reasoning {
                continue;
            }
            models.insert(
                key.to_string(),
                CompactModel {
                    c: ctx,
                    n: m.name.clone(),
                    // All three are computed from the full models.dev record,
                    // so the generated cache stays complete — `Some(false)` is
                    // a known negative, not a missing field.
                    v: Some(has_vision),
                    r: Some(reasoning),
                    t: Some(tools),
                },
            );
        }
        if !models.is_empty() {
            compact.insert(
                pid.clone(),
                ProviderEntry {
                    api: api.to_string(),
                    m: models,
                },
            );
        }
    }
    compact
}

/// Write via a sibling temp file + rename, so an interrupted manual refresh
/// cannot leave a truncated file the rebuild step would happily parse into a
/// short catalogue. Mirrors `scripts/fetch-models-dev.mjs`.
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let temp = path.with_extension("json.partial");
    std::fs::write(&temp, bytes).map_err(|e| format!("write temp: {e}"))?;
    std::fs::rename(&temp, path).map_err(|e| format!("rename: {e}"))
}

// ---- Tauri commands ----

/// Batch lookup: takes a base URL + model IDs, returns metadata for each.
/// Matches the base URL against provider `api` fields to find the right
/// provider, then looks up each model ID.
#[tauri::command]
pub async fn lookup_models_dev(
    base_url: String,
    ids: Vec<String>,
) -> Result<Vec<Option<ModelMeta>>, String> {
    let app_data = app_data_dir();
    ensure_loaded(&app_data)?;
    let cache = CACHE.read().unwrap();
    let state = cache.as_ref().unwrap();
    let providers = find_providers(state, &base_url);
    Ok(ids
        .iter()
        .map(|id| lookup_in_providers(&providers, id))
        .collect())
}

/// Delete the downloaded models-cache.json (and the raw models-dev.json
/// snapshot a manual refresh may have left) from the app data dir so the
/// next lookup falls back to the bundled copy.  Called by the JS-side
/// "Reset settings" flow.
#[tauri::command]
pub fn clear_models_dev_cache() -> Result<(), String> {
    for file in [models_cache_path(), raw_snapshot_path()] {
        if file.exists() {
            std::fs::remove_file(&file).map_err(|e| format!("clear models cache: {e}"))?;
        }
    }
    // Also invalidate the in-memory cache so the next lookup re-reads
    // from disk (which will now be the bundled copy).
    *CACHE.write().unwrap() = None;
    Ok(())
}

/// Background refresh — fetches models.dev, converts to compact, saves.
/// Skips while the downloaded copy is < 24 h old; the manual
/// `download_models_dev` + `rebuild_models_dev_cache` pair is the forced path.
#[tauri::command]
pub async fn sync_models_dev() -> Result<bool, String> {
    let cache_file = models_cache_path();

    if cache_file.exists() {
        if let Ok(meta) = std::fs::metadata(&cache_file) {
            if let Ok(modified) = meta.modified() {
                if modified.elapsed().unwrap_or(Duration::MAX) < Duration::from_secs(86_400) {
                    return Ok(false);
                }
            }
        }
    }

    let full = parse_full(&fetch_full_api_json().await?)?;
    let compact = full_to_compact(&full);

    let out = serialize_compact_limited(&compact)?;
    std::fs::create_dir_all(app_data_dir()).map_err(|e| format!("mkdir: {e}"))?;
    std::fs::write(&cache_file, &out).map_err(|e| format!("write: {e}"))?;

    *CACHE.write().unwrap() = Some(compact);
    Ok(true)
}

/// Manual refresh step 1 — download the full models.dev catalogue and store
/// it verbatim as `models-dev.json` in the app data dir. No conversion, no
/// cache swap: that is `rebuild_models_dev_cache`'s job, so a failed rebuild
/// never half-applies a download.
#[tauri::command]
pub async fn download_models_dev() -> Result<ModelsDevSummary, String> {
    let bytes = fetch_full_api_json().await?;
    // Parse before persisting: a 200 response carrying HTML or a truncated
    // body must fail here, not in the rebuild step a moment later.
    let full = parse_full(&bytes)?;
    let summary = ModelsDevSummary {
        providers: full.len() as u64,
        models: full.values().map(|p| p.models.len() as u64).sum(),
    };
    std::fs::create_dir_all(app_data_dir()).map_err(|e| format!("mkdir: {e}"))?;
    write_atomic(&raw_snapshot_path(), &bytes)?;
    Ok(summary)
}

/// Manual refresh step 2 — reduce the stored `models-dev.json` snapshot to
/// the compact cache, persist it as `models-cache.json`, and swap the
/// in-memory `CACHE` so subsequent `lookup_models_dev` calls see it.
#[tauri::command]
pub fn rebuild_models_dev_cache() -> Result<ModelsDevSummary, String> {
    let snapshot = raw_snapshot_path();
    let bytes = read_file_limited(&snapshot, MAX_MODELS_DEV_BYTES, "models-dev.json")
        .map_err(|e| format!("{e} (download first)"))?;
    let full = parse_full(&bytes)?;
    let compact = full_to_compact(&full);

    let out = serialize_compact_limited(&compact)?;
    write_atomic(&models_cache_path(), &out)?;

    let summary = compact_summary(&compact);
    *CACHE.write().unwrap() = Some(compact);
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A model the generated cache would produce: all three flags present,
    /// including known negatives.
    const COMPLETE: &str = r#"{"c":200000,"n":"Complete","v":true,"r":false,"t":true}"#;

    #[test]
    fn sparse_entry_keeps_capabilities_unknown() {
        // Context and name only — a legacy or hand-edited entry. Silence about
        // a capability must stay silence, not become an explicit `false`.
        let m: CompactModel = serde_json::from_str(r#"{"c":32768,"n":"Sparse"}"#).unwrap();
        assert_eq!(m.c, Some(32768));
        assert_eq!(m.v, None);
        assert_eq!(m.r, None);
        assert_eq!(m.t, None);

        let meta = model_to_meta(&m);
        assert!(meta.capabilities.is_none());
    }

    #[test]
    fn sparse_entry_serializes_without_capability_fields() {
        let m: CompactModel = serde_json::from_str(r#"{"c":32768}"#).unwrap();
        let json = serde_json::to_string(&model_to_meta(&m)).unwrap();
        assert!(!json.contains("capabilities"), "got {json}");
        assert!(!json.contains("display_name"), "got {json}");
        assert!(json.contains("\"context_window\":32768"), "got {json}");
    }

    #[test]
    fn partial_entry_preserves_present_true_and_false() {
        let m: CompactModel = serde_json::from_str(r#"{"c":8192,"v":true,"t":false}"#).unwrap();
        let meta = model_to_meta(&m);
        let caps = meta
            .capabilities
            .as_ref()
            .expect("partial entry should carry capabilities");
        assert_eq!(caps.vision, Some(true));
        assert_eq!(caps.tools, Some(false));
        assert_eq!(caps.reasoning, None);

        let json = serde_json::to_string(&meta).unwrap();
        assert!(json.contains("\"vision\":true"), "got {json}");
        assert!(json.contains("\"tools\":false"), "got {json}");
        assert!(!json.contains("reasoning"), "got {json}");
    }

    #[test]
    fn complete_entry_deserializes_and_serializes_every_flag() {
        let m: CompactModel = serde_json::from_str(COMPLETE).unwrap();
        assert_eq!(m.v, Some(true));
        assert_eq!(m.r, Some(false));
        assert_eq!(m.t, Some(true));

        let json = serde_json::to_string(&model_to_meta(&m)).unwrap();
        assert!(json.contains("\"vision\":true"), "got {json}");
        assert!(json.contains("\"reasoning\":false"), "got {json}");
        assert!(json.contains("\"tools\":true"), "got {json}");
        assert!(json.contains("\"context_window\":200000"), "got {json}");
        assert!(json.contains("\"display_name\":\"Complete\""), "got {json}");
    }

    #[test]
    fn a_complete_compact_entry_round_trips_unchanged() {
        // The generated cache format must survive a read/write cycle byte for
        // byte, so `sync_models_dev` output does not drift.
        let m: CompactModel = serde_json::from_str(COMPLETE).unwrap();
        assert_eq!(serde_json::to_string(&m).unwrap(), COMPLETE);
    }

    #[test]
    fn full_to_compact_mirrors_the_build_script() {
        // The same shapes scripts/build-models-cache.mjs reduces: a provider
        // with an http api, a provider without one (dropped), and a model
        // with no usable fields (dropped).
        let full: HashMap<String, FullProvider> = serde_json::from_str(
            r#"{"openai":{
                    "api":"https://api.openai.com/v1",
                    "models":{
                        "gpt-5":{"id":"gpt-5","name":"GPT-5","limit":{"context":400000},
                                  "modalities":{"input":["image","text"]},"reasoning":true,"tool_call":false},
                        "bare":{"id":"bare"}
                    }},
                "local":{"api":"localhost:1234","models":{"m":{"id":"m","name":"M"}}}}"#,
        )
        .unwrap();

        let compact = full_to_compact(&full);
        assert_eq!(compact.len(), 1, "non-http provider must be dropped");
        let p = &compact["openai"];
        assert_eq!(p.m.len(), 1, "a model with no usable fields must be dropped");
        let m = &p.m["gpt-5"];
        assert_eq!(m.c, Some(400000));
        assert_eq!(m.n.as_deref(), Some("GPT-5"));
        assert_eq!(m.v, Some(true));
        assert_eq!(m.r, Some(true));
        assert_eq!(m.t, Some(false));

        let summary = compact_summary(&compact);
        assert_eq!(summary.providers, 1);
        assert_eq!(summary.models, 1);
    }

    #[test]
    fn full_catalogue_rejects_more_than_the_provider_limit() {
        let mut json = String::from("{");
        for index in 0..=MAX_MODELS_DEV_PROVIDERS {
            if index > 0 {
                json.push(',');
            }
            json.push_str(&format!(r#""p-{index}":{{"models":{{}}}}"#));
        }
        json.push('}');

        let error = parse_full(json.as_bytes()).expect_err("oversized catalogue must fail");
        assert!(error.contains(&format!("{MAX_MODELS_DEV_PROVIDERS} providers")));
    }

    #[test]
    fn file_reader_rejects_content_above_its_limit() {
        let path = std::env::temp_dir().join(format!(
            "lc-models-dev-limit-{:016x}.json",
            rand::random::<u64>()
        ));
        std::fs::write(&path, b"12345").unwrap();

        let error = read_file_limited(&path, 4, "test cache").unwrap_err();
        assert!(error.contains("4-byte limit"));
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn compact_writer_rejects_allowed_entries_that_exceed_the_restart_byte_limit() {
        let model_count = MAX_COMPACT_CACHE_BYTES / 1_024 + 1;
        assert!(model_count <= MAX_MODELS_DEV_MODELS);
        let display_name = "x".repeat(1_024);
        let models = (0..model_count)
            .map(|index| {
                (
                    format!("model-{index}"),
                    CompactModel {
                        c: Some(8_192),
                        n: Some(display_name.clone()),
                        v: Some(false),
                        r: Some(false),
                        t: Some(true),
                    },
                )
            })
            .collect();
        let cache = HashMap::from([(
            "provider".into(),
            ProviderEntry {
                api: "https://example.test/v1".into(),
                m: models,
            },
        )]);

        let error = serialize_compact_limited(&cache)
            .expect_err("an unreadable-on-restart cache must not be written or installed");
        assert!(error.contains(&format!("{MAX_COMPACT_CACHE_BYTES}-byte limit")));
    }

    #[test]
    fn incompatible_fresh_downloaded_cache_falls_back_to_bundled_cache() {
        let nonce = rand::random::<u64>();
        let downloaded =
            std::env::temp_dir().join(format!("lc-models-dev-downloaded-{nonce:016x}.json"));
        let bundled = std::env::temp_dir().join(format!("lc-models-dev-bundled-{nonce:016x}.json"));
        let oversized = std::fs::File::create(&downloaded).unwrap();
        oversized
            .set_len(MAX_COMPACT_CACHE_BYTES as u64 + 1)
            .unwrap();
        std::fs::write(
            &bundled,
            r#"{"bundled":{"api":"https://example.test/v1","m":{"model":{"c":8192}}}}"#,
        )
        .unwrap();

        let cache = load_preferred_compact(&downloaded, &bundled)
            .expect("an incompatible fresh download must not suppress the bundled cache");
        assert!(cache.contains_key("bundled"));

        std::fs::remove_file(downloaded).unwrap();
        std::fs::remove_file(bundled).unwrap();
    }

    #[test]
    fn provider_matching_falls_back_to_every_provider() {
        let cache: ProviderCache = serde_json::from_str(
            r#"{"openai":{"api":"https://api.openai.com/v1","m":{"gpt-5":{"c":400000,"v":true,"r":true,"t":true}}},
                "anthropic":{"api":"https://api.anthropic.com/v1","m":{"claude-opus-5":{"c":200000}}}}"#,
        )
        .unwrap();

        assert_eq!(find_providers(&cache, "https://api.openai.com/v1").len(), 1);
        // A LAN address matches no provider `api` field — search them all.
        assert_eq!(
            find_providers(&cache, "http://192.168.1.5:1234/v1").len(),
            2
        );

        let all: Vec<&ProviderEntry> = cache.values().collect();
        // The sparse anthropic entry still resolves, still without capabilities.
        let hit = lookup_in_providers(&all, "claude-opus-5").expect("known model");
        assert_eq!(hit.context_window, Some(200000));
        assert!(hit.capabilities.is_none());
        // Case-insensitive fallback still works.
        assert!(lookup_in_providers(&all, "GPT-5").is_some());
        assert!(lookup_in_providers(&all, "not-a-model").is_none());
    }
}
