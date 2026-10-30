//! The format sessions were saved in before the database: a JSON file per session. The structs are frozen, so a
//! change to the live message model cannot make them refuse an old file.

use super::SessionStoreError;
use crate::session::{self, Message};
use crate::tools::types::{Value, ToolCall};
use serde::Deserialize;
use serde_json::Value as Json;
use std::collections::HashMap;

#[derive(Deserialize)]
struct File {
    messages: Vec<Saved>,
}

#[derive(Deserialize)]
#[serde(tag = "role", rename_all = "snake_case")]
enum Saved {
    User { content: String },
    Assistant {
        content: String,
        #[serde(default)]
        tool_calls: Vec<SavedCall>,
    },
    Tool { call_id: String, content: String },
}

#[derive(Deserialize)]
struct SavedCall {
    id: String,
    name: String,
    arguments: HashMap<String, Json>,
}

/// The history a session file holds, checked for a valid history's shape. A file that cannot be read is refused,
/// so a bad one leaves no session behind.
pub fn decode(text: &str) -> Result<Vec<Message>, SessionStoreError> {
    let parsed: File = serde_json::from_str(text)
        .map_err(|err| SessionStoreError::Decode { name: "session file".into(), err })?;
    let history: Vec<Message> = parsed.messages.into_iter().map(message).collect();
    session::check_history(&history).map_err(SessionStoreError::Shape)?;
    Ok(history)
}

fn message(saved: Saved) -> Message {
    match saved {
        Saved::User { content } => Message::User(content),
        Saved::Assistant { content, tool_calls } => Message::Assistant {
            content,
            tool_calls: tool_calls
                .into_iter()
                .map(|call| ToolCall {
                    id: call.id,
                    name: call.name,
                    arguments: call.arguments.into_iter().map(|(key, value)| (key, from_json(value))).collect(),
                })
                .collect(),
        },
        Saved::Tool { call_id, content } => Message::Tool { call_id, content },
    }
}

/// `Unsupported` has no JSON counterpart of its own, so it was stored as null and reads back the same way.
fn from_json(value: Json) -> Value {
    match value {
        Json::String(text) => Value::Text(text),
        Json::Number(number) => number.as_i64().map_or(Value::Unsupported, Value::Integer),
        Json::Bool(flag) => Value::Bool(flag),
        _ => Value::Unsupported,
    }
}
