//! `tool_read_pdf` — PDF text extraction and selective page rendering.
//!
//! All PDF work happens here, in Rust. The webview never sees PDF
//! bytes or rendered images: it sends paths and receives final public results. That keeps the sandbox boundary
//! exactly where every other file tool puts it (`resolve_under_roots`)
//! and keeps parsing off the UI thread.
//!
//! Two depths, mirroring the JS-side `depth` enum:
//!   - `text_only` — extract the text layer, classify each page, no rendering.
//!   - `full` — additionally rasterize the pages carrying visual content
//!     that text extraction cannot represent.
//!
//! # Why the predicate looks the way it does
//!
//! An earlier revision drove the render decision off
//! `AutoExtractor::extract_page().regions`, expecting
//! `RegionKind::{Chart, Figure, Table}`. That was wrong.
//! `AutoExtractor::text_only()` selects `AutoExtractOptions::fast()`,
//! documented in the crate as "Text-layer biased, no layout/table
//! work", with `reconstruct_image_tables: false`. Measured against
//! independent fixtures (`tests/fixtures/pdf/`, generated from raw PDF
//! syntax, not by `pdf_oxide`), that path returns exactly one
//! full-page `RegionKind::Text` region for **every** input — prose,
//! vector chart, ruled table, raster figure, and full-page scan alike.
//! The enum variants exist; that code path does not produce them.
//!
//! Every signal below is instead measured directly, and each is
//! pinned by a fixture asserting the render decision:
//!
//! | Signal                              | API                    |
//! |-------------------------------------|------------------------|
//! | no text layer / image page          | `classify_page`        |
//! | unmappable glyphs (mojibake)        | `classify_page`        |
//! | embedded raster                     | `extract_images`       |
//! | vector chart or diagram             | `extract_paths`        |
//! | table (structure is *inferred*)     | `extract_tables`       |
//! | equations                           | `extract_spans` fonts  |
//!
//! Rendering is always whole-page. Region crops were specified in an
//! earlier revision but are not shipped: the bounding boxes are
//! available, but a wrong crop silently omits the very content the
//! render exists to supply, and `render_page_region` rasterizes the
//! full page before cropping anyway, so the CPU saving is nil.
//!
//! OCR is deliberately not enabled. `AutoExtractor::text_only()` pins
//! `ExtractMode::TextOnly`, so the OCR path — which would want to
//! download recognition models at runtime — never engages.

use super::model_request::NativeModelConfig;
use std::path::PathBuf;
use std::time::{Duration, Instant};
mod summary;

use pdf_oxide::document::PdfDocument;
use pdf_oxide::extractors::auto::{AutoExtractor, PageKind, ReasonCode};
use pdf_oxide::rendering::{render_page, ImageFormat, RenderOptions};
use serde::Deserialize;
use tokio_util::sync::CancellationToken;

use super::fs_ops::{merged_roots, resolve_under_roots};
use super::registry::{ToolError, ToolHandle, ToolOk};

/// Hard ceiling on input file size.
const HARD_CAP_BYTES: u64 = 100 * 1024 * 1024;

/// Rendered pages per **call** (not per file).
const DEFAULT_RENDER_PAGES: usize = 20;
const HARD_CAP_RENDER_PAGES: usize = 50;

/// Pages whose text is extracted per **call** (not per file).
const DEFAULT_TEXT_PAGES: usize = 200;
const HARD_CAP_TEXT_PAGES: usize = 500;

/// Maximum PDFs in one call. Without this, `paths` is unbounded.
const MAX_PATHS: usize = 4;

/// Total encoded PNG bytes per call. Rendered pages remain native and
/// enter model requests without crossing the webview bridge, so the
/// aggregate matters more than any single page.
const MAX_TOTAL_ENCODED_BYTES: usize = 24 * 1024 * 1024;

/// Maximum rasterized pixels for one page. A PDF may declare an
/// arbitrarily large MediaBox; without this a single page could request
/// a multi-gigabyte pixmap.
const MAX_RENDER_PIXELS: u64 = 40_000_000;

/// Resolution floor when scaling down to satisfy `MAX_RENDER_PIXELS`.
/// Below this, text is illegible and the render is not worth doing.
const MIN_DPI: u32 = 72;
const DEFAULT_DPI: u32 = 150;

/// Vector-path count above which a page is treated as carrying a chart
/// or diagram. Header rules and underlines produce one or two paths;
/// the independent chart fixture produces fourteen.
const MIN_VECTOR_PATHS: usize = 4;

/// Font families that indicate mathematical typesetting. Matched
/// case-insensitively as substrings against `TextSpan::font_name`,
/// after the `ABCDEF+` subset prefix.
const MATH_FONT_MARKERS: &[&str] = &[
    "cmmi",
    "cmsy",
    "cmex",
    "msam",
    "msbm",
    "rsfs",
    "eufm",
    "stix",
    "mathjax",
    "latinmodernmath",
    "xitsmath",
    "asana",
    "euclid",
    "mtmi",
    "mtsy",
    "symbol",
];

#[derive(Clone, Default, Deserialize)]
pub struct ReadPdfRequest {
    pub paths: Vec<String>,
    pub summarize: Option<bool>,
    pub instruction: Option<String>,
    pub text_model: Option<NativeModelConfig>,
    pub vision_model: Option<NativeModelConfig>,
    pub vision_available: Option<bool>,
    #[serde(default)]
    pub depth: Option<String>,
    /// 1-based page numbers. Parsed and validated JS-side so the range
    /// grammar stays unit-testable there; an empty vec means "no pages
    /// matched", never "all pages".
    #[serde(default)]
    pub pages: Option<Vec<usize>>,
    #[serde(default)]
    pub force_render: Option<Vec<usize>>,
    #[serde(default)]
    pub include_text: Option<bool>,
    #[serde(default)]
    pub max_bytes: Option<u64>,
    #[serde(default)]
    pub dpi: Option<u32>,
    #[serde(default)]
    pub max_render_pages: Option<usize>,
    #[serde(default)]
    pub max_text_pages: Option<usize>,
    #[serde(default)]
    pub allowed_roots: Option<Vec<String>>,
    /// Operation identity for the native cancellation registry.
    #[serde(default)]
    pub call_id: Option<String>,
    #[serde(default)]
    pub group_id: Option<String>,
    /// Remaining wall-clock budget for this call, in milliseconds.
    #[serde(default)]
    pub deadline_ms: Option<u64>,
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub(crate) enum RenderReason {
    NoTextLayer,
    ImagePage,
    GarbledText,
    RasterImage,
    Table,
    VectorGraphics,
    MathFont,
    Forced,
}

impl RenderReason {
    /// Stable strings the model sees in `render_reason`.
    fn as_str(self) -> &'static str {
        match self {
            RenderReason::NoTextLayer => "no_text_layer",
            RenderReason::ImagePage => "image_page",
            RenderReason::GarbledText => "garbled_text",
            RenderReason::RasterImage => "raster_image",
            RenderReason::Table => "table",
            RenderReason::VectorGraphics => "vector_graphics",
            RenderReason::MathFont => "math_font",
            RenderReason::Forced => "forced",
        }
    }
}

/// Signals measured for one page. Separated from the decision so the
/// predicate is a pure function over verified measurements.
#[derive(Debug, Default, Clone, Copy)]
pub(crate) struct PageSignals {
    pub scanned_or_image: bool,
    pub image_page: bool,
    pub garbled: bool,
    pub images: usize,
    pub paths: usize,
    pub tables: usize,
    pub math_font: bool,
    pub forced: bool,
}

/// Does this font name indicate mathematical typesetting?
pub(crate) fn is_math_font(font_name: &str) -> bool {
    // Strip the `ABCDEF+` subset prefix that subsetted fonts carry.
    let base = font_name.split('+').next_back().unwrap_or(font_name);
    let lower = base.to_ascii_lowercase();
    MATH_FONT_MARKERS.iter().any(|m| lower.contains(m))
}

/// The render decision. Biased toward rendering: the failure mode of a
/// missed signal is a chart the model never sees and cannot know it is
/// missing, which nothing downstream can detect.
pub(crate) fn plan_render(s: &PageSignals) -> Option<RenderReason> {
    if s.forced {
        return Some(RenderReason::Forced);
    }
    if s.scanned_or_image && !s.image_page {
        return Some(RenderReason::NoTextLayer);
    }
    if s.garbled {
        return Some(RenderReason::GarbledText);
    }
    if s.image_page {
        return Some(RenderReason::ImagePage);
    }
    if s.images > 0 {
        return Some(RenderReason::RasterImage);
    }
    if s.tables > 0 {
        return Some(RenderReason::Table);
    }
    if s.paths >= MIN_VECTOR_PATHS {
        return Some(RenderReason::VectorGraphics);
    }
    if s.math_font {
        return Some(RenderReason::MathFont);
    }
    None
}

/// Render DPI that keeps a page under `MAX_RENDER_PIXELS`, or `None`
/// when even `MIN_DPI` would exceed it.
pub(crate) fn fit_dpi(page_w_pt: f32, page_h_pt: f32, requested: u32) -> Option<u32> {
    if page_w_pt <= 0.0 || page_h_pt <= 0.0 {
        return None;
    }
    let px_at = |dpi: u32| -> u64 {
        let scale = dpi as f64 / 72.0;
        let w = (page_w_pt as f64 * scale).ceil().max(1.0);
        let h = (page_h_pt as f64 * scale).ceil().max(1.0);
        (w * h) as u64
    };
    if px_at(requested) <= MAX_RENDER_PIXELS {
        return Some(requested);
    }
    // Largest DPI whose pixel count fits, derived directly rather than
    // by search.
    let area_pt = (page_w_pt as f64) * (page_h_pt as f64);
    let scale = (MAX_RENDER_PIXELS as f64 / area_pt).sqrt();
    let dpi = (scale * 72.0).floor() as u32;
    if dpi >= MIN_DPI {
        Some(dpi.min(requested))
    } else {
        None
    }
}

/// Render `Table` rows to markdown. The **cell text** comes from the
/// text layer and is exact; the **row/column structure** is spatially
/// inferred and may be wrong. The distinction is surfaced to the model
/// by the native summary prompt, which labels the structure as inferred.
fn table_to_markdown(t: &pdf_oxide::structure::table_extractor::Table) -> Option<String> {
    if t.rows.is_empty() {
        return None;
    }
    let esc = |s: &str| s.replace('|', "\\|").replace('\n', " ").trim().to_string();
    let mut out = String::new();
    let cols = t.rows.iter().map(|r| r.cells.len()).max().unwrap_or(0);
    if cols == 0 {
        return None;
    }
    for (i, row) in t.rows.iter().enumerate() {
        let mut cells: Vec<String> = row.cells.iter().map(|c| esc(&c.text)).collect();
        cells.resize(cols, String::new());
        out.push_str("| ");
        out.push_str(&cells.join(" | "));
        out.push_str(" |\n");
        if i == 0 {
            out.push('|');
            for _ in 0..cols {
                out.push_str("---|");
            }
            out.push('\n');
        }
    }
    Some(out)
}

/// Shared budget across the whole call — every limit here is call-wide,
/// not per file, so a batch of PDFs cannot multiply them.
struct CallBudget {
    text_pages: usize,
    render_pages: usize,
    encoded_bytes: usize,
    deadline: Option<Instant>,
    token: Option<CancellationToken>,
}

impl CallBudget {
    fn expired(&self) -> bool {
        self.deadline.map(|d| Instant::now() >= d).unwrap_or(false)
    }
    fn cancelled(&self) -> bool {
        self.token
            .as_ref()
            .map(|t| t.is_cancelled())
            .unwrap_or(false)
    }
    fn should_stop(&self) -> bool {
        self.cancelled() || self.expired()
    }
}

#[tauri::command]
pub async fn tool_read_pdf(mut req: ReadPdfRequest) -> Result<ToolOk, ToolError> {
    let token = CancellationToken::new();
    let _guard = req.call_id.as_ref().map(|id| {
        super::registry::register_with_group(
            id.clone(),
            ToolHandle(token.clone()),
            req.group_id.clone(),
        )
    });
    let deadline = Instant::now()
        .checked_add(Duration::from_millis(req.deadline_ms.unwrap_or(300_000)))
        .ok_or(ToolError::Timeout)?;
    summary::active(&token, deadline)?;
    if req.paths.is_empty()
        || req
            .depth
            .as_deref()
            .is_some_and(|d| d != "full" && d != "text_only")
    {
        return Err(ToolError::InvalidArguments(
            "Provide at least one PDF path and use depth=\"text_only\" or depth=\"full\".".into(),
        ));
    }
    if !req.summarize.unwrap_or(true)
        && (req.depth.as_deref() == Some("full")
            || req.force_render.as_ref().is_some_and(|p| !p.is_empty()))
    {
        return Err(ToolError::InvalidArguments("summarize:false returns extracted text only. Use depth=\"text_only\" and omit force_render, or set summarize:true for visual summarization.".into()));
    }
    let mut warnings = Vec::new();
    if req.depth.as_deref() == Some("full") && !req.vision_available.unwrap_or(true) {
        req.depth = Some("text_only".into());
        warnings.push("depth=\"full\" was requested but no vision-capable model is available. No pages were rendered. Set \"Model for image analyze\" in Settings or switch to a vision-capable chat model, then retry.".into());
    }
    let native_req = req.clone();
    let native_token = token.clone();
    let extraction =
        tokio::task::spawn_blocking(move || extract_pdf(&native_req, native_token, deadline));
    let prepared = summary::within_deadline(&token, deadline, async {
        extraction
            .await
            .map_err(|e| ToolError::Io(format!("PDF extraction task failed: {e}")))?
    })
    .await;
    let (files, extraction_warnings) = match prepared {
        Ok(v) => v,
        Err(e) => {
            token.cancel();
            return Err(e);
        }
    };
    warnings.extend(extraction_warnings);
    let client = if req.summarize.unwrap_or(true)
        && (req.text_model.is_some() || req.vision_model.is_some())
    {
        Some(
            reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(30))
                .build()
                .map_err(|e| ToolError::Io(e.to_string()))?,
        )
    } else {
        None
    };
    let context = summary::SummaryContext {
        req: &req,
        client: client.as_ref(),
        deadline,
        token: &token,
    };
    let depth = req.depth.as_deref().unwrap_or("text_only");
    let mut out = Vec::with_capacity(files.len());
    let mut files = files.into_iter();
    while let Some(first) = files.next() {
        summary::active(&token, deadline)?;
        // try_join drops a partner immediately on terminal cancellation/timeout.
        // Ordinary model errors are already contained inside each file result.
        let pair = if let Some(second) = files.next() {
            tokio::try_join!(context.file(first, depth), context.file(second, depth))
                .map(|(a, b)| vec![a, b])
        } else {
            context.file(first, depth).await.map(|a| vec![a])
        };
        match pair {
            Ok(results) => {
                for (file, issues) in results {
                    out.push(file);
                    warnings.extend(issues);
                }
            }
            Err(e) => {
                token.cancel();
                return Err(e);
            }
        }
    }
    summary::active(&token, deadline)?;
    Ok(serde_json::json!({"files":out,"warnings":warnings}))
}

fn extract_pdf(
    req: &ReadPdfRequest,
    token: CancellationToken,
    deadline: Instant,
) -> Result<(Vec<serde_json::Value>, Vec<String>), ToolError> {
    let roots = merged_roots(req.allowed_roots.as_deref().unwrap_or(&[]));
    let want_full = req.depth.as_deref() == Some("full");
    let include_text = true; // Native summaries and summary-free reads both need text.
    let dpi = req.dpi.unwrap_or(DEFAULT_DPI).clamp(MIN_DPI, 600);
    let max_bytes = req
        .max_bytes
        .unwrap_or(25 * 1024 * 1024)
        .min(HARD_CAP_BYTES);

    let mut warnings: Vec<String> = Vec::new();
    let mut paths = req.paths.clone();
    if paths.len() > MAX_PATHS {
        warnings.push(format!(
                "LC received {} PDFs. It admits the first {} (limit {}). Dropped trailing paths: {}. Admission does not imply successful processing. Call lc_read_pdf again with the remaining {} paths.",
                paths.len(), MAX_PATHS, MAX_PATHS, paths.len()-MAX_PATHS, paths.len()-MAX_PATHS
            ));
        paths.truncate(MAX_PATHS);
    }

    let mut budget = CallBudget {
        text_pages: req
            .max_text_pages
            .unwrap_or(DEFAULT_TEXT_PAGES)
            .min(HARD_CAP_TEXT_PAGES),
        render_pages: req
            .max_render_pages
            .unwrap_or(DEFAULT_RENDER_PAGES)
            .min(HARD_CAP_RENDER_PAGES),
        encoded_bytes: MAX_TOTAL_ENCODED_BYTES,
        deadline: Some(deadline),
        token: Some(token.clone()),
    };

    let mut files: Vec<serde_json::Value> = Vec::with_capacity(paths.len());
    let mut deadline_reached = false;

    for raw in &paths {
        // Checkpoint between files.
        if budget.cancelled() {
            return Err(ToolError::Aborted);
        }
        if budget.expired() {
            deadline_reached = true;
            break;
        }
        match read_one_pdf(
            raw,
            &roots,
            want_full,
            include_text,
            dpi,
            max_bytes,
            req.pages.as_deref(),
            req.force_render.as_deref(),
            &mut budget,
            &mut warnings,
        ) {
            Ok(v) => files.push(v),
            Err(e) => files.push(serde_json::json!({
                "path": raw,
                "error": e.to_string(),
            })),
        }
    }

    if budget.cancelled() {
        return Err(ToolError::Aborted);
    }
    if deadline_reached || budget.expired() {
        warnings.push(
                "The time budget for this call expired. Some pages were not processed. Retry with fewer pages or a smaller file.".into(),
            );
    }

    summary::active(&token, deadline)?;
    Ok((files, warnings))
}

/// Measure every render signal for one page using APIs whose behavior
/// is pinned by the fixture tests.
fn measure_page(doc: &PdfDocument, idx: usize, forced: bool) -> (PageSignals, Vec<String>) {
    let mut s = PageSignals {
        forced,
        ..Default::default()
    };

    if let Ok(c) = doc.classify_page(idx) {
        s.scanned_or_image = matches!(c.kind, PageKind::Scanned | PageKind::ImageText);
        s.image_page = matches!(c.kind, PageKind::ImageText);
        // Two distinct mojibake cases, both measured on fixtures:
        //   - GlyphMappingMissing: the crate names the broken CID map.
        //   - PageKind::Empty while a text layer exists: glyphs are
        //     present but map to nothing, so extraction yields "".
        s.garbled = matches!(c.reason, ReasonCode::GlyphMappingMissing)
            || (matches!(c.kind, PageKind::Empty) && doc.has_text_layer(idx).unwrap_or(false));
    }

    s.images = doc.extract_images(idx).map(|v| v.len()).unwrap_or(0);
    s.paths = doc.extract_paths(idx).map(|v| v.len()).unwrap_or(0);

    let tables = doc.extract_tables(idx).unwrap_or_default();
    s.tables = tables.len();
    let tables_md: Vec<String> = tables.iter().filter_map(table_to_markdown).collect();

    if let Ok(spans) = doc.extract_spans(idx) {
        s.math_font = spans.iter().any(|sp| is_math_font(&sp.font_name));
    }

    (s, tables_md)
}

/// Build the implicit "all pages" selection without allocating in
/// proportion to the PDF-controlled page count.
fn bounded_default_pages(total: usize, remaining_budget: usize) -> Vec<usize> {
    (0..total.min(remaining_budget)).collect()
}

#[allow(clippy::too_many_arguments)]
fn read_one_pdf(
    raw: &str,
    roots: &[PathBuf],
    want_full: bool,
    include_text: bool,
    dpi: u32,
    max_bytes: u64,
    pages: Option<&[usize]>,
    force_render: Option<&[usize]>,
    budget: &mut CallBudget,
    warnings: &mut Vec<String>,
) -> Result<serde_json::Value, ToolError> {
    let path = resolve_under_roots(raw, roots)?;

    let meta = std::fs::metadata(&path).map_err(|e| ToolError::Io(e.to_string()))?;
    if meta.len() > max_bytes {
        // Page selection cannot shrink the file — only raising the cap
        // (or choosing a smaller document) can.
        return Err(ToolError::Io(format!(
            "PDF is {} bytes, over the {} byte limit. Raise max_bytes (hard cap {}) \
             to read this file; selecting fewer pages does not reduce its size.",
            meta.len(),
            max_bytes,
            HARD_CAP_BYTES
        )));
    }

    let doc = PdfDocument::open(&path).map_err(|e| ToolError::Io(format!("open failed: {e}")))?;

    if doc.is_encrypted() && !doc.is_authenticated() {
        return Err(ToolError::Io(
            "PDF is encrypted and requires a password. LC cannot open password-protected PDFs. Use a PDF without password protection."
                .into(),
        ));
    }

    let total = doc
        .page_count()
        .map_err(|e| ToolError::Io(format!("page_count failed: {e}")))?;

    // An explicitly supplied but empty selection is a caller error, not
    // "every page". The JS layer rejects malformed expressions before
    // reaching here; this guards the wire contract.
    let (mut wanted, mut requested_pages): (Vec<usize>, usize) = match pages {
        Some([]) => {
            return Err(ToolError::Io(format!(
                "no pages selected for {} (the document has {} pages)",
                path.to_string_lossy(),
                total
            )));
        }
        Some(list) => {
            let in_range: Vec<usize> = list
                .iter()
                .filter(|p| **p >= 1 && **p <= total)
                .map(|p| p - 1)
                .collect();
            if in_range.is_empty() {
                return Err(ToolError::Io(format!(
                    "page selection is entirely outside {}, which has {} pages",
                    path.to_string_lossy(),
                    total
                )));
            }
            let count = in_range.len();
            (in_range, count)
        }
        None => {
            // Never allocate in proportion to a PDF-controlled page count.
            // The previous `(0..total).collect()` materialized every index
            // and only then truncated to the call-wide cap, so a document
            // claiming millions of pages could defeat the cap before any
            // extraction began.
            (bounded_default_pages(total, budget.text_pages), total)
        }
    };
    wanted.sort_unstable();
    wanted.dedup();
    if pages.is_some() {
        requested_pages = wanted.len();
    }

    let mut truncated = false;
    if requested_pages > budget.text_pages {
        truncated = true;
        let dropped = requested_pages - budget.text_pages;
        warnings.push(format!(
            "{}: {} pages requested, {} processed, {} skipped by the call-wide page budget. \
             Narrow the `pages` range to reach the rest.",
            path.to_string_lossy(),
            requested_pages,
            budget.text_pages,
            dropped
        ));
        if pages.is_some() {
            wanted.truncate(budget.text_pages);
        }
    }
    budget.text_pages -= wanted.len();

    let forced: Vec<usize> = force_render
        .map(|f| f.iter().filter(|p| **p >= 1).map(|p| p - 1).collect())
        .unwrap_or_default();

    let extractor = AutoExtractor::text_only();

    let mut out_pages: Vec<serde_json::Value> = Vec::with_capacity(wanted.len());
    let mut rendered = 0usize;
    let mut any_text_layer = false;
    // Pages that wanted pixels but did not get them, aggregated into one
    // warning rather than one per page.
    let mut skipped_render: Vec<usize> = Vec::new();
    let mut failed_render: Vec<usize> = Vec::new();
    let mut stopped_early = false;

    for &idx in &wanted {
        // Checkpoint before each page's extraction.
        if budget.should_stop() {
            stopped_early = true;
            break;
        }

        let text = extractor
            .extract_page(&doc, idx)
            .map(|pe| pe.text)
            .unwrap_or_default();
        let has_text = !text.trim().is_empty();
        if has_text {
            any_text_layer = true;
        }

        let (signals, tables_md) = measure_page(&doc, idx, forced.contains(&idx));
        let planned = if want_full {
            plan_render(&signals)
        } else {
            None
        };

        let (page_w, page_h) = doc
            .get_page_media_box(idx)
            .map(|(x0, y0, x1, y1)| (x1 - x0, y1 - y0))
            .unwrap_or((612.0, 792.0));

        let mut data_url: Option<String> = None;
        let mut render_reason: Option<&'static str> = None;
        // Retained even when the render did not happen, so a skipped
        // page is distinguishable from a page that never needed pixels.
        let mut planned_reason: Option<&'static str> = None;
        let mut render_skipped: Option<&'static str> = None;

        if let Some(reason) = planned {
            planned_reason = Some(reason.as_str());
            if budget.should_stop() {
                stopped_early = true;
                render_skipped = Some(if budget.cancelled() {
                    "aborted"
                } else {
                    "deadline"
                });
            } else if budget.render_pages == 0 {
                render_skipped = Some("render_budget");
                skipped_render.push(idx + 1);
            } else if budget.encoded_bytes == 0 {
                render_skipped = Some("output_budget");
                skipped_render.push(idx + 1);
            } else {
                match fit_dpi(page_w, page_h, dpi) {
                    None => {
                        render_skipped = Some("page_too_large");
                        skipped_render.push(idx + 1);
                    }
                    Some(use_dpi) => {
                        #[allow(clippy::field_reassign_with_default)]
                        let opts = {
                            // `RenderOptions` has a private field, so
                            // struct-update syntax is rejected outside the
                            // crate (E0451).
                            let mut o = RenderOptions::default();
                            o.dpi = use_dpi;
                            // Explicit even though it is the default: a
                            // future upstream switch to JPEG would put
                            // ringing around glyph edges, which is what
                            // misreads a digit in a dense table.
                            o.format = ImageFormat::Png;
                            o
                        };
                        match render_page(&doc, idx, &opts) {
                            Ok(img) => {
                                use base64::Engine as _;
                                let b64 =
                                    base64::engine::general_purpose::STANDARD.encode(&img.data);
                                if b64.len() > budget.encoded_bytes {
                                    render_skipped = Some("output_budget");
                                    skipped_render.push(idx + 1);
                                    budget.encoded_bytes = 0;
                                } else {
                                    budget.encoded_bytes -= b64.len();
                                    budget.render_pages -= 1;
                                    rendered += 1;
                                    data_url = Some(format!("data:image/png;base64,{b64}"));
                                    render_reason = planned_reason;
                                }
                            }
                            Err(_) => {
                                render_skipped = Some("render_failed");
                                failed_render.push(idx + 1);
                            }
                        }
                    }
                }
            }
        }

        let mut entry = serde_json::json!({
            "page": idx + 1,
            "chars": text.chars().count(),
            "provenance": if has_text { "text_layer" } else { "none" },
            "image_rendered": data_url.is_some(),
            "render_reason": render_reason,
            "planned_render_reason": planned_reason,
            "render_skipped": render_skipped,
        });
        if !tables_md.is_empty() {
            entry["tables_md"] = serde_json::json!(tables_md);
        }
        if include_text {
            entry["text"] = serde_json::json!(text);
        }
        if let Some(url) = data_url {
            entry["data_url"] = serde_json::json!(url);
        }
        out_pages.push(entry);
    }

    if stopped_early || out_pages.len() < wanted.len() {
        truncated = true;
    }

    if !skipped_render.is_empty() {
        truncated = true;
        warnings.push(format!(
            "{}: {} page(s) needed rendering but were skipped by call-wide budgets \
             (pages {}). Re-call with a narrower `pages` range.",
            path.to_string_lossy(),
            skipped_render.len(),
            summarize_pages(&skipped_render)
        ));
    }
    if !failed_render.is_empty() {
        warnings.push(format!(
            "{}: rendering failed for {} page(s) (pages {}).",
            path.to_string_lossy(),
            failed_render.len(),
            summarize_pages(&failed_render)
        ));
    }

    Ok(serde_json::json!({
        "path": path.to_string_lossy(),
        "pages_total": total,
        "has_text_layer": any_text_layer,
        "pages": out_pages,
        "pages_rendered": rendered,
        "truncated": truncated,
    }))
}

/// Compact page list for a warning: `1-3, 7, 20-22`, capped so one
/// warning cannot itself become enormous.
fn summarize_pages(pages: &[usize]) -> String {
    let mut parts: Vec<String> = Vec::new();
    let mut i = 0;
    while i < pages.len() && parts.len() < 12 {
        let start = pages[i];
        let mut end = start;
        while i + 1 < pages.len() && pages[i + 1] == end + 1 {
            i += 1;
            end = pages[i];
        }
        parts.push(if start == end {
            start.to_string()
        } else {
            format!("{start}-{end}")
        });
        i += 1;
    }
    if i < pages.len() {
        parts.push("…".into());
    }
    parts.join(", ")
}

#[cfg(test)]
mod tests;
