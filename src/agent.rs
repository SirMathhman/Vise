use std::path::Path;

use serde_json::{Value, json};

use crate::grammar;
use crate::strata::{self, Chunk, Config, Message, StrataError, ToolCall};
use crate::tools::{self, Switches};

const MAX_TOOL_ROUNDS: usize = 8;

/// Runs one user turn: streams the model's reply and runs any tools it asks for, repeating until
/// it answers without a tool call. Returns the final answer text. Tool activity goes to `on_chunk`.
pub fn run_turn(
    messages: &[Message],
    config: &Config,
    switches: &Switches,
    on_chunk: &mut dyn FnMut(Chunk),
) -> Result<String, StrataError> {
    let mut items = strata::message_items(messages, config);
    for _ in 0..MAX_TOOL_ROUNDS {
        let disabled = switches.snapshot();
        // The grammar is sent only while a tool is off, so normal decoding is untouched otherwise.
        let grammar = (!disabled.is_empty()).then(|| {
            let enabled: Vec<&str> = tools::NAMES
                .iter()
                .copied()
                .filter(|name| !disabled.contains(*name))
                .collect();
            grammar::enabled_calls_only(&enabled)
        });
        let reply = strata::stream_reply(&items, config, grammar.as_deref(), on_chunk)?;
        if reply.tool_calls.is_empty() {
            return Ok(reply.content);
        }

        items.push(assistant_item(&reply.content, &reply.tool_calls));
        for call in &reply.tool_calls {
            on_chunk(Chunk::Tool(&format!("{} {}", call.name, call.arguments)));
            let result = if disabled.contains(&call.name) {
                format!("error: tool {} is disabled", call.name)
            } else {
                let root = config.working_dir.as_deref().map(Path::new);
                tools::run(&call.name, &call.arguments, root)
            };
            items.push(json!({ "role": "tool", "tool_call_id": call.id, "content": result }));
        }
    }
    Err(StrataError::Malformed {
        url: config.url.clone(),
        reason: format!("more than {MAX_TOOL_ROUNDS} tool rounds in one turn"),
    })
}

fn assistant_item(content: &str, calls: &[ToolCall]) -> Value {
    let tool_calls: Vec<Value> = calls
        .iter()
        .map(|call| {
            json!({
                "id": call.id,
                "type": "function",
                "function": { "name": call.name, "arguments": call.arguments },
            })
        })
        .collect();
    json!({ "role": "assistant", "content": content, "tool_calls": tool_calls })
}
