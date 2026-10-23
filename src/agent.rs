use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::{Value, json};

use crate::compaction;
use crate::grammar;
use crate::strata::{self, Chunk, Config, Message, StrataError, ToolCall};
use crate::subagent;
use crate::tools::{self, Switches};
use crate::turn::{TurnError, turn_error};

#[cfg(test)]
use crate::subagent::subagent_switches;
#[cfg(test)]
use std::collections::BTreeSet;

const MAX_TOOL_ROUNDS: usize = 8;
/// Runs one user turn: streams the model's reply and runs any tools it asks for, repeating until
/// it answers without a tool call. Returns the final answer text. Tool activity goes to `on_chunk`.
pub fn run_turn(
    messages: &[Message],
    config: &Config,
    switches: &Switches,
    cancel: &AtomicBool,
    on_chunk: &mut dyn FnMut(Chunk),
) -> Result<String, TurnError> {
    let mut items = strata::message_items(messages, config);
    let mut ran: Vec<String> = Vec::new();
    for _ in 0..MAX_TOOL_ROUNDS {
        if cancel.load(Ordering::Relaxed) {
            return Err(TurnError::Stopped { ran });
        }
        // Tool results can grow a turn past the window, so the turn is summarized in place. The
        // summary is not logged, so the history is unchanged.
        if compaction::turn_needs_summary(&items) {
            let summary = compaction::summarize_turn(&items, config, cancel).map_err(|err| turn_error(err, &ran))?;
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
        let reply = strata::stream_reply(&items, config, constraint, cancel, on_chunk)
            .map_err(|err| turn_error(err, &ran))?;
        if reply.tool_calls.is_empty() {
            return Ok(reply.content);
        }

        items.push(assistant_item(&reply.content, &reply.tool_calls));
        for call in &reply.tool_calls {
            // A subagent announces itself with its own chunks, so it gets no tool line.
            if call.name != tools::RUN_SUBAGENT {
                on_chunk(Chunk::Tool(&format!("{} {}", call.name, call.arguments)));
            }
            if cancel.load(Ordering::Relaxed) {
                return Err(TurnError::Stopped { ran });
            }
            let result = if disabled.contains(&call.name) {
                format!("error: tool {} is disabled", call.name)
            } else if compaction::turn_needs_summary(&items) {
                // Stop the round from growing the turn past the window; the next round summarizes it.
                "error: context is full; the turn will be summarized before the next call".to_owned()
            } else if call.name == tools::RUN_SUBAGENT {
                ran.push(format!("{} {}", call.name, call.arguments));
                match subagent::run_subagent(&call.arguments, config, switches, cancel, on_chunk, run_turn) {
                    Ok(answer) => answer,
                    // A stopped subagent stops this turn too, and the calls it ran are still listed.
                    Err(TurnError::Stopped { ran: steps }) => {
                        ran.extend(steps);
                        return Err(TurnError::Stopped { ran });
                    }
                    Err(err) => {
                        ran.extend(err.ran().iter().cloned());
                        format!("error: subagent failed: {err}")
                    }
                }
            } else {
                let root = config.working_dir.as_deref().map(Path::new);
                match tools::call(&call.name, &call.arguments, root, switches, cancel, on_chunk) {
                    tools::Outcome::Ran(text) => {
                        ran.push(format!("{} {}", call.name, call.arguments));
                        text
                    }
                    // An undone edit no longer changes anything, so it is not listed as having run.
                    tools::Outcome::Undone(text) => text,
                    tools::Outcome::Stopped => return Err(TurnError::Stopped { ran }),
                }
            };
            items.push(json!({ "role": "tool", "tool_call_id": call.id, "content": result }));
        }
    }
    Err(TurnError::Failed {
        ran,
        cause: StrataError::Malformed {
            url: config.url.clone(),
            reason: format!("more than {MAX_TOOL_ROUNDS} tool rounds in one turn"),
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_profile_with_a_tool_list_gets_exactly_those_tools() {
        let listed = ["list_files".to_owned()];
        let off = subagent_switches(Some(&listed), &BTreeSet::new()).snapshot();

        assert!(!off.contains("list_files"));
        assert!(off.contains("read_file"));
        assert!(off.contains(tools::RUN_SUBAGENT));
    }

    #[test]
    fn a_profile_without_a_tool_list_keeps_the_parent_switches() {
        let parent = BTreeSet::from(["delete_file".to_owned()]);
        let off = subagent_switches(None, &parent).snapshot();

        assert!(off.contains("delete_file"));
        assert!(!off.contains("list_files"));
        assert!(off.contains(tools::RUN_SUBAGENT));
    }

    #[test]
    fn a_failure_after_a_tool_round_still_lists_the_call_that_ran() {
        let ran = vec!["delete_file x.txt".to_owned()];
        let err = turn_error(
            StrataError::Network { url: "u".to_owned(), cause: "down".to_owned() },
            &ran,
        );

        assert!(matches!(err, TurnError::Failed { .. }));
        assert_eq!(err.ran(), ran.as_slice());
    }

    #[test]
    fn a_stream_stop_becomes_a_stop_with_the_same_calls() {
        let ran = vec!["list_files .".to_owned()];
        let err = turn_error(StrataError::Stopped, &ran);

        assert!(matches!(err, TurnError::Stopped { .. }));
        assert_eq!(err.ran(), ran.as_slice());
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
