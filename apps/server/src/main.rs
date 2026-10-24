use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::Value;
use tokio::net::TcpListener;

mod config;

use config::Config;

#[derive(Clone)]
struct AppState {
    client: reqwest::Client,
    config: Config,
}

#[derive(Deserialize)]
struct ChatRequest {
    message: String,
}

async fn health() -> &'static str {
    "ok"
}

async fn chat(
    State(state): State<AppState>,
    Json(req): Json<ChatRequest>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let cfg = &state.config;
    let body = serde_json::json!({
        "model": cfg.llama_model,
        "messages": [{ "role": "user", "content": req.message }],
    });

    let resp = state
        .client
        .post(format!("{}/v1/chat/completions", cfg.llama_base))
        .header("Authorization", format!("Bearer {}", cfg.llama_api_key))
        .json(&body)
        .send()
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;

    let status = resp.status();
    let text = resp.text().await.map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;

    if !status.is_success() {
        return Err((StatusCode::BAD_GATEWAY, text));
    }

    let value: Value = serde_json::from_str(&text)
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;

    let content = value
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or("");

    Ok(Json(serde_json::json!({ "content": content })))
}

#[tokio::main]
async fn main() {
    dotenv::dotenv().ok();
    let config = Config::from_env().expect("failed to load config");

    let state = AppState {
        client: reqwest::Client::new(),
        config,
    };

    let port = state.config.server_port;

    let app = Router::new()
        .route("/health", get(health))
        .route("/api/chat", post(chat))
        .with_state(state);

    let addr = format!("127.0.0.1:{port}");
    let listener = TcpListener::bind(&addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

