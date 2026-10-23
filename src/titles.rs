//! Session titles. After the first turn of a web chat, the page asks for a title for its saved session. The request is
//! a throwaway: it is not part of the conversation, and only the title it returns is kept.

use std::path::Path;
use std::sync::atomic::AtomicBool;

use serde_json::json;

use crate::grammar;
use crate::saved_sessions;
use crate::strata::{self, Config, Message, StrataError};

const TITLE_REQUEST: &str = "Give this conversation a short title of at most six words. Answer with the title only.";

/// The session's title, asking the model for one only if it has none yet. The title is written into the session file.
pub fn ensure(working: Option<&Path>, name: &str, messages: &[Message], config: &Config) -> Result<String, String> {
    if let Some(title) = saved_sessions::stored_title(working, name) {
        return Ok(title);
    }
    let title = generate(messages, config).map_err(|err| err.to_string())?;
    saved_sessions::set_title(working, name, &title)?;
    Ok(title)
}

/// Sends `messages` followed by the title request, with tool calls forbidden so the reply is text.
fn generate(messages: &[Message], config: &Config) -> Result<String, StrataError> {
    let mut items = strata::message_items(messages, config);
    items.push(json!({ "role": "user", "content": TITLE_REQUEST }));
    let text_only = grammar::enabled_calls_only(&[]);
    let never = AtomicBool::new(false);
    let reply = strata::stream_reply(&items, config, Some(text_only.as_str().into()), &never, &mut |_| {})?;
    clean(&reply.content).ok_or_else(|| StrataError::Malformed {
        url: config.url.clone(),
        reason: "the title was empty".to_owned(),
    })
}

/// The first line of the reply, without the quotes or markdown marks some models put around a title.
fn clean(reply: &str) -> Option<String> {
    let line = reply.lines().map(str::trim).find(|line| !line.is_empty())?;
    let title = line.trim_matches(|c: char| "\"'`*#".contains(c)).trim();
    (!title.is_empty()).then(|| title.to_owned())
}

#[cfg(test)]
mod tests {
    use super::clean;

    #[test]
    fn the_title_is_the_first_line_without_quotes_or_marks() {
        assert_eq!(clean("  **Fixing the parser**\nMore text").as_deref(), Some("Fixing the parser"));
        assert_eq!(clean("\"Notes on tests\"").as_deref(), Some("Notes on tests"));
        assert_eq!(clean(" \n \"\" "), None);
    }
}
