use axum::extract::State;
use axum::Json;
use serde_json::json;

use crate::error::AppError;
use crate::llama::{chat_completion, ChatRequest};

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
) -> Result<Json<serde_json::Value>, AppError> {
    let system = format!(
        "You are Vise, a local-first chat assistant. Your current working directory is: {}",
        state.cwd
    );

    let messages = std::iter::once(json!({
        "role": "system",
        "content": system,
    }))
    .chain(req.messages.iter().map(|m| json!({
        "role": m.role,
        "content": m.content,
    })))
    .collect::<Vec<_>>();

    let content = chat_completion(&state.client, &state.config, messages).await?;

    Ok(Json(json!({ "content": content })))
}
