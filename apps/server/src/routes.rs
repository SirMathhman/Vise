use axum::extract::State;
use axum::Json;
use serde_json::{json, Value};

use crate::agent::{run_agent, AgentResult};
use crate::error::AppError;
use crate::llama::ChatRequest;

#[derive(Clone)]
pub struct AppState {
    pub client: reqwest::Client,
    pub config: crate::config::Config,
    pub cwd: String,
}

pub async fn health() -> &'static str {
    "ok"
}

pub async fn chat(
    State(state): State<AppState>,
    Json(req): Json<ChatRequest>,
) -> Result<Json<Value>, AppError> {
    let system = format!(
        "You are Vise, a local-first chat assistant. Your current working directory is: {}. \
         You have access to tools. When you need to call a tool, respond with a tool call; \
         the result will be provided to you so you can continue.",
        state.cwd
    );

    let mut messages = vec![json!({
        "role": "system",
        "content": system,
    })];
    for m in &req.messages {
        messages.push(json!({
            "role": m.role,
            "content": m.content,
        }));
    }

    let result: AgentResult = run_agent(&state, &mut messages).await?;

    Ok(Json(serde_json::to_value(&result).map_err(|e| AppError::Internal(e.to_string()))?))
}