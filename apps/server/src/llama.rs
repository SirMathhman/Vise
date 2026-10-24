use serde::Deserialize;
use serde_json::Value;

use crate::config::Config;
use crate::error::AppError;

#[derive(Debug, Deserialize, Clone)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Deserialize)]
pub struct ChatRequest {
    pub messages: Vec<ChatMessage>,
}

#[derive(Debug, Deserialize)]
pub struct ChatResponse {
    pub content: String,
}

pub async fn chat_completion(
    client: &reqwest::Client,
    config: &Config,
    messages: Vec<Value>,
) -> Result<String, AppError> {
    let body = serde_json::json!({
        "model": config.llama_model,
        "messages": messages,
    });

    let resp = client
        .post(format!("{}/v1/chat/completions", config.llama_base))
        .header("Authorization", format!("Bearer {}", config.llama_api_key))
        .json(&body)
        .send()
        .await
        .map_err(|e| AppError::Upstream(e.to_string()))?;

    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| AppError::Upstream(e.to_string()))?;

    if !status.is_success() {
        return Err(AppError::Upstream(text));
    }

    let value: Value = serde_json::from_str(&text)
        .map_err(|e| AppError::Upstream(e.to_string()))?;

    let content = value
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or("");

    Ok(content.to_string())
}
