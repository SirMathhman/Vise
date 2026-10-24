use serde::Deserialize;
use serde_json::{json, Value};

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

/// A single tool call requested by the model.
#[derive(Debug, Clone, Deserialize)]
pub struct ToolCall {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: Option<String>,
    pub function: ToolFunction,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ToolFunction {
    pub name: String,
    pub arguments: String,
}

/// The assistant's reply: text content and/or tool calls.
#[derive(Debug, Clone, Deserialize)]
pub struct AssistantReply {
    pub content: Option<String>,
    pub tool_calls: Option<Vec<ToolCall>>,
}

pub async fn chat_completion(
    client: &reqwest::Client,
    config: &Config,
    messages: Vec<Value>,
    tools: Option<Value>,
) -> Result<AssistantReply, AppError> {
    let mut body = serde_json::json!({
        "model": config.llama_model,
        "messages": messages,
    });
    if let Some(tools) = tools {
        body["tools"] = tools;
        body["tool_choice"] = json!("auto");
    }

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

    let message = value
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .cloned()
        .unwrap_or(Value::Null);

    let content = message
        .get("content")
        .and_then(|c| c.as_str())
        .map(str::to_string);

    let tool_calls = message
        .get("tool_calls")
        .and_then(|tc| tc.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|tc| {
                    let id = tc.get("id")?.as_str()?.to_string();
                    let name = tc.get("function")?.get("name")?.as_str()?.to_string();
                    let arguments = tc
                        .get("function")?
                        .get("arguments")?
                        .as_str()?
                        .to_string();
                    Some(ToolCall {
                        id,
                        kind: None,
                        function: ToolFunction { name, arguments },
                    })
                })
                .collect()
        });

    Ok(AssistantReply { content, tool_calls })
}