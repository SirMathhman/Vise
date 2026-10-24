use serde_json::{json, Value};

use crate::error::AppError;
use crate::llama::chat_completion;
use crate::routes::AppState;
use crate::tools::{execute_tool, tool_schemas};

const MAX_TURNS: usize = 10;

/// Run the agentic loop: call the model, execute any requested tools, and
/// feed results back until the model produces a final text answer.
pub async fn run_agent(
    state: &AppState,
    messages: &mut Vec<Value>,
) -> Result<String, AppError> {
    let tools = tool_schemas();

    for _ in 0..MAX_TURNS {
        let reply = chat_completion(&state.client, &state.config, messages.clone(), Some(tools.clone()))
            .await?;

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
