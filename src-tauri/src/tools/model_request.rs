//! Shared native sub-agent protocol construction for images and PDFs.
use super::fs_ops::{build_api_url, read_bounded_vision_body};
use super::registry::ToolError;
use serde::Deserialize;
use serde_json::Value;

#[derive(Clone, Default, Deserialize)]
pub struct NativeModelConfig {
    pub server_url: String,
    pub model: String,
    pub api_key: Option<String>,
    pub api_variant: Option<String>,
    pub api_style: Option<String>,
    #[serde(default)]
    pub request_headers: Vec<(String, String)>,
}

pub(super) fn request_body(
    config: &NativeModelConfig,
    system_prompt: &str,
    user_content: Vec<Value>,
    max_tokens: Option<u32>,
    store: Option<bool>,
) -> (String, Value) {
    let variant = config.api_variant.as_deref().unwrap_or("openai");
    let is_anthropic = variant == "anthropic";
    let is_responses =
        variant == "openai" && config.api_style.as_deref().unwrap_or("chat") == "responses";
    let is_lm_studio_rest = variant == "lm-studio";
    // Build the request body per variant.
    let (chat_url, mut body) = if is_anthropic {
        let url = format!("{}/messages", config.server_url.trim_end_matches('/'));
        let mut anthropic_content: Vec<serde_json::Value> = Vec::new();
        for part in &user_content {
            let mut p = part.clone();
            if p["type"].as_str() == Some("image_url") {
                p["type"] = serde_json::json!("image");
                if let Some(data_url) = p["image_url"]["url"].as_str() {
                    let mime = data_url
                        .strip_prefix("data:")
                        .and_then(|s| s.split(';').next())
                        .unwrap_or("image/jpeg");
                    let b64 = data_url.split("base64,").nth(1).unwrap_or(data_url);
                    p["source"] = serde_json::json!({
                        "type": "base64",
                        "media_type": mime,
                        "data": b64,
                    });
                    p.as_object_mut().unwrap().remove("image_url");
                }
            }
            anthropic_content.push(p);
        }
        let mut b = serde_json::json!({
            "model": config.model,
            "max_tokens": max_tokens.unwrap_or(4096),
            "messages": [{
                "role": "user",
                "content": anthropic_content,
            }],
        });
        if !system_prompt.is_empty() {
            b["system"] = serde_json::json!(system_prompt);
        }
        (url, b)
    } else if is_responses {
        let url = build_api_url(&config.server_url, "responses");
        let responses_content: Vec<serde_json::Value> = user_content
            .iter()
            .map(|part| {
                let mut p = part.clone();
                if let Some(t) = p["type"].as_str() {
                    match t {
                        "text" => {
                            p["type"] = serde_json::json!("input_text");
                        }
                        "image_url" => {
                            p["type"] = serde_json::json!("input_image");
                            if let Some(url_str) = p["image_url"]["url"].as_str() {
                                p["image_url"] = serde_json::json!(url_str);
                            }
                        }
                        _ => {}
                    }
                }
                p
            })
            .collect();
        let input_msg = serde_json::json!({
            "type": "message",
            "role": "user",
            "content": responses_content
        });
        let mut b = serde_json::json!({
            "model": config.model,
            "input": [input_msg],
            "stream": false,
        });
        if !system_prompt.is_empty() {
            b["instructions"] = serde_json::json!(system_prompt);
        }
        if let Some(limit) = max_tokens {
            b["max_output_tokens"] = serde_json::json!(limit);
        }
        (url, b)
    } else if is_lm_studio_rest {
        let url = build_api_url(&config.server_url, "chat");
        let lm_content: Vec<serde_json::Value> = user_content
            .iter()
            .map(|part| {
                let mut p = part.clone();
                if let Some(t) = p["type"].as_str() {
                    match t {
                        "text" => {
                            if let Some(text) = p["text"].as_str() {
                                p["content"] = serde_json::json!(text);
                            }
                            p.as_object_mut().unwrap().remove("text");
                        }
                        "image_url" => {
                            p["type"] = serde_json::json!("image");
                            if let Some(url_str) = p["image_url"]["url"].as_str() {
                                p["data_url"] = serde_json::json!(url_str);
                            }
                            p.as_object_mut().unwrap().remove("image_url");
                        }
                        _ => {}
                    }
                }
                p
            })
            .collect();
        let mut b = serde_json::json!({
            "model": config.model,
            "input": lm_content,
            "stream": false,
        });
        if !system_prompt.is_empty() {
            b["system_prompt"] = serde_json::json!(system_prompt);
        }
        if let Some(limit) = max_tokens {
            b["max_output_tokens"] = serde_json::json!(limit);
        }
        (url, b)
    } else {
        // OpenAI Chat Completions
        let url = build_api_url(&config.server_url, "chat/completions");
        let mut messages: Vec<serde_json::Value> = Vec::new();
        messages.push(serde_json::json!({
            "role": "system",
            "content": system_prompt
        }));
        messages.push(serde_json::json!({
            "role": "user",
            "content": user_content
        }));
        let mut b = serde_json::json!({
            "model": config.model,
            "messages": messages,
            "stream": false,
        });
        if let Some(limit) = max_tokens {
            b["max_tokens"] = serde_json::json!(limit);
        }
        (url, b)
    };

    if is_responses {
        if let Some(store) = store {
            body["store"] = serde_json::json!(store);
        }
    }
    (chat_url, body)
}

/// PDF callers own one absolute deadline around this complete future,
/// including body streaming; there is no per-chunk deadline reset here.
pub(super) async fn send_model_request(
    client: &reqwest::Client,
    config: &NativeModelConfig,
    prompt: &str,
    content: Vec<Value>,
    max_tokens: u32,
) -> Result<String, ToolError> {
    let (url, body) = request_body(config, prompt, content, Some(max_tokens), Some(false));
    let mut request = client.post(url).header("Content-Type", "application/json");
    if config.api_variant.as_deref() == Some("anthropic") {
        request = request.header("anthropic-version", "2023-06-01");
        if let Some(key) = config.api_key.as_deref().filter(|s| !s.is_empty()) {
            request = request.header("x-api-key", key);
        }
    } else if let Some(key) = config.api_key.as_deref().filter(|s| !s.is_empty()) {
        request = request.bearer_auth(key);
    }
    let mut headers = reqwest::header::HeaderMap::new();
    for (name, value) in &config.request_headers {
        if let (Ok(name), Ok(value)) = (
            reqwest::header::HeaderName::from_bytes(name.as_bytes()),
            reqwest::header::HeaderValue::from_bytes(value.as_bytes()),
        ) {
            headers.insert(name, value);
        }
    }
    request = request.headers(headers);
    let response = request
        .json(&body)
        .send()
        .await
        .map_err(|e| ToolError::Io(format!("Model request failed: {e}")))?;
    let status = response.status();
    let bytes = read_bounded_vision_body(
        response,
        if status.is_success() {
            1024 * 1024
        } else {
            16 * 1024
        },
    )
    .await?;
    if !status.is_success() {
        return Err(ToolError::Io(format!(
            "Model returned HTTP {}: {}",
            status.as_u16(),
            String::from_utf8_lossy(&bytes)
        )));
    }
    let json: Value = serde_json::from_slice(&bytes)
        .map_err(|e| ToolError::Io(format!("Model response parse failed: {e}")))?;
    let mut texts = Vec::new();
    match config.api_variant.as_deref().unwrap_or("openai") {
        "anthropic" => {
            if let Some(parts) = json["content"].as_array() {
                for p in parts {
                    if p["type"] == "text" {
                        if let Some(s) = p["text"].as_str() {
                            texts.push(s);
                        }
                    }
                }
            }
        }
        "lm-studio" => {
            if let Some(parts) = json["output"].as_array() {
                for p in parts {
                    if p["type"] == "message" {
                        if let Some(s) = p["content"].as_str() {
                            texts.push(s);
                        }
                    }
                }
            }
        }
        _ if config.api_style.as_deref() == Some("responses") => {
            if let Some(items) = json["output"].as_array() {
                for item in items {
                    if item["type"] == "message" {
                        if let Some(parts) = item["content"].as_array() {
                            for p in parts {
                                if p["type"] == "output_text" {
                                    if let Some(s) = p["text"].as_str() {
                                        texts.push(s);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        _ => {
            if let Some(s) = json["choices"][0]["message"]["content"].as_str() {
                texts.push(s);
            }
        }
    }
    Ok(texts.concat())
}
