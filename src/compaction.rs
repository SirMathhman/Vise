//! Compaction. When the conversation nears the context window, Strata summarizes it and the summary is
//! appended to the log. The log is never edited or truncated: a request sends the latest summary and
//! the messages after it. The summary request is appended after those messages, so the prefix they
//! form stays the same and the prompt cache still applies.

use serde_json::json;

use crate::grammar;
use crate::strata::{self, Config, Message, Role, StrataError};

/// The model's context window in tokens (`n_ctx` from `/v1/models`).
const CONTEXT_TOKENS: usize = 131_072;
/// Summarize once the messages sent reach this estimated size.
const SUMMARY_AT_TOKENS: usize = CONTEXT_TOKENS * 3 / 4;
/// Estimate only. Vise does not read Strata's real token counts.
const CHARS_PER_TOKEN: usize = 3;
const SUMMARY_REQUEST: &str = "Summarize this conversation so it can be continued later. Keep the user's goals, decisions, file paths, and open tasks. Answer with the summary only.";

/// Whether the messages that would be sent now are large enough to summarize.
pub fn needs_summary(messages: &[Message]) -> bool {
    let chars: usize = since_last_summary(messages).iter().map(|m| m.content.len()).sum();
    chars / CHARS_PER_TOKEN >= SUMMARY_AT_TOKENS
}

/// Asks the model to summarize the messages that would be sent now. The request is appended after
/// them. Tool calls are forbidden so the reply is text only.
pub fn summarize(messages: &[Message], config: &Config) -> Result<String, StrataError> {
    let mut items = strata::message_items(since_last_summary(messages), config);
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
