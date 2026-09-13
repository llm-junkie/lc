//! Native PDF map/reduce and public-result assembly. Page images never leave Rust.
use super::super::model_request::{send_model_request, NativeModelConfig};
use super::*;
use regex::Regex;
use serde_json::{json, Value};
use std::{future::Future, sync::OnceLock};

pub(super) const SUMMARY_MAX_TOKENS: u32 = 4_000;
const SUMMARY_MAX_BYTES: usize = 64 * 1024;
const SUMMARY_PROMPT: &str = include_str!("summary-prompt.txt");
const REDUCE_PROMPT: &str = include_str!("reduce-prompt.txt");
const SUMMARY_WARNING: &str =
    "The summary is a paraphrase and may omit details. It is not exact wording from the document.";

pub(super) struct SummaryContext<'a> {
    pub req: &'a ReadPdfRequest,
    pub client: Option<&'a reqwest::Client>,
    pub deadline: Instant,
    pub token: &'a CancellationToken,
}

pub(super) fn active(token: &CancellationToken, deadline: Instant) -> Result<(), ToolError> {
    if token.is_cancelled() {
        Err(ToolError::Aborted)
    } else if Instant::now() >= deadline {
        Err(ToolError::Timeout)
    } else {
        Ok(())
    }
}

pub(super) async fn within_deadline<T>(
    token: &CancellationToken,
    deadline: Instant,
    work: impl Future<Output = Result<T, ToolError>>,
) -> Result<T, ToolError> {
    active(token, deadline)?;
    let result = tokio::select! {
        biased;
        _ = token.cancelled() => Err(ToolError::Aborted),
        _ = tokio::time::sleep_until(deadline.into()) => Err(ToolError::Timeout),
        result = work => result,
    };
    active(token, deadline)?;
    result
}

fn text<'a>(v: &'a Value, field: &str) -> &'a str {
    v[field].as_str().unwrap_or("")
}
fn flag(v: &Value, field: &str) -> bool {
    v[field].as_bool().unwrap_or(false)
}
fn tokens(s: &str) -> usize {
    s.encode_utf16().count().div_ceil(4)
}
fn has_image(p: &Value) -> bool {
    !text(p, "data_url").is_empty()
}

fn page_header(p: &Value) -> String {
    let mut bits = vec![format!("--- Page {} ---", p["page"])];
    bits.push(
        if text(p, "provenance") == "text_layer" {
            "(text below is from the PDF text layer)"
        } else {
            "(no text layer — anything reported for this page is read from the image)"
        }
        .into(),
    );
    if flag(p, "image_rendered") {
        bits.push(format!(
            "(page image attached. Reason: {})",
            p["render_reason"].as_str().unwrap_or("unknown")
        ));
    } else if let Some(reason) = p["planned_render_reason"]
        .as_str()
        .filter(|s| !s.is_empty())
    {
        let skipped = p["render_skipped"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(|s| format!(" Reason: {s}."))
            .unwrap_or_default();
        bits.push(format!("(LC needed a page image for {reason}. LC did not produce it.{skipped} Visual content on this page is NOT represented.)"));
    }
    if let Some(tables) = p["tables_md"].as_array().filter(|t| !t.is_empty()) {
        bits.push(format!("({} table(s): cell text is from the text layer, row/column structure is inferred and may be wrong)", tables.len()));
    }
    bits.join(" ")
}

fn page_cost(p: &Value) -> usize {
    tokens(&page_header(p))
        + tokens(text(p, "text"))
        + p["tables_md"]
            .as_array()
            .map(|t| {
                t.iter()
                    .map(|s| tokens(s.as_str().unwrap_or("")) + 8)
                    .sum::<usize>()
            })
            .unwrap_or(0)
}

/// Indices avoid duplicating rendered payloads while planning overlapping chunks.
fn chunks(pages: &[Value], instruction: Option<&str>) -> Vec<Vec<usize>> {
    let reserved = instruction
        .filter(|s| !s.is_empty())
        .map(|s| tokens(s) + 8)
        .unwrap_or(0);
    let budget = 6000usize.saturating_sub(reserved).max(1);
    let mut out = Vec::new();
    let mut current: Vec<usize> = Vec::new();
    let (mut cost, mut images) = (0, 0);
    for (i, p) in pages.iter().enumerate() {
        let next = page_cost(p);
        if !current.is_empty() && (cost + next > budget || (has_image(p) && images + 1 > 4)) {
            let tail = *current.last().unwrap();
            out.push(std::mem::take(&mut current));
            if page_cost(&pages[tail]) + next <= budget {
                current.push(tail);
            }
            cost = if current.is_empty() {
                0
            } else {
                page_cost(&pages[tail])
            };
            images = usize::from(!current.is_empty() && has_image(&pages[tail]));
        }
        current.push(i);
        cost += next;
        images += usize::from(has_image(p));
    }
    if !current.is_empty() {
        out.push(current);
    }
    out
}

fn reduce_groups(partials: &[String]) -> Vec<Vec<String>> {
    let mut out = Vec::new();
    let mut group = Vec::new();
    let mut cost = 0;
    for p in partials {
        let next = tokens(p) + 8;
        if !group.is_empty() && cost + next > 6000 {
            out.push(std::mem::take(&mut group));
            cost = 0;
        }
        group.push(p.clone());
        cost += next;
    }
    if !group.is_empty() {
        out.push(group);
    }
    out
}

fn chunk_content(pages: &[Value], selected: &[usize], instruction: Option<&str>) -> Vec<Value> {
    let mut parts = Vec::new();
    if let Some(s) = instruction.filter(|s| !s.is_empty()) {
        parts.push(json!({"type":"text","text":format!("Focus: {s}")}));
    }
    for &i in selected {
        let p = &pages[i];
        let mut body = vec![page_header(p)];
        if !text(p, "text").trim().is_empty() {
            body.push(text(p, "text").into());
        }
        if let Some(tables) = p["tables_md"].as_array() {
            for table in tables {
                body.push(format!(
                    "Table (cell text exact, structure inferred):\n{}",
                    table.as_str().unwrap_or("")
                ));
            }
        }
        parts.push(json!({"type":"text","text":body.join("\n")}));
        if has_image(p) {
            parts.push(json!({"type":"image_url","image_url":{"url":p["data_url"]}}));
        }
    }
    parts
}

fn normalize_summary(output: String) -> Result<Option<String>, ToolError> {
    static MISSING: OnceLock<Vec<Regex>> = OnceLock::new();
    let missing = MISSING.get_or_init(|| [
        r"(?i)^(?:(?:to\s+(?:summarize|combine)[^,]{0,120},\s*)?)(?:please|kindly)\s+(?:provide|share|paste|upload|supply)\b",
        r"(?i)\b(?:actual\s+)?(?:content|text|pages?|section summaries|summaries)\s+(?:was|were|has been|have been)\s+not\s+(?:provided|included|supplied)\b",
        r"(?i)^(?:i\s+)?(?:cannot|can't|am unable to|do not have enough information to)\s+(?:summarize|combine)\b[^.]{0,240}\b(?:without|missing|not provided|not supplied)\b",
    ].iter().map(|s| Regex::new(s).expect("fixed PDF regex")).collect());
    let visible = output.trim();
    if visible.is_empty() || missing.iter().any(|r| r.is_match(visible)) {
        return Ok(None);
    }
    if visible.len() > SUMMARY_MAX_BYTES {
        return Err(ToolError::TooLarge(format!("The PDF sub-agent returned {} UTF-8 bytes. The tool limit is {SUMMARY_MAX_BYTES} bytes. Select another model or narrow the request.",visible.len())));
    }
    Ok(Some(visible.into()))
}

fn issue(error: &ToolError) -> String {
    let s = error.to_string();
    if s.len() <= 16 * 1024 {
        return s;
    }
    let mut end = 16 * 1024 - 80;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    format!(
        "{}\n… [error message truncated at 16384 UTF-8 bytes]\n",
        &s[..end]
    )
}

fn empty_warning(scope: &str, vision: bool) -> String {
    let label = if vision {
        "Model for image analyze"
    } else {
        "Model for PDF summarize"
    };
    format!("{scope} produced no usable visible summary. The model may have spent the whole response on hidden reasoning or asked for input it already received. Select a different \"{label}\" in Settings, or retry with a narrower page range.")
}

fn exact_warning(path: &str, total: u64, include_text: bool) -> String {
    let mut s = format!("{path}: {SUMMARY_WARNING}");
    if !include_text {
        let span = if total > 1 {
            format!("1-{total}")
        } else {
            "1".into()
        };
        s.push_str(&format!(" For exact wording or omitted details, call lc_read_pdf again with the same path, include_text:true, and a bounded pages range within {span}."));
    }
    s
}

impl SummaryContext<'_> {
    async fn call(
        &self,
        vision: bool,
        prompt: &str,
        content: Vec<Value>,
    ) -> Result<Option<String>, ToolError> {
        active(self.token, self.deadline)?;
        let model: &NativeModelConfig = (if vision {
            self.req.vision_model.as_ref()
        } else {
            self.req.text_model.as_ref()
        })
        .ok_or_else(|| {
            ToolError::Io(format!(
                "No {} model is configured. Select one in Settings.",
                if vision {
                    "image analysis"
                } else {
                    "PDF summary"
                }
            ))
        })?;
        let output = within_deadline(
            self.token,
            self.deadline,
            send_model_request(
                self.client
                    .ok_or_else(|| ToolError::Io("No PDF model client is available.".into()))?,
                model,
                prompt,
                content,
                SUMMARY_MAX_TOKENS,
            ),
        )
        .await?;
        normalize_summary(output)
    }

    async fn summarize(
        &self,
        pages: &[Value],
        path: &str,
        warnings: &mut Vec<String>,
    ) -> Result<Option<String>, ToolError> {
        let mut partials = Vec::new();
        for selected in chunks(pages, self.req.instruction.as_deref()) {
            active(self.token, self.deadline)?;
            let scope = format!(
                "{path}: summarizing pages {}-{}",
                pages[selected[0]]["page"],
                pages[*selected.last().unwrap()]["page"]
            );
            let vision = selected.iter().any(|&i| has_image(&pages[i]));
            match self
                .call(
                    vision,
                    SUMMARY_PROMPT,
                    chunk_content(pages, &selected, self.req.instruction.as_deref()),
                )
                .await
            {
                Ok(Some(s)) => partials.push(s),
                Ok(None) => warnings.push(empty_warning(&scope, vision)),
                Err(e @ (ToolError::Aborted | ToolError::Timeout)) => return Err(e),
                Err(e) => warnings.push(format!("{scope} failed: {}", issue(&e))),
            }
        }
        if partials.is_empty() {
            warnings.push(format!("{path}: no usable visible summary was produced for any selected page. The summary field is null. Select another summary model or narrow the page range."));
            return Ok(None);
        }
        while partials.len() > 1 {
            active(self.token, self.deadline)?;
            let groups = reduce_groups(&partials);
            if groups.len() >= partials.len() {
                warnings.push(format!("{path}: section summaries could not be combined within the reduce context budget. No document-level summary was produced."));
                return Ok(None);
            }
            let mut next = Vec::new();
            for group in groups {
                if group.len() == 1 {
                    next.push(group.into_iter().next().unwrap());
                    continue;
                }
                let body = group
                    .iter()
                    .enumerate()
                    .map(|(i, s)| format!("--- Section {} ---\n{s}", i + 1))
                    .collect::<Vec<_>>()
                    .join("\n\n");
                match self
                    .call(
                        false,
                        REDUCE_PROMPT,
                        vec![json!({"type":"text","text":body})],
                    )
                    .await
                {
                    Ok(Some(s)) => next.push(s),
                    Ok(None) => {
                        warnings.push(format!(
                            "{} No document-level summary was produced.",
                            empty_warning(&format!("{path}: combining section summaries"), false)
                        ));
                        return Ok(None);
                    }
                    Err(e @ (ToolError::Aborted | ToolError::Timeout)) => return Err(e),
                    Err(e) => {
                        warnings.push(format!("{path}: combining section summaries failed: {}. No document-level summary was produced.",issue(&e)));
                        return Ok(None);
                    }
                }
            }
            partials = next;
        }
        Ok(partials.pop())
    }

    pub(super) async fn file(
        &self,
        mut file: Value,
        depth: &str,
    ) -> Result<(Value, Vec<String>), ToolError> {
        active(self.token, self.deadline)?;
        let path = text(&file, "path").to_string();
        let pages = match file.as_object_mut().and_then(|f| f.remove("pages")) {
            Some(Value::Array(p)) => p,
            _ => Vec::new(),
        };
        let mut warnings = Vec::new();
        let include_text =
            !self.req.summarize.unwrap_or(true) || self.req.include_text.unwrap_or(false);
        let failed = !file["error"].is_null();
        let scanned = !pages.is_empty() && !flag(&file, "has_text_layer") && depth == "text_only";
        let summary = if failed || pages.is_empty() {
            None
        } else if scanned {
            let recovery = if self.req.vision_available.unwrap_or(true) {
                "Re-call with summarize:true and depth=\"full\" for visual interpretation."
            } else {
                "Configure a vision-capable model, then re-call with summarize:true and depth=\"full\"."
            };
            warnings.push(format!(
                "{path}: no text layer found — this looks like a scan. {recovery}"
            ));
            None
        } else if !self.req.summarize.unwrap_or(true) {
            None
        } else if self.req.text_model.is_none() && self.req.vision_model.is_none() {
            warnings.push(format!("{path}: no sub-agent model is available, so no summary was produced. Per-page text is available via include_text."));
            None
        } else {
            self.summarize(&pages, &path, &mut warnings).await?
        };
        active(self.token, self.deadline)?;
        if summary.is_some() {
            warnings.push(exact_warning(
                &path,
                file["pages_total"].as_u64().unwrap_or(0),
                include_text,
            ));
        }
        let processed: Vec<Value> = pages.iter().map(|p| p["page"].clone()).collect();
        let public:Vec<Value>=pages.into_iter().map(|p| json!({
            "page":p["page"],"chars":p["chars"],"provenance":p["provenance"],"kind":p["kind"],
            "image_rendered":p["image_rendered"],"render_reason":p["render_reason"],"planned_render_reason":p["planned_render_reason"],
            "render_skipped":p["render_skipped"],"tables_md":p["tables_md"].as_array().cloned().unwrap_or_default(),
            "text":if include_text {Value::String(text(&p,"text").into())} else {Value::Null},"error":p["error"]
        })).collect();
        Ok((
            json!({"path":path,"pages_total":file["pages_total"].as_u64().unwrap_or(0),"pages_processed":processed,
            "has_text_layer":flag(&file,"has_text_layer"),"depth":depth,"summary":summary,"pages":public,
            "pages_rendered":file["pages_rendered"].as_u64().unwrap_or(0),"truncated":flag(&file,"truncated"),"error":file["error"]}),
            warnings,
        ))
    }
}

#[cfg(test)]
mod tests;
