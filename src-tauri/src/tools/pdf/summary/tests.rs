use super::*;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc, Mutex,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

fn page(n: usize, body: &str) -> Value {
    json!({"page":n,"chars":body.len(),"text":body,"provenance":"text_layer","image_rendered":false,"render_reason":null,"tables_md":[]})
}

fn file(path: &str, pages: Vec<Value>) -> Value {
    json!({"path":path,"pages_total":pages.len(),"has_text_layer":true,"pages":pages,"pages_rendered":0,"truncated":false})
}

struct Server {
    config: NativeModelConfig,
    requests: Arc<Mutex<Vec<Value>>>,
    peak: Arc<AtomicUsize>,
    starts: Arc<Mutex<Vec<Instant>>>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn server(reply: impl Fn(usize, &Value) -> (u64, Value) + Send + Sync + 'static) -> Server {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let requests = Arc::new(Mutex::new(Vec::new()));
    let logs = requests.clone();
    let active = Arc::new(AtomicUsize::new(0));
    let peak = Arc::new(AtomicUsize::new(0));
    let high = peak.clone();
    let starts = Arc::new(Mutex::new(Vec::new()));
    let started = starts.clone();
    let reply = Arc::new(reply);
    let task = tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let logs = logs.clone();
            let active = active.clone();
            let high = high.clone();
            let reply = reply.clone();
            let started = started.clone();
            tokio::spawn(async move {
                let mut bytes = Vec::new();
                let mut buffer = [0u8; 4096];
                let header_end = loop {
                    let n = socket.read(&mut buffer).await.unwrap();
                    if n == 0 {
                        return;
                    }
                    bytes.extend_from_slice(&buffer[..n]);
                    if let Some(p) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                        break p + 4;
                    }
                };
                let headers = String::from_utf8_lossy(&bytes[..header_end]).into_owned();
                let length = headers
                    .lines()
                    .find_map(|l| {
                        l.to_lowercase()
                            .strip_prefix("content-length:")
                            .map(|n| n.trim().parse::<usize>().unwrap())
                    })
                    .unwrap();
                while bytes.len() < header_end + length {
                    let n = socket.read(&mut buffer).await.unwrap();
                    if n == 0 {
                        return;
                    }
                    bytes.extend_from_slice(&buffer[..n]);
                }
                let mut request: Value =
                    serde_json::from_slice(&bytes[header_end..header_end + length]).unwrap();
                request["_test_headers"] = json!(headers);
                let index = {
                    let mut logs = logs.lock().unwrap();
                    let i = logs.len();
                    logs.push(request.clone());
                    started.lock().unwrap().push(Instant::now());
                    i
                };
                let count = active.fetch_add(1, Ordering::SeqCst) + 1;
                high.fetch_max(count, Ordering::SeqCst);
                let (delay, body) = reply(index, &request);
                tokio::time::sleep(Duration::from_millis(delay)).await;
                let body = body.to_string();
                let response=format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len());
                let _ = socket.write_all(response.as_bytes()).await;
                active.fetch_sub(1, Ordering::SeqCst);
            });
        }
    });
    Server {
        config: NativeModelConfig {
            server_url: url,
            model: "fixture-model".into(),
            ..Default::default()
        },
        requests,
        peak,
        starts,
        task,
    }
}

fn answer(s: &str) -> Value {
    json!({"choices":[{"message":{"content":s}}]})
}

async fn summarize_with(req: &ReadPdfRequest, input: Value) -> (Value, Vec<String>) {
    let client = reqwest::Client::new();
    let token = CancellationToken::new();
    SummaryContext {
        req,
        client: req.summarize.unwrap_or(true).then_some(&client),
        deadline: Instant::now() + Duration::from_secs(5),
        token: &token,
    }
    .file(input, "text_only")
    .await
    .unwrap()
}

#[test]
fn unicode_chunking_overlap_and_instruction_budget_match_js() {
    assert_eq!(tokens("😀é中"), 1); // four UTF-16 units, nine UTF-8 bytes
    let pages: Vec<_> = (1..=4).map(|n| page(n, &"x".repeat(8000))).collect();
    let grouped = chunks(&pages, None);
    assert_eq!(grouped, vec![vec![0, 1], vec![1, 2], vec![2, 3]]);
    let huge = vec![page(1, &"x".repeat(30000)), page(2, "end")];
    assert_eq!(chunks(&huge, None), vec![vec![0], vec![1]]);
    assert!(chunks(&pages, Some(&"x".repeat(12000))).len() > grouped.len());
    let images: Vec<_> = (1..=9)
        .map(|n| {
            let mut p = page(n, "body");
            p["data_url"] = json!("data:image/png;base64,AA==");
            p
        })
        .collect();
    assert!(chunks(&images, None).iter().all(|c| c.len() <= 4));
}

#[test]
fn summary_validation_and_warning_contract() {
    for s in [
        "",
        "  ",
        "Please provide the pages.",
        "The actual content was not provided.",
        "I cannot summarize without the missing pages.",
    ] {
        assert!(normalize_summary(s.into()).unwrap().is_none(), "{s}");
    }
    assert!(normalize_summary("x".repeat(SUMMARY_MAX_BYTES))
        .unwrap()
        .is_some());
    assert!(normalize_summary("é".repeat(SUMMARY_MAX_BYTES / 2 + 1)).is_err());
    assert!(exact_warning("a.pdf", 15, true).contains("paraphrase"));
    assert!(!exact_warning("a.pdf", 15, true).contains("call lc_read_pdf again"));
    assert!(exact_warning("a.pdf", 15, false).contains("within 1-15"));
    assert!(exact_warning("a.pdf", 1, false).ends_with("within 1."));
    assert!(issue(&ToolError::Io("😀".repeat(10000))).len() <= 16 * 1024);
}

#[tokio::test]
async fn summary_free_overrides_every_text_flag_without_a_model() {
    for include_text in [None, Some(false), Some(true)] {
        let req = ReadPdfRequest {
            summarize: Some(false),
            include_text,
            ..Default::default()
        };
        let mut p = page(1, "exact source");
        p["data_url"] = json!("private pixels");
        let (out, warnings) = summarize_with(&req, file("a.pdf", vec![p])).await;
        assert_eq!(out["summary"], Value::Null);
        assert_eq!(out["pages"][0]["text"], "exact source");
        assert!(!out.to_string().contains("data_url"));
        assert!(warnings.is_empty());
    }
}

#[tokio::test]
async fn scans_and_budget_starvation_remain_distinct() {
    let req = ReadPdfRequest {
        summarize: Some(false),
        ..Default::default()
    };
    let mut scan = file("scan.pdf", vec![page(1, "")]);
    scan["has_text_layer"] = json!(false);
    let (_, warnings) = summarize_with(&req, scan).await;
    assert!(warnings[0].contains("summarize:true and depth=\"full\""));
    let mut empty = file("later.pdf", vec![]);
    empty["has_text_layer"] = json!(false);
    empty["truncated"] = json!(true);
    let (out, warnings) = summarize_with(&req, empty).await;
    assert!(warnings.is_empty());
    assert_eq!(out["truncated"], true);
}

#[tokio::test]
async fn successful_chunks_survive_blank_sibling_without_reducer() {
    let provider = server(|i, _| (0, answer(if i == 0 { "" } else { "surviving summary" }))).await;
    let req = ReadPdfRequest {
        text_model: Some(provider.config.clone()),
        include_text: Some(true),
        ..Default::default()
    };
    let (out, warnings) = summarize_with(
        &req,
        file(
            "a.pdf",
            vec![page(1, &"x".repeat(30000)), page(2, &"y".repeat(30000))],
        ),
    )
    .await;
    assert_eq!(out["summary"], "surviving summary");
    assert!(warnings
        .iter()
        .any(|w| w.contains("no usable visible summary")));
    assert_eq!(provider.requests.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn map_and_reduce_failures_remain_visible() {
    for fail_reduce in [false, true] {
        let provider = server(move |_, req| {
            let reduce = req["messages"][0]["content"]
                .as_str()
                .unwrap()
                .starts_with("Combine");
            (
                0,
                answer(if !fail_reduce || reduce {
                    "Please provide the pages."
                } else {
                    "usable map"
                }),
            )
        })
        .await;
        let req = ReadPdfRequest {
            text_model: Some(provider.config.clone()),
            ..Default::default()
        };
        let (out, warnings) = summarize_with(
            &req,
            file(
                "a.pdf",
                vec![page(1, &"x".repeat(30000)), page(2, &"y".repeat(30000))],
            ),
        )
        .await;
        assert_eq!(out["summary"], Value::Null);
        assert!(!warnings.is_empty());
        assert!(!warnings.iter().any(|w| w.contains("paraphrase")));
    }
}

#[tokio::test]
async fn chunks_route_by_payload_and_reduce_always_uses_text_model() {
    let text_server = server(|_, _| (0, answer("text summary"))).await;
    let vision_server = server(|_, _| (0, answer("vision summary"))).await;
    let req = ReadPdfRequest {
        text_model: Some(text_server.config.clone()),
        vision_model: Some(vision_server.config.clone()),
        ..Default::default()
    };
    let mut image = page(2, &"y".repeat(30000));
    image["data_url"] = json!("data:image/png;base64,AA==");
    let (out, _) = summarize_with(
        &req,
        file("a.pdf", vec![page(1, &"x".repeat(30000)), image]),
    )
    .await;
    assert_eq!(out["summary"], "text summary");
    assert_eq!(text_server.requests.lock().unwrap().len(), 2);
    assert_eq!(vision_server.requests.lock().unwrap().len(), 1);
    for request in text_server.requests.lock().unwrap().iter() {
        assert_eq!(request["max_tokens"], 4000);
        assert!(request.get("reasoning").is_none());
        assert!(!request.to_string().contains("input_image"));
    }
    assert!(!out.to_string().contains("data_url"));
    assert_eq!(out["pages"][0]["text"], Value::Null);
}

#[tokio::test]
async fn native_command_enforces_pairs_order_and_four_file_cap() {
    let provider = server(|i, _| {
        (
            if i % 2 == 0 { 70 } else { 5 },
            answer(&format!("summary {i}")),
        )
    })
    .await;
    let fixtures = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/pdf");
    let names = [
        "prose.pdf",
        "equation.pdf",
        "ruled_table.pdf",
        "vector_chart.pdf",
        "scan.pdf",
    ];
    let paths = names
        .iter()
        .map(|n| fixtures.join(n).to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    let req = ReadPdfRequest {
        paths: paths.clone(),
        allowed_roots: Some(vec![fixtures.to_string_lossy().into_owned()]),
        text_model: Some(provider.config.clone()),
        ..Default::default()
    };
    let out = tool_read_pdf(req).await.unwrap();
    assert_eq!(provider.peak.load(Ordering::SeqCst), 2);
    assert_eq!(provider.requests.lock().unwrap().len(), 4);
    let starts = provider.starts.lock().unwrap();
    assert!(
        starts[2].duration_since(starts[0]) >= Duration::from_millis(60),
        "the next pair must wait for the slow first request"
    );
    let files = out["files"].as_array().unwrap();
    assert_eq!(files.len(), 4);
    for (i, f) in files.iter().enumerate() {
        assert_eq!(
            f["path"].as_str().unwrap().replace('\\', "/"),
            paths[i].replace('\\', "/")
        );
        assert!(f["summary"].is_string());
    }
    assert!(out["warnings"].as_array().unwrap()[0]
        .as_str()
        .unwrap()
        .contains("Dropped trailing paths: 1"));
    assert!(out.get("combined_summary").is_none());
}

#[tokio::test]
async fn deadline_and_cancellation_interrupt_active_requests() {
    let provider = server(|_, _| (500, answer("too late"))).await;
    let req = ReadPdfRequest {
        text_model: Some(provider.config.clone()),
        ..Default::default()
    };
    let client = reqwest::Client::new();
    let token = CancellationToken::new();
    let context = SummaryContext {
        req: &req,
        client: Some(&client),
        deadline: Instant::now() + Duration::from_millis(40),
        token: &token,
    };
    assert!(matches!(
        context
            .file(file("a.pdf", vec![page(1, "body")]), "text_only")
            .await,
        Err(ToolError::Timeout)
    ));
    let child = token.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(20)).await;
        child.cancel();
    });
    let context = SummaryContext {
        req: &req,
        client: Some(&client),
        deadline: Instant::now() + Duration::from_secs(2),
        token: &token,
    };
    assert!(matches!(
        context
            .file(file("a.pdf", vec![page(1, "body")]), "text_only")
            .await,
        Err(ToolError::Aborted)
    ));
}

#[tokio::test]
async fn summary_free_render_conflicts_fail_before_file_access() {
    for (depth, force_render) in [(Some("full".into()), None), (None, Some(vec![1]))] {
        let req = ReadPdfRequest {
            paths: vec!["does-not-exist.pdf".into()],
            summarize: Some(false),
            depth,
            force_render,
            ..Default::default()
        };
        assert!(matches!(
            tool_read_pdf(req).await,
            Err(ToolError::InvalidArguments(_))
        ));
    }
}

#[test]
fn reduction_converges_or_reports_nonconvergence_without_dropping_inputs() {
    let partials = vec!["x".repeat(4000); 200];
    let groups = reduce_groups(&partials);
    assert!(groups.len() < partials.len());
    assert_eq!(groups.iter().map(Vec::len).sum::<usize>(), 200);
    let huge = vec!["x".repeat(SUMMARY_MAX_BYTES); 2];
    assert_eq!(reduce_groups(&huge).len(), 2);
}

#[tokio::test]
async fn all_provider_wire_shapes_handle_text_and_reduction() {
    for (variant, style) in [
        ("openai", "chat"),
        ("openai", "responses"),
        ("anthropic", "chat"),
        ("lm-studio", "chat"),
    ] {
        let provider=server(move |_,_|(0,match (variant,style) {
            ("openai","responses")=>json!({"output":[{"type":"reasoning","summary":[]},{"type":"message","content":[{"type":"output_text","text":"part one "},{"type":"output_text","text":"part two"}]}]}),
            ("anthropic",_)=>json!({"content":[{"type":"thinking","thinking":"hidden"},{"type":"text","text":"part one "},{"type":"text","text":"part two"}]}),
            ("lm-studio",_)=>json!({"output":[{"type":"reasoning","content":"hidden"},{"type":"message","content":"part one part two"}]}),
            _=>answer("part one part two"),
        })).await;
        let mut config = provider.config.clone();
        config.api_variant = Some(variant.into());
        config.api_style = Some(style.into());
        config.api_key = Some("fixture-key".into());
        config.request_headers = vec![("X-Fixture".into(), "owner-profile".into())];
        if variant != "anthropic" {
            config
                .request_headers
                .push(("Authorization".into(), "Bearer fixture-override".into()));
        }
        let req = ReadPdfRequest {
            text_model: Some(config),
            ..Default::default()
        };
        let (out, _) = summarize_with(
            &req,
            file(
                "a.pdf",
                vec![page(1, &"x".repeat(30000)), page(2, &"y".repeat(30000))],
            ),
        )
        .await;
        assert_eq!(out["summary"], "part one part two", "{variant}/{style}");
        let logs = provider.requests.lock().unwrap();
        assert_eq!(logs.len(), 3);
        for request in logs.iter() {
            let headers = request["_test_headers"].as_str().unwrap().to_lowercase();
            assert!(headers.contains("x-fixture: owner-profile"));
            if variant == "anthropic" {
                assert!(headers.contains("x-api-key: fixture-key"));
                assert!(headers.contains("anthropic-version: 2023-06-01"));
            } else {
                assert_eq!(headers.matches("authorization:").count(), 1);
                assert!(headers.contains("authorization: bearer fixture-override"));
            }
            let token_field = if style == "responses" || variant == "lm-studio" {
                "max_output_tokens"
            } else {
                "max_tokens"
            };
            assert_eq!(request[token_field], 4000);
            if style == "responses" {
                assert_eq!(request["store"], false);
            }
            assert!(!request.to_string().contains("hidden"));
        }
    }
}

#[test]
fn image_content_uses_the_matching_wire_shape() {
    for (variant, style, key) in [
        ("openai", "chat", "image_url"),
        ("openai", "responses", "input_image"),
        ("anthropic", "chat", "base64"),
        ("lm-studio", "chat", "data_url"),
    ] {
        let config = NativeModelConfig {
            server_url: "http://localhost/v1".into(),
            model: "m".into(),
            api_variant: Some(variant.into()),
            api_style: Some(style.into()),
            ..Default::default()
        };
        let (_, body) = crate::tools::model_request::request_body(
            &config,
            "prompt",
            vec![
                json!({"type":"text","text":"read this"}),
                json!({"type":"image_url","image_url":{"url":"data:image/png;base64,AA=="}}),
            ],
            Some(4000),
            Some(false),
        );
        assert!(body.to_string().contains(key), "{variant}/{style}: {body}");
        assert!(body.to_string().contains("AA=="));
    }
}

#[tokio::test]
async fn native_text_page_budget_applies_when_summary_is_disabled() {
    let fixtures = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/pdf");
    let req = ReadPdfRequest {
        paths: vec![
            fixtures.join("mixed.pdf").to_string_lossy().into_owned(),
            fixtures.join("prose.pdf").to_string_lossy().into_owned(),
        ],
        allowed_roots: Some(vec![fixtures.to_string_lossy().into_owned()]),
        summarize: Some(false),
        include_text: Some(false),
        max_text_pages: Some(1),
        ..Default::default()
    };
    let out = tool_read_pdf(req).await.unwrap();
    assert!(out["files"][0]["pages"][0]["text"].is_string());
    assert_eq!(out["files"][1]["pages"], json!([]));
    assert_eq!(out["files"][1]["truncated"], true);
    assert!(!out["warnings"].to_string().contains("looks like a scan"));
    assert!(!out["warnings"].to_string().contains("summary"));
}

#[tokio::test]
async fn native_full_read_renders_but_never_returns_images() {
    let provider = server(|_, _| (0, answer("visual summary"))).await;
    let fixtures = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/pdf");
    let req = ReadPdfRequest {
        paths: vec![fixtures
            .join("raster_figure.pdf")
            .to_string_lossy()
            .into_owned()],
        allowed_roots: Some(vec![fixtures.to_string_lossy().into_owned()]),
        depth: Some("full".into()),
        vision_model: Some(provider.config.clone()),
        text_model: Some(provider.config.clone()),
        ..Default::default()
    };
    let out = tool_read_pdf(req).await.unwrap();
    assert_eq!(out["files"][0]["summary"], "visual summary");
    assert_eq!(out["files"][0]["pages_rendered"], 1);
    assert!(!out.to_string().contains("data_url"));
    assert!(!out.to_string().contains("base64"));
    assert!(provider.requests.lock().unwrap()[0]
        .to_string()
        .contains("data:image/png;base64,"));
}

#[tokio::test]
async fn hierarchical_reduction_preserves_every_branch() {
    let provider = server(|i, request| {
        let prompt = request["messages"][0]["content"].as_str().unwrap();
        if prompt.starts_with("Combine") {
            let body = request["messages"][1]["content"][0]["text"]
                .as_str()
                .unwrap();
            let ids = Regex::new(r"branch\d+")
                .unwrap()
                .find_iter(body)
                .map(|m| m.as_str())
                .collect::<Vec<_>>()
                .join(" ");
            (0, answer(&ids))
        } else {
            (0, answer(&format!("branch{i} {}", "x".repeat(10_000))))
        }
    })
    .await;
    let req = ReadPdfRequest {
        text_model: Some(provider.config.clone()),
        ..Default::default()
    };
    let pages = (1..=12).map(|n| page(n, &"x".repeat(30_000))).collect();
    let (out, _) = summarize_with(&req, file("a.pdf", pages)).await;
    assert_eq!(
        out["summary"],
        (0..12)
            .map(|n| format!("branch{n}"))
            .collect::<Vec<_>>()
            .join(" ")
    );
    // Twelve map requests, six first-level reductions, one final reduction.
    assert_eq!(provider.requests.lock().unwrap().len(), 19);
}

#[tokio::test]
async fn group_cancellation_covers_native_summary_after_extraction() {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let tx = Mutex::new(Some(tx));
    let provider = server(move |_, _| {
        if let Some(tx) = tx.lock().unwrap().take() {
            let _ = tx.send(());
        }
        (500, answer("too late"))
    })
    .await;
    let fixtures = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/pdf");
    let group_id = format!("pdf-summary-cancel-{}", std::process::id());
    let req = ReadPdfRequest {
        paths: vec![fixtures.join("prose.pdf").to_string_lossy().into_owned()],
        allowed_roots: Some(vec![fixtures.to_string_lossy().into_owned()]),
        text_model: Some(provider.config.clone()),
        call_id: Some(format!("{group_id}-call")),
        group_id: Some(group_id.clone()),
        ..Default::default()
    };
    let call = tokio::spawn(tool_read_pdf(req));
    tokio::time::timeout(Duration::from_secs(5), rx)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        crate::tools::registry::abort_group(group_id.clone())
            .await
            .unwrap(),
        1
    );
    assert!(matches!(
        tokio::time::timeout(Duration::from_secs(1), call)
            .await
            .unwrap()
            .unwrap(),
        Err(ToolError::Aborted)
    ));
    assert_eq!(
        crate::tools::registry::abort_group(group_id).await.unwrap(),
        0
    );
}
