//! Compaction. When the conversation nears the context window, Strata summarizes it and the summary is
//! appended to the log. The log is never edited or truncated: a request sends the latest summary and
//! the messages after it. The summary request is appended after those messages, so the prefix they
//! form stays the same and the prompt cache still applies.

use serde_json::{Value, json};

use crate::grammar;
use crate::strata::{self, Config, Message, Role, StrataError};

/// The model's context window in tokens (`n_ctx` from `/v1/models`).
const CONTEXT_TOKENS: usize = 131_072;
/// Summarize once the messages sent reach this estimated size.
const SUMMARY_AT_TOKENS: usize = CONTEXT_TOKENS * 3 / 4;
/// Estimate only. Vise does not read Strata's real token counts.
const CHARS_PER_TOKEN: usize = 3;
const SUMMARY_REQUEST: &str = "Summarize this conversation so it can be continued later. Keep the user's goals, decisions, file paths, and open tasks. Answer with the summary only.";

/// After a failed attempt, this many more messages must be added before trying again.
const RETRY_AFTER_MESSAGES: usize = 10;

/// The entry to append after a finished turn: a new summary, a record of a failed attempt, or
/// nothing if the conversation is still small enough.
pub fn after_turn(messages: &[Message], config: &Config) -> Option<Message> {
    if !needs_summary(messages) {
        return None;
    }
    Some(match summarize(messages, config) {
        Ok(content) => Message { role: Role::Summary, content },
        Err(err) => Message { role: Role::SummaryFailed, content: err.to_string() },
    })
}

/// Whether the messages that would be sent now are large enough to summarize, and whether enough
/// has been added since the last failed attempt to try again.
pub fn needs_summary(messages: &[Message]) -> bool {
    if let Some(failed_at) = messages.iter().rposition(|m| matches!(m.role, Role::SummaryFailed))
        && messages.len() - failed_at <= RETRY_AFTER_MESSAGES
    {
        return false;
    }
    let chars: usize = since_last_summary(messages).iter().map(|m| m.content.len()).sum();
    chars / CHARS_PER_TOKEN >= SUMMARY_AT_TOKENS
}

/// Asks the model to summarize the messages that would be sent now. The request is appended after
/// them. Tool calls are forbidden so the reply is text only.
pub fn summarize(messages: &[Message], config: &Config) -> Result<String, StrataError> {
    request_summary(strata::message_items(since_last_summary(messages), config), config)
}

/// Whether the working items of one turn have grown past the threshold.
pub fn turn_needs_summary(items: &[Value]) -> bool {
    let chars: usize = items.iter().map(|item| item.to_string().len()).sum();
    chars / CHARS_PER_TOKEN >= SUMMARY_AT_TOKENS
}

/// Summarizes the working items of a turn. Nothing is logged; the summary only replaces those items.
pub fn summarize_turn(items: &[Value], config: &Config) -> Result<String, StrataError> {
    request_summary(items.to_vec(), config)
}

/// The working items to carry on with after a turn-level summary: the leading system items (the
/// working directory and any log summary), the summary, and a prompt to go on.
pub fn continue_turn(items: &[Value], summary: String) -> Vec<Value> {
    let mut next: Vec<Value> = items
        .iter()
        .take_while(|item| item["role"] == "system")
        .cloned()
        .collect();
    next.push(json!({ "role": "system", "content": format!("Summary of this turn so far:\n{summary}") }));
    next.push(json!({ "role": "user", "content": "Continue the task from the summary above." }));
    next
}

/// Sends `items` followed by the summary request, with tool calls forbidden so the reply is text.
fn request_summary(mut items: Vec<Value>, config: &Config) -> Result<String, StrataError> {
    items.push(json!({ "role": "user", "content": SUMMARY_REQUEST }));
    let text_only = grammar::enabled_calls_only(&[]);
    let reply = strata::stream_reply(&items, config, Some(&text_only), &mut |_| {})?;
    if reply.content.trim().is_empty() {
        return Err(StrataError::Malformed {
            url: config.url.clone(),
            reason: "the summary was empty".to_owned(),
        });
    }
    Ok(reply.content)
}

/// The messages a request sends: from the latest summary on, or all of them if there is none.
fn since_last_summary(messages: &[Message]) -> &[Message] {
    let start = messages
        .iter()
        .rposition(|message| matches!(message.role, Role::Summary))
        .unwrap_or(0);
    &messages[start..]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(role: Role, chars: usize) -> Message {
        Message {
            role,
            content: "x".repeat(chars),
        }
    }

    #[test]
    fn summary_is_needed_only_when_the_sent_messages_are_large() {
        let big = SUMMARY_AT_TOKENS * CHARS_PER_TOKEN;

        assert!(needs_summary(&[message(Role::User, big)]));
        assert!(!needs_summary(&[message(Role::User, 100)]));
    }

    #[test]
    fn a_failed_attempt_waits_for_more_messages_before_retrying() {
        let big = SUMMARY_AT_TOKENS * CHARS_PER_TOKEN;
        let mut log = vec![message(Role::User, big), message(Role::SummaryFailed, 20)];

        assert!(!needs_summary(&log));
        for _ in 0..RETRY_AFTER_MESSAGES {
            log.push(message(Role::User, 1));
        }
        assert!(needs_summary(&log));
    }

    #[test]
    fn continuing_a_turn_keeps_the_leading_system_items_and_adds_the_summary() {
        let items = vec![
            json!({ "role": "system", "content": "working dir" }),
            json!({ "role": "user", "content": "task" }),
            json!({ "role": "tool", "content": "lots of output" }),
        ];
        let next = continue_turn(&items, "done so far".to_owned());

        assert_eq!(next.len(), 3);
        assert_eq!(next[0]["content"], "working dir");
        assert!(next[1]["content"].as_str().unwrap().ends_with("done so far"));
        assert_eq!(next[2]["role"], "user");
    }

    #[test]
    fn messages_before_a_summary_are_not_counted_or_sent() {
        let big = SUMMARY_AT_TOKENS * CHARS_PER_TOKEN;
        let log = [
            message(Role::User, big),
            message(Role::Summary, 100),
            message(Role::User, 100),
        ];

        assert!(!needs_summary(&log));
        assert_eq!(since_last_summary(&log).len(), 2);
    }
}
