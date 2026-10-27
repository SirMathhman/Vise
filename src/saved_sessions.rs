//! Saved sessions: a conversation's history kept as a `.json` file in the `sessions` folder. The system context
//! is not saved, so a loaded session keeps the working directory of the run that loads it.

use crate::error::SessionError;
use crate::session::{self, Message};
use crate::tools::types::{ToolCall, Value};
use serde::{Deserialize, Serialize};
use serde_json::Value as Json;
use std::collections::HashMap;
use std::fmt;
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

/// Why a session could not be listed, saved or loaded.
#[derive(Debug)]
pub enum SessionFileError {
    InvalidName(String),
    AlreadyExists(String),
    Folder(io::Error),
    Read { name: String, err: io::Error },
    Write { name: String, err: io::Error },
    Encode(serde_json::Error),
    Decode(serde_json::Error),
    Shape(SessionError),
}

impl fmt::Display for SessionFileError {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        match self {
            Self::InvalidName(name) => write!(f, "'{name}' is not a session name; use letters, digits, '-' and '_'"),
            Self::AlreadyExists(name) => {
                write!(f, "session '{name}' already exists; delete sessions/{name}.json to replace it")
            }
            Self::Folder(err) => write!(f, "cannot use the sessions folder: {err}"),
            Self::Read { name, err } => write!(f, "cannot read session '{name}': {err}"),
            Self::Write { name, err } => write!(f, "cannot save session '{name}': {err}"),
            Self::Encode(err) => write!(f, "cannot encode the session: {err}"),
            Self::Decode(err) => write!(f, "cannot read the session file: {err}"),
            Self::Shape(err) => write!(f, "the session file is not a valid history: {err}"),
        }
    }
}

impl std::error::Error for SessionFileError {}

/// The session names, sorted: the `.json` files in the folder without their extension, leaving out any name
/// `load` would refuse. A folder that does not exist has no sessions.
pub fn names() -> Result<Vec<String>, SessionFileError> {
    let entries = match fs::read_dir(FOLDER) {
        Ok(entries) => entries,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(SessionFileError::Folder(err)),
    };
    Ok(listed(entries.filter_map(Result::ok).filter_map(|entry| entry.file_name().into_string().ok())))
}

fn listed(files: impl Iterator<Item = String>) -> Vec<String> {
    let mut names: Vec<String> = files
        .filter_map(|file| file.strip_suffix(".json").map(str::to_string))
        .filter(|name| check_name(name).is_ok())
        .collect();
    names.sort();
    names
}

/// Checks that a session can be saved under `name`: the name is valid and no session has it yet. The REPL asks
/// for approval only after this passes.
pub fn check_save(name: &str) -> Result<(), SessionFileError> {
    check_name(name)?;
    if file(name).exists() {
        return Err(SessionFileError::AlreadyExists(name.to_string()));
    }
    Ok(())
}

/// Writes the history as a new session. The text goes to a temporary file that is then renamed into place, so an
/// interrupted save leaves no partial session. Only letters, digits, '-' and '_' are accepted in a name, so a name
/// cannot reach outside the folder.
pub fn save(name: &str, history: &[Message]) -> Result<(), SessionFileError> {
    check_save(name)?;
    let text = encode(history)?;
    fs::create_dir_all(FOLDER).map_err(SessionFileError::Folder)?;
    let target = file(name);
    let temporary = target.with_extension("json.tmp");
    fs::write(&temporary, text)
        .and_then(|()| fs::rename(&temporary, &target))
        .map_err(|err| SessionFileError::Write { name: name.to_string(), err })
}

/// Reads the history of a saved session.
pub fn load(name: &str) -> Result<Vec<Message>, SessionFileError> {
    check_name(name)?;
    let text = fs::read_to_string(file(name)).map_err(|err| SessionFileError::Read { name: name.to_string(), err })?;
    decode(&text)
}

fn file(name: &str) -> PathBuf {
    PathBuf::from(FOLDER).join(format!("{name}.json"))
}

fn check_name(name: &str) -> Result<(), SessionFileError> {
    let valid = !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if valid { Ok(()) } else { Err(SessionFileError::InvalidName(name.to_string())) }
}

/// The JSON text for a history. The history never holds a system message, so one is skipped if given.
fn encode(history: &[Message]) -> Result<String, SessionFileError> {
    let messages = history.iter().filter_map(saved).collect();
    serde_json::to_string_pretty(&File { messages }).map_err(SessionFileError::Encode)
}

/// Parses a session file and checks that its history has a valid shape, so a bad file is refused before it
/// replaces the conversation.
fn decode(text: &str) -> Result<Vec<Message>, SessionFileError> {
    let parsed: File = serde_json::from_str(text).map_err(SessionFileError::Decode)?;
    let history: Vec<Message> = parsed.messages.into_iter().map(message).collect();
    session::check_history(&history).map_err(SessionFileError::Shape)?;
    Ok(history)
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
    fn encode_skips_a_system_message() {
        let text = encode(&[Message::System("context".into())]).expect("encodes");
        assert!(decode(&text).expect("decodes").is_empty());
    }

    #[test]
    fn decode_rejects_a_tool_result_without_its_call() {
        let text = r#"{"messages":[{"role":"tool","call_id":"c","content":"x"}]}"#;
        assert!(matches!(decode(text).err(), Some(SessionFileError::Shape(_))));
    }

    #[test]
    fn listing_leaves_out_names_that_load_refuses() {
        let files = ["a.json", "my notes.json", "b.txt", "c.json.tmp"].map(String::from);
        assert_eq!(listed(files.into_iter()), vec!["a".to_string()]);
    }

    #[test]
    fn load_rejects_names_that_leave_the_folder() {
        let error = load("../secret").err().expect("expected the name to be rejected");
        assert!(matches!(error, SessionFileError::InvalidName(_)));
    }
}
