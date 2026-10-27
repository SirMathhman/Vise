//! Saved sessions: a conversation's history kept as a `.json` file in the `sessions` folder. The system context
//! is not saved, so a loaded session keeps the working directory of the run that loads it.

use crate::session::Message;
use crate::tools::types::{ToolCall, Value};
use serde::{Deserialize, Serialize};
use serde_json::Value as Json;
use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::PathBuf;

const FOLDER: &str = "sessions";

#[derive(Serialize, Deserialize)]
struct File {
    messages: Vec<Saved>,
}

#[derive(Serialize, Deserialize)]
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

#[derive(Serialize, Deserialize)]
struct SavedCall {
    id: String,
    name: String,
    arguments: HashMap<String, Json>,
}

/// The session names, sorted: the `.json` files in the folder without their extension. A folder that does
/// not exist has no sessions.
pub fn names() -> Result<Vec<String>, String> {
    let entries = match fs::read_dir(FOLDER) {
        Ok(entries) => entries,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(format!("cannot read the sessions folder: {err}")),
    };
    let mut names: Vec<String> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter_map(|file| file.strip_suffix(".json").map(str::to_string))
        .collect();
    names.sort();
    Ok(names)
}

/// Writes the history to the session's file, replacing any earlier save under the same name. Only letters,
/// digits, '-' and '_' are accepted in a name, so a name cannot reach outside the folder.
pub fn save(name: &str, history: &[Message]) -> Result<(), String> {
    check_name(name)?;
    let text = encode(history)?;
    fs::create_dir_all(FOLDER).map_err(|err| format!("cannot create the sessions folder: {err}"))?;
    fs::write(PathBuf::from(FOLDER).join(format!("{name}.json")), text)
        .map_err(|err| format!("cannot save session '{name}': {err}"))
}

/// Reads the history of a saved session.
pub fn load(name: &str) -> Result<Vec<Message>, String> {
    check_name(name)?;
    let text = fs::read_to_string(PathBuf::from(FOLDER).join(format!("{name}.json")))
        .map_err(|err| format!("cannot read session '{name}': {err}"))?;
    decode(&text)
}

fn check_name(name: &str) -> Result<(), String> {
    let valid = !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if valid { Ok(()) } else { Err(format!("'{name}' is not a session name; use letters, digits, '-' and '_'")) }
}

/// The JSON text for a history. The history never holds a system message, so one is skipped if given.
fn encode(history: &[Message]) -> Result<String, String> {
    let messages = history.iter().filter_map(saved).collect();
    serde_json::to_string_pretty(&File { messages }).map_err(|err| format!("cannot encode the session: {err}"))
}

fn decode(text: &str) -> Result<Vec<Message>, String> {
    let file: File = serde_json::from_str(text).map_err(|err| format!("cannot read the session file: {err}"))?;
    Ok(file.messages.into_iter().map(message).collect())
}

fn saved(message: &Message) -> Option<Saved> {
    Some(match message {
        Message::System(_) => return None,
        Message::User(content) => Saved::User { content: content.clone() },
        Message::Assistant { content, tool_calls } => Saved::Assistant {
            content: content.clone(),
            tool_calls: tool_calls
                .iter()
                .map(|call| SavedCall {
                    id: call.id.clone(),
                    name: call.name.clone(),
                    arguments: call.arguments.iter().map(|(key, value)| (key.clone(), to_json(value))).collect(),
                })
                .collect(),
        },
        Message::Tool { call_id, content } => Saved::Tool { call_id: call_id.clone(), content: content.clone() },
    })
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn history_round_trips_with_tool_calls_and_arguments() {
        let call = ToolCall {
            id: "call_1".into(),
            name: "read_file".into(),
            arguments: HashMap::from([
                ("path".to_string(), Value::Text("a.txt".into())),
                ("limit".to_string(), Value::Integer(5)),
                ("recursive".to_string(), Value::Bool(true)),
            ]),
        };
        let history = vec![
            Message::User("read it".into()),
            Message::Assistant { content: String::new(), tool_calls: vec![call] },
            Message::Tool { call_id: "call_1".into(), content: "hello".into() },
            Message::Assistant { content: "done".into(), tool_calls: Vec::new() },
        ];
        let decoded = decode(&encode(&history).expect("encodes")).expect("decodes");
        assert_eq!(decoded.len(), 4);
        assert_eq!(decoded[0].content(), "read it");
        assert_eq!(decoded[1].tool_calls()[0].id, "call_1");
        assert!(matches!(&decoded[1].tool_calls()[0].arguments["limit"], Value::Integer(5)));
        assert!(matches!(&decoded[1].tool_calls()[0].arguments["recursive"], Value::Bool(true)));
        assert_eq!(decoded[2].tool_call_id(), Some("call_1"));
        assert_eq!(decoded[3].content(), "done");
    }

    #[test]
    fn load_rejects_names_that_leave_the_folder() {
        let error = load("../secret").err().expect("expected the name to be rejected");
        assert!(error.contains("is not a session name"));
    }
}
