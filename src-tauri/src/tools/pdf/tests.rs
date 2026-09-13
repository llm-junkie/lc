//! Fixture-driven coverage for `tool_read_pdf`.
//!
//! The fixtures in `tests/fixtures/pdf/` are generated from raw PDF
//! syntax by `scripts/gen_pdf_fixtures.py` (Python stdlib only). They
//! are deliberately **not** produced by `pdf_oxide`, so a fixture and
//! the parser under test cannot share a bug — which is exactly how the
//! earlier region-based predicate passed while being non-functional.
//!
//! Every render decision below is asserted against a fixture whose
//! visual content is known by construction.

use super::*;

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/pdf")
}

fn fixture(name: &str) -> PathBuf {
    let p = fixtures().join(name);
    assert!(
        p.exists(),
        "missing fixture {name}; run scripts/gen_pdf_fixtures.py"
    );
    p
}

fn budget() -> CallBudget {
    CallBudget {
        text_pages: DEFAULT_TEXT_PAGES,
        render_pages: DEFAULT_RENDER_PAGES,
        encoded_bytes: MAX_TOTAL_ENCODED_BYTES,
        deadline: None,
        token: None,
    }
}

/// Read one fixture at `full` depth with default budgets.
fn read_full(name: &str) -> serde_json::Value {
    let mut b = budget();
    let mut w = Vec::new();
    read_one_pdf(
        fixture(name).to_str().unwrap(),
        &[fixtures()],
        true,
        true,
        DEFAULT_DPI,
        HARD_CAP_BYTES,
        None,
        None,
        &mut b,
        &mut w,
    )
    .unwrap_or_else(|e| panic!("{name}: {e}"))
}

fn page_of(v: &serde_json::Value, i: usize) -> &serde_json::Value {
    &v["pages"].as_array().unwrap()[i]
}

fn reason(v: &serde_json::Value, i: usize) -> Option<String> {
    page_of(v, i)["render_reason"].as_str().map(str::to_string)
}

/* ------------------------------------------------------------------ */
/*  Render decisions — the regression this pass exists to fix          */
/* ------------------------------------------------------------------ */

#[test]
fn prose_page_is_not_rendered() {
    let v = read_full("prose.pdf");
    assert_eq!(reason(&v, 0), None, "plain prose must not be rasterized");
    assert_eq!(v["pages_rendered"], serde_json::json!(0));
    assert_eq!(v["has_text_layer"], serde_json::json!(true));
}

#[test]
fn vector_chart_is_rendered() {
    // The regression case: a chart drawn as paths has no image XObject,
    // and the previous region-based predicate never saw it.
    let v = read_full("vector_chart.pdf");
    assert_eq!(reason(&v, 0).as_deref(), Some("vector_graphics"));
    assert_eq!(v["pages_rendered"], serde_json::json!(1));
}

#[test]
fn ruled_table_is_rendered_and_yields_markdown() {
    let v = read_full("ruled_table.pdf");
    assert_eq!(reason(&v, 0).as_deref(), Some("table"));
    let md = page_of(&v, 0)["tables_md"]
        .as_array()
        .expect("tables_md present for a ruled table");
    assert!(!md.is_empty());
    let joined = md.iter().filter_map(|m| m.as_str()).collect::<String>();
    assert!(
        joined.contains('|'),
        "markdown table expected, got {joined:?}"
    );
}

#[test]
fn equation_page_is_rendered() {
    // Math is drawn with CMMI/Symbol; extraction mangles it, so pixels
    // are the only faithful representation.
    let v = read_full("equation.pdf");
    assert_eq!(reason(&v, 0).as_deref(), Some("math_font"));
}

#[test]
fn raster_figure_page_is_rendered() {
    let v = read_full("raster_figure.pdf");
    let r = reason(&v, 0);
    assert!(
        matches!(r.as_deref(), Some("image_page") | Some("raster_image")),
        "expected an image-driven reason, got {r:?}"
    );
}

#[test]
fn scanned_page_is_rendered_and_has_no_text_layer() {
    let v = read_full("scan.pdf");
    assert_eq!(reason(&v, 0).as_deref(), Some("no_text_layer"));
    assert_eq!(v["has_text_layer"], serde_json::json!(false));
    assert_eq!(page_of(&v, 0)["provenance"], serde_json::json!("none"));
}

#[test]
fn broken_glyph_page_is_rendered() {
    // A symbolic TrueType font with no ToUnicode map: glyphs exist but
    // map to nothing, so extraction yields "" while a text layer is
    // reported present. Without pixels the model sees a blank page.
    let v = read_full("broken_glyphs.pdf");
    assert_eq!(reason(&v, 0).as_deref(), Some("garbled_text"));
}

#[test]
fn mixed_document_renders_only_the_visual_pages() {
    // p1 prose, p2 vector chart, p3 ruled table, p4 raster, p5 scan.
    let v = read_full("mixed.pdf");
    assert_eq!(v["pages_total"], serde_json::json!(5));
    assert_eq!(reason(&v, 0), None, "prose page must not render");
    assert_eq!(reason(&v, 1).as_deref(), Some("vector_graphics"));
    assert_eq!(reason(&v, 2).as_deref(), Some("table"));
    assert!(reason(&v, 3).is_some(), "raster page must render");
    assert!(reason(&v, 4).is_some(), "scanned page must render");
    assert_eq!(v["pages_rendered"], serde_json::json!(4));
}

#[test]
fn text_only_depth_never_renders_any_fixture() {
    for name in [
        "prose.pdf",
        "vector_chart.pdf",
        "ruled_table.pdf",
        "equation.pdf",
        "raster_figure.pdf",
        "scan.pdf",
        "broken_glyphs.pdf",
        "mixed.pdf",
    ] {
        let mut b = budget();
        let mut w = Vec::new();
        let v = read_one_pdf(
            fixture(name).to_str().unwrap(),
            &[fixtures()],
            false,
            false,
            DEFAULT_DPI,
            HARD_CAP_BYTES,
            None,
            None,
            &mut b,
            &mut w,
        )
        .unwrap();
        assert_eq!(
            v["pages_rendered"],
            serde_json::json!(0),
            "{name} rendered at text_only"
        );
        for p in v["pages"].as_array().unwrap() {
            assert!(
                p["data_url"].is_null(),
                "{name} produced a data_url at text_only"
            );
        }
    }
}

#[test]
fn rendered_pages_carry_a_png_data_url() {
    let v = read_full("vector_chart.pdf");
    let url = page_of(&v, 0)["data_url"].as_str().expect("data_url");
    assert!(url.starts_with("data:image/png;base64,"));
    assert!(url.len() > 2000, "png suspiciously small: {}", url.len());
}

/* ------------------------------------------------------------------ */
/*  Predicate unit tests                                               */
/* ------------------------------------------------------------------ */

#[test]
fn plan_render_priority_and_negatives() {
    let none = PageSignals::default();
    assert_eq!(plan_render(&none), None);

    let mut s = PageSignals {
        paths: MIN_VECTOR_PATHS - 1,
        ..Default::default()
    };
    assert_eq!(
        plan_render(&s),
        None,
        "a couple of rules must not trip vector detection"
    );
    s.paths = MIN_VECTOR_PATHS;
    assert_eq!(plan_render(&s), Some(RenderReason::VectorGraphics));

    // Forced wins over everything.
    let f = PageSignals {
        forced: true,
        ..Default::default()
    };
    assert_eq!(plan_render(&f), Some(RenderReason::Forced));

    // Garbled outranks incidental vector content.
    let g = PageSignals {
        garbled: true,
        paths: 50,
        ..Default::default()
    };
    assert_eq!(plan_render(&g), Some(RenderReason::GarbledText));

    let m = PageSignals {
        math_font: true,
        ..Default::default()
    };
    assert_eq!(plan_render(&m), Some(RenderReason::MathFont));

    let t = PageSignals {
        tables: 1,
        ..Default::default()
    };
    assert_eq!(plan_render(&t), Some(RenderReason::Table));
}

#[test]
fn math_font_detection_handles_subset_prefixes_and_negatives() {
    assert!(is_math_font("CMMI10"));
    assert!(is_math_font("ABCDEF+CMSY10"));
    assert!(is_math_font("Symbol"));
    assert!(is_math_font("STIXTwoMath-Regular"));
    assert!(!is_math_font("Helvetica"));
    assert!(!is_math_font("ABCDEF+TimesNewRoman"));
    assert!(!is_math_font("Arial"));
}

#[test]
fn fit_dpi_scales_down_enormous_pages() {
    // US Letter at 150 DPI is far under the pixel cap.
    assert_eq!(fit_dpi(612.0, 792.0, 150), Some(150));
    // A 200x200 inch page would demand billions of pixels at 150 DPI.
    let huge = fit_dpi(14400.0, 14400.0, 150);
    assert!(
        huge.is_none() || huge.unwrap() < 150,
        "expected downscale or refusal, got {huge:?}"
    );
    // Degenerate geometry is refused rather than rendered.
    assert_eq!(fit_dpi(0.0, 792.0, 150), None);
}

#[test]
fn summarize_pages_collapses_runs_and_caps_length() {
    assert_eq!(summarize_pages(&[1, 2, 3, 7, 20, 21]), "1-3, 7, 20-21");
    let many: Vec<usize> = (1..=100).map(|n| n * 2).collect();
    let s = summarize_pages(&many);
    assert!(s.ends_with('…'), "long lists must be elided, got {s}");
    assert!(s.len() < 200);
}

/* ------------------------------------------------------------------ */
/*  Budgets, cancellation, sandbox                                     */
/* ------------------------------------------------------------------ */

#[test]
fn render_budget_is_call_wide_not_per_file() {
    let mut b = budget();
    b.render_pages = 1;
    let mut w = Vec::new();
    // mixed.pdf alone wants four renders; only one may happen.
    let v = read_one_pdf(
        fixture("mixed.pdf").to_str().unwrap(),
        &[fixtures()],
        true,
        false,
        DEFAULT_DPI,
        HARD_CAP_BYTES,
        None,
        None,
        &mut b,
        &mut w,
    )
    .unwrap();
    assert_eq!(v["pages_rendered"], serde_json::json!(1));
    assert_eq!(b.render_pages, 0, "budget must be consumed, not reset");
    assert_eq!(v["truncated"], serde_json::json!(true));
    assert_eq!(
        w.len(),
        1,
        "one aggregated warning, not one per page: {w:?}"
    );
    assert!(w[0].contains("skipped by call-wide budgets"));
}

#[test]
fn skipped_render_retains_the_planned_reason() {
    let mut b = budget();
    b.render_pages = 0;
    let mut w = Vec::new();
    let v = read_one_pdf(
        fixture("vector_chart.pdf").to_str().unwrap(),
        &[fixtures()],
        true,
        false,
        DEFAULT_DPI,
        HARD_CAP_BYTES,
        None,
        None,
        &mut b,
        &mut w,
    )
    .unwrap();
    let p = page_of(&v, 0);
    assert!(p["render_reason"].is_null(), "nothing was rendered");
    assert_eq!(
        p["planned_render_reason"],
        serde_json::json!("vector_graphics")
    );
    assert_eq!(p["render_skipped"], serde_json::json!("render_budget"));
}

#[test]
fn output_byte_budget_stops_rendering() {
    let mut b = budget();
    b.encoded_bytes = 10; // smaller than any real PNG
    let mut w = Vec::new();
    let v = read_one_pdf(
        fixture("mixed.pdf").to_str().unwrap(),
        &[fixtures()],
        true,
        false,
        DEFAULT_DPI,
        HARD_CAP_BYTES,
        None,
        None,
        &mut b,
        &mut w,
    )
    .unwrap();
    assert_eq!(v["pages_rendered"], serde_json::json!(0));
    assert!(w.iter().any(|x| x.contains("skipped by call-wide budgets")));
}

#[test]
fn cancellation_stops_page_processing() {
    let mut b = budget();
    let token = CancellationToken::new();
    token.cancel();
    b.token = Some(token);
    let mut w = Vec::new();
    let v = read_one_pdf(
        fixture("mixed.pdf").to_str().unwrap(),
        &[fixtures()],
        true,
        false,
        DEFAULT_DPI,
        HARD_CAP_BYTES,
        None,
        None,
        &mut b,
        &mut w,
    )
    .unwrap();
    assert_eq!(
        v["pages"].as_array().unwrap().len(),
        0,
        "no page work after cancel"
    );
}

#[test]
fn expired_deadline_stops_page_processing() {
    let mut b = budget();
    b.deadline = Some(Instant::now() - std::time::Duration::from_millis(1));
    let mut w = Vec::new();
    let v = read_one_pdf(
        fixture("mixed.pdf").to_str().unwrap(),
        &[fixtures()],
        true,
        false,
        DEFAULT_DPI,
        HARD_CAP_BYTES,
        None,
        None,
        &mut b,
        &mut w,
    )
    .unwrap();
    assert_eq!(v["pages"].as_array().unwrap().len(), 0);
    assert_eq!(v["truncated"], serde_json::json!(true));
}

#[test]
fn implicit_page_selection_allocates_only_the_remaining_budget() {
    let pages = bounded_default_pages(usize::MAX, HARD_CAP_TEXT_PAGES);
    assert_eq!(pages.len(), HARD_CAP_TEXT_PAGES);
    assert_eq!(pages.first(), Some(&0));
    assert_eq!(pages.last(), Some(&(HARD_CAP_TEXT_PAGES - 1)));
    assert!(bounded_default_pages(usize::MAX, 0).is_empty());
}

#[test]
fn text_page_budget_is_consumed_across_files() {
    let mut b = budget();
    b.text_pages = 3;
    let mut w = Vec::new();
    let v = read_one_pdf(
        fixture("mixed.pdf").to_str().unwrap(),
        &[fixtures()],
        false,
        false,
        DEFAULT_DPI,
        HARD_CAP_BYTES,
        None,
        None,
        &mut b,
        &mut w,
    )
    .unwrap();
    assert_eq!(v["pages"].as_array().unwrap().len(), 3);
    assert_eq!(b.text_pages, 0);
    assert_eq!(v["truncated"], serde_json::json!(true));
}

#[test]
fn rejects_paths_outside_allowed_roots() {
    let mut b = budget();
    let mut w = Vec::new();
    let r = read_one_pdf(
        fixture("prose.pdf").to_str().unwrap(),
        &[std::env::temp_dir().join("lc_no_such_root")],
        false,
        false,
        DEFAULT_DPI,
        HARD_CAP_BYTES,
        None,
        None,
        &mut b,
        &mut w,
    );
    assert!(r.is_err(), "a path outside every root must not be readable");
}

#[test]
fn empty_page_selection_is_an_error_not_all_pages() {
    let mut b = budget();
    let mut w = Vec::new();
    let r = read_one_pdf(
        fixture("mixed.pdf").to_str().unwrap(),
        &[fixtures()],
        false,
        false,
        DEFAULT_DPI,
        HARD_CAP_BYTES,
        Some(&[]),
        None,
        &mut b,
        &mut w,
    );
    let e = r.expect_err("an empty selection must fail closed");
    assert!(e.to_string().contains("no pages selected"), "got {e}");
}

#[test]
fn wholly_out_of_range_selection_is_an_error_not_a_scan() {
    let mut b = budget();
    let mut w = Vec::new();
    let r = read_one_pdf(
        fixture("mixed.pdf").to_str().unwrap(),
        &[fixtures()],
        false,
        false,
        DEFAULT_DPI,
        HARD_CAP_BYTES,
        Some(&[900, 901]),
        None,
        &mut b,
        &mut w,
    );
    let e = r.expect_err("an out-of-range selection must fail closed");
    assert!(e.to_string().contains("outside"), "got {e}");
    assert!(
        e.to_string().contains("5 pages"),
        "should report the real length: {e}"
    );
}

#[test]
fn oversized_input_error_does_not_suggest_page_selection() {
    let mut b = budget();
    let mut w = Vec::new();
    let r = read_one_pdf(
        fixture("prose.pdf").to_str().unwrap(),
        &[fixtures()],
        false,
        false,
        DEFAULT_DPI,
        10,
        None,
        None,
        &mut b,
        &mut w,
    );
    let e = r.expect_err("a 10-byte cap must reject the fixture");
    let msg = e.to_string();
    assert!(
        msg.contains("max_bytes"),
        "should name the knob that helps: {msg}"
    );
    assert!(
        msg.contains("does not reduce its size"),
        "must not imply page selection shrinks the file: {msg}"
    );
}

#[tokio::test]
async fn over_four_paths_processes_exactly_the_first_four_with_a_warning() {
    // A01 evidence rule: a cap claim needs an input that crosses it.
    // 5 paths: the first 4 must be processed, the 5th dropped, and the
    // warning must name both numbers.
    let paths: Vec<String> = (0..=MAX_PATHS)
        .map(|_| fixture("prose.pdf").to_string_lossy().into_owned())
        .collect();
    let req = ReadPdfRequest {
        paths,
        depth: Some("text_only".into()),
        pages: None,
        force_render: None,
        include_text: None,
        max_bytes: None,
        dpi: None,
        max_render_pages: None,
        max_text_pages: None,
        allowed_roots: Some(vec![fixtures().to_string_lossy().into_owned()]),
        call_id: None,
        group_id: None,
        deadline_ms: None,
        ..Default::default()
    };
    let out = tool_read_pdf(req).await.expect("read must succeed");
    let files = out["files"].as_array().expect("files array");
    assert_eq!(
        files.len(),
        MAX_PATHS,
        "exactly the first 4 paths are processed, not {}",
        files.len()
    );
    for f in files {
        assert!(
            f["error"].is_null(),
            "each admitted path must read cleanly: {f}"
        );
        assert_eq!(f["pages_total"], serde_json::json!(1));
    }
    let warnings = out["warnings"].as_array().expect("warnings array");
    let cap_warning = warnings
        .iter()
        .find(|w| {
            w.as_str()
                .is_some_and(|s| s.contains("It admits the first 4"))
        })
        .expect("the 4-path cap warning must be present");
    assert!(
        cap_warning
            .as_str()
            .unwrap()
            .contains("LC received 5 PDFs"),
        "warning must state the requested count: {cap_warning}"
    );
}

#[test]
fn force_render_overrides_the_predicate() {
    let mut b = budget();
    let mut w = Vec::new();
    let v = read_one_pdf(
        fixture("prose.pdf").to_str().unwrap(),
        &[fixtures()],
        true,
        false,
        DEFAULT_DPI,
        HARD_CAP_BYTES,
        None,
        Some(&[1]),
        &mut b,
        &mut w,
    )
    .unwrap();
    assert_eq!(reason(&v, 0).as_deref(), Some("forced"));
}

#[test]
fn include_text_gates_verbatim_text() {
    let mut b = budget();
    let mut w = Vec::new();
    let v = read_one_pdf(
        fixture("prose.pdf").to_str().unwrap(),
        &[fixtures()],
        false,
        false,
        DEFAULT_DPI,
        HARD_CAP_BYTES,
        None,
        None,
        &mut b,
        &mut w,
    )
    .unwrap();
    let p = page_of(&v, 0);
    assert!(
        p.get("text").is_none(),
        "verbatim text leaked without include_text"
    );
    assert!(
        p["chars"].as_u64().unwrap() > 0,
        "char count must still be reported"
    );
}
