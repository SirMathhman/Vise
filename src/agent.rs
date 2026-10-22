use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::{Value, json};

use crate::compaction;
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
    cancel: &AtomicBool,
    on_chunk: &mut dyn FnMut(Chunk),
) -> Result<String, StrataError> {
    let mut items = strata::message_items(messages, config);
    let mut ran: Vec<String> = Vec::new();
    for _ in 0..MAX_TOOL_ROUNDS {
        if cancel.load(Ordering::Relaxed) {
            return Err(StrataError::Stopped { ran });
        }
        // Tool results can grow a turn past the window, so the turn is summarized in place. The
        // summary is not logged, so the history is unchanged.
        if compaction::turn_needs_summary(&items) {
            let summary = compaction::summarize_turn(&items, config, cancel).map_err(|err| with_ran(err, &ran))?;
            items = compaction::continue_turn(&items, summary);
        }
        let disabled = switches.snapshot();
        // The grammar is sent only while a tool is off, so normal decoding is untouched otherwise.
        let grammar = (!disabled.is_empty()).then(|| {
            let enabled: Vec<&str> = tools::NAMES
                .iter()
                .copied()
                .filter(|name| !disabled.contains(*name))
                .collect();
            // A lazy grammar leaves prose and reasoning unconstrained and starts at the first call. With every tool
            // off there is no call to allow, so the full grammar keeps calls out instead.
            if config.lazy_grammar && !enabled.is_empty() {
                (grammar::enabled_calls_after_trigger(&enabled), true)
            } else {
                (grammar::enabled_calls_only(&enabled), false)
            }
        });
        let constraint = grammar
            .as_ref()
            .map(|(text, lazy)| strata::Constraint { grammar: text, lazy: *lazy });
        let reply = strata::stream_reply(&items, config, constraint, cancel, on_chunk).map_err(|err| with_ran(err, &ran))?;
        if reply.tool_calls.is_empty() {
            return Ok(reply.content);
        }

        items.push(assistant_item(&reply.content, &reply.tool_calls));
        for call in &reply.tool_calls {
            on_chunk(Chunk::Tool(&format!("{} {}", call.name, call.arguments)));
            if cancel.load(Ordering::Relaxed) {
                return Err(StrataError::Stopped { ran });
            }
            let result = if disabled.contains(&call.name) {
                format!("error: tool {} is disabled", call.name)
            } else if compaction::turn_needs_summary(&items) {
                // Stop the round from growing the turn past the window; the next round summarizes it.
                "error: context is full; the turn will be summarized before the next call".to_owned()
            } else {
                let root = config.working_dir.as_deref().map(Path::new);
                ran.push(format!("{} {}", call.name, call.arguments));
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

/// Adds the tool calls that already ran to a stop that came from the stream or a summary.
fn with_ran(err: StrataError, ran: &[String]) -> StrataError {
    match err {
        StrataError::Stopped { .. } => StrataError::Stopped { ran: ran.to_vec() },
        other => other,
    }
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
