//! One message as the messages table holds it: the role, the content, and either the call a tool result answers or a
//! reply's tool calls, as JSON text. A system message is never stored.

use super::SessionStoreError;
use crate::session::Message;
use crate::tools::types::{ToolCall, Value};
use rusqlite::Connection;
use serde_json::Value as Json;
use std::collections::HashMap;

/// A message as the table holds it, ready for an insert.
pub struct Saved {
    role: &'static str,
    content: String,
    call_id: Option<String>,
    tool_calls: Option<String>,
}

impl Saved {
    /// The stored form of `message`, or None for a system message, which is never stored.
    pub fn of(message: &Message) -> Result<Option<Self>, serde_json::Error> {
        Ok(Some(match message {
            Message::System(_) => return Ok(None),
            Message::User(content) => Self { role: "user", content: content.clone(), call_id: None, tool_calls: None },
            Message::Assistant { content, tool_calls } => Self {
                role: "assistant",
                content: content.clone(),
                call_id: None,
                tool_calls: match tool_calls.is_empty() {
                    true => None,
                    false => {
                        let calls: Vec<SavedCall> = tool_calls.iter().map(SavedCall::of).collect();
                        Some(serde_json::to_string(&calls)?)
                    }
                },
            },
            Message::Tool { call_id, content } => Self {
                role: "tool",
                content: content.clone(),
                call_id: Some(call_id.clone()),
                tool_calls: None,
            },
        }))
    }

    /// The history's rows in order, which is what a session insert writes. A system message contributes no row.
    pub fn rows(history: &[Message]) -> Result<Vec<Self>, serde_json::Error> {
        let mut rows = Vec::new();
        for message in history {
            if let Some(row) = Self::of(message)? {
                rows.push(row);
            }
        }
        Ok(rows)
    }

    pub fn role(&self) -> &'static str {
        self.role
    }

    pub fn content(&self) -> &str {
        &self.content
    }

    pub fn call_id(&self) -> Option<&str> {
        self.call_id.as_deref()
    }

    pub fn tool_calls(&self) -> Option<&str> {
        self.tool_calls.as_deref()
    }
}

/// A row read from the table. `message` turns it back into a message, refusing one whose calls cannot be read.
pub struct Row {
    pub role: String,
    pub content: String,
    pub call_id: Option<String>,
    pub tool_calls: Option<String>,
}

impl Row {
    pub fn message(self, name: &str) -> Result<Message, SessionStoreError> {
        Ok(match self.role.as_str() {
            "user" => Message::User(self.content),
            "assistant" => Message::Assistant {
                tool_calls: match self.tool_calls {
                    Some(text) => {
                        let calls: Vec<SavedCall> = serde_json::from_str(&text)
                            .map_err(|err| SessionStoreError::Decode { name: name.to_string(), err })?;
                        calls.into_iter().map(SavedCall::into_call).collect()
                    }
                    None => Vec::new(),
                },
                content: self.content,
            },
            "system" => Message::System(self.content),
            _ => Message::Tool { call_id: self.call_id.unwrap_or_default(), content: self.content },
        })
    }
}

/// The rows of the session `name`, in the order they were written.
pub fn read(connection: &Connection, name: &str) -> rusqlite::Result<Vec<Row>> {
    let mut statement = connection.prepare(
        "SELECT role, content, call_id, tool_calls FROM messages WHERE session = ?1 ORDER BY position",
    )?;
    statement
        .query_map([name], |row| {
            Ok(Row { role: row.get(0)?, content: row.get(1)?, call_id: row.get(2)?, tool_calls: row.get(3)? })
        })?
        .collect()
}

#[derive(serde::Serialize, serde::Deserialize)]
struct SavedCall {
    id: String,
    name: String,
    arguments: HashMap<String, Json>,
}

impl SavedCall {
    fn of(call: &ToolCall) -> Self {
        Self {
            id: call.id.clone(),
            name: call.name.clone(),
            arguments: call.arguments.iter().map(|(key, value)| (key.clone(), to_json(value))).collect(),
        }
    }

    fn into_call(self) -> ToolCall {
        ToolCall {
            id: self.id,
            name: self.name,
            arguments: self.arguments.into_iter().map(|(key, value)| (key, from_json(value))).collect(),
        }
    }
}

/// `Unsupported` has no JSON counterpart of its own, so it is stored as null and read back the same way.
fn to_json(value: &Value) -> Json {
    match value {
        Value::Text(text) => Json::String(text.clone()),
        Value::Integer(number) => Json::from(*number),
        Value::Bool(flag) => Json::Bool(*flag),
        Value::Unsupported => Json::Null,
    }
}

fn from_json(value: Json) -> Value {
    match value {
        Json::String(text) => Value::Text(text),
        Json::Number(number) => number.as_i64().map_or(Value::Unsupported, Value::Integer),
        Json::Bool(flag) => Value::Bool(flag),
        _ => Value::Unsupported,
    }
}
