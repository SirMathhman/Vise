use axum::extract::State;
use axum::Json;
use serde_json::{json, Value};

use crate::error::AppError;
use crate::llama::{chat_completion, ChatRequest};
use crate::tools::{execute_tool, tool_schemas};

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

    let tools = tool_schemas();
    let content = run_tool_loop(&state, &mut messages, &tools).await?;

    Ok(Json(json!({ "content": content })))
}

/// Repeatedly call the model; when it requests a tool, execute it and feed
/// the result back until it produces a final text answer.
async fn run_tool_loop(
    state: &AppState,
    messages: &mut Vec<Value>,
    tools: &Value,
) -> Result<String, AppError> {
    const MAX_TURNS: usize = 10;

    for _ in 0..MAX_TURNS {
        let reply = chat_completion(&state.client, &state.config, messages.clone(), Some(tools.clone())).await?;

        let tool_calls = reply.tool_calls.clone().unwrap_or_default();
        if tool_calls.is_empty() {
            return Ok(reply.content.unwrap_or_default());
        }

        // Record the assistant's tool-call turn.
        let assistant_msg = json!({
            "role": "assistant",
            "content": reply.content.clone().unwrap_or_default(),
            "tool_calls": tool_calls.iter().map(|tc| json!({
                "id": tc.id,
                "type": "function",
                "function": {
                    "name": tc.function.name,
                    "arguments": tc.function.arguments,
                },
            })).collect::<Vec<_>>(),
        });
        messages.push(assistant_msg);

        // Execute each tool and append the results.
        for tc in &tool_calls {
            let args: Value = serde_json::from_str(&tc.function.arguments)
                .map_err(|e| AppError::BadRequest(format!("bad tool arguments: {e}")))?;
            let result = execute_tool(&tc.function.name, &args)?;
            messages.push(json!({
                "role": "tool",
                "tool_call_id": tc.id,
                "content": result,
            }));
        }
    }

    Err(AppError::Internal("tool loop exceeded max turns".into()))
}