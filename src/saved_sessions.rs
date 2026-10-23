//! Saving and loading conversations. A saved session is a JSON file at `.vise/sessions/<name>.json` in the working
//! directory. It holds the messages and the switched-off tools the model has been told about. The tool switches
//! themselves are not saved, so a loaded conversation announces any difference from the switches as they are now.

use std::collections::BTreeSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use crate::session::Session;
use crate::strata::{Message, Role};
use crate::workspace;

const SESSIONS_DIR: &str = ".vise/sessions";

pub struct Saved {
    pub messages: Vec<Message>,
    pub told: BTreeSet<String>,
}

/// Handles `/save <name>`, `/load <name>`, and `/sessions`. Returns the text to show, or `None` if the line is not
/// one of these commands. A load replaces the session's conversation.
pub fn command(line: &str, session: &mut Session, working: Option<&Path>) -> Option<String> {
    let mut words = line.split_whitespace();
    let command = words.next()?;
    let name = words.next();
    let result = match (command, name) {
        ("/save", Some(name)) => save(working, name, session.messages(), session.told()),
        ("/load", Some(name)) => load(working, name).map(|saved| {
            let count = saved.messages.len();
            session.restore(saved.messages, saved.told);
            format!("Loaded session {name} ({count} messages).")
        }),
        ("/sessions", None) => list(working).map(|names| {
            if names.is_empty() {
                "No saved sessions.".to_owned()
            } else {
                names.join("\n")
            }
        }),
        ("/save" | "/load", None) => Err(format!("usage: {command} <name>")),
        ("/sessions", Some(_)) => Err("usage: /sessions".to_owned()),
        _ => return None,
    };
    Some(result.unwrap_or_else(|err| format!("error: {err}")))
}

/// Writes the conversation as session `name`, replacing any session already saved under that name.
pub fn save(working: Option<&Path>, name: &str, messages: &[Message], told: &BTreeSet<String>) -> Result<String, String> {
    let path = session_path(working, name)?;
    let replaced = path.exists();
    let folder = path.parent().ok_or_else(|| format!("cannot save session {name}"))?;
    fs::create_dir_all(folder).map_err(|err| format!("could not create {SESSIONS_DIR}: {err}"))?;
    fs::write(&path, to_value(messages, told).to_string())
        .map_err(|err| format!("could not write session {name}: {err}"))?;
    Ok(if replaced {
        format!("Replaced session {name}.")
    } else {
        format!("Saved session {name}.")
    })
}

pub fn load(working: Option<&Path>, name: &str) -> Result<Saved, String> {
    let path = session_path(working, name)?;
    let text = fs::read_to_string(&path).map_err(|err| format!("could not read session {name}: {err}"))?;
    let data: Value = serde_json::from_str(&text).map_err(|err| format!("session {name} is not valid JSON: {err}"))?;
    from_value(&data).map_err(|err| format!("session {name}: {err}"))
}

/// The names of the saved sessions, sorted. A missing folder means there are none.
pub fn list(working: Option<&Path>) -> Result<Vec<String>, String> {
    let root = working.ok_or("no working directory is set, so sessions are unavailable")?;
    let entries = match fs::read_dir(root.join(SESSIONS_DIR)) {
        Ok(entries) => entries,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(format!("could not read {SESSIONS_DIR}: {err}")),
    };
    let mut names = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|err| format!("could not read {SESSIONS_DIR}: {err}"))?;
        let file = entry.file_name().to_string_lossy().into_owned();
        if let Some(name) = file.strip_suffix(".json") {
            names.push(name.to_owned());
        }
    }
    names.sort();
    Ok(names)
}

/// The JSON form of a conversation, as it is written to a session file and sent to the web page.
pub fn to_value(messages: &[Message], told: &BTreeSet<String>) -> Value {
    let items: Vec<Value> = messages
        .iter()
        .map(|message| json!({ "role": message.role.name(), "content": message.content }))
        .collect();
    json!({ "messages": items, "told": told })
}

fn from_value(data: &Value) -> Result<Saved, String> {
    let items = data
        .get("messages")
        .and_then(Value::as_array)
        .ok_or("expected a messages array")?;
    let messages = items
        .iter()
        .map(|item| -> Result<Message, String> {
            let role = item
                .get("role")
                .and_then(Value::as_str)
                .and_then(Role::from_name)
                .ok_or("each message needs a known role")?;
            let content = item
                .get("content")
                .and_then(Value::as_str)
                .ok_or("each message needs string content")?;
            Ok(Message { role, content: content.to_owned() })
        })
        .collect::<Result<Vec<Message>, String>>()?;
    let told = data
        .get("told")
        .and_then(Value::as_array)
        .ok_or("expected a told array")?
        .iter()
        .map(|name| name.as_str().map(str::to_owned).ok_or("told must list tool names"))
        .collect::<Result<BTreeSet<String>, _>>()?;
    Ok(Saved { messages, told })
}

/// The file a session name stands for. The name is checked before it becomes a path, so it cannot leave the folder.
fn session_path(working: Option<&Path>, name: &str) -> Result<PathBuf, String> {
    let root = working.ok_or("no working directory is set, so sessions are unavailable")?;
    let plain = !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !plain {
        return Err(format!("a session name may only use letters, digits, '-' and '_': {name:?}"));
    }
    workspace::resolve(Some(root), &format!("{SESSIONS_DIR}/{name}.json"), false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder(test: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("vise-sessions-{test}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn message(role: Role, content: &str) -> Message {
        Message { role, content: content.to_owned() }
    }

    #[test]
    fn a_saved_session_loads_with_its_messages_and_told_set() {
        let root = folder("round-trip");
        let messages = vec![message(Role::Profile, "Be brief."), message(Role::User, "hi"), message(Role::Assistant, "hello")];
        let told = BTreeSet::from(["delete_file".to_owned()]);
        save(Some(&root), "first", &messages, &told).unwrap();
        let loaded = load(Some(&root), "first");
        fs::remove_dir_all(&root).unwrap();

        let loaded = loaded.unwrap();
        let roles: Vec<&str> = loaded.messages.iter().map(|m| m.role.name()).collect();
        assert_eq!(roles, ["profile", "user", "assistant"]);
        assert_eq!(loaded.messages[2].content, "hello");
        assert_eq!(loaded.told, told);
    }

    #[test]
    fn names_are_checked_before_they_become_paths() {
        let root = folder("names");
        let refused = ["", "../escape", "a b", "x/y"].map(|name| save(Some(&root), name, &[], &BTreeSet::new()).is_err());
        fs::remove_dir_all(&root).unwrap();

        assert_eq!(refused, [true; 4]);
    }

    #[test]
    fn listing_is_empty_without_a_folder_and_sorted_with_one() {
        let root = folder("list");
        let empty = list(Some(&root)).unwrap();
        save(Some(&root), "beta", &[], &BTreeSet::new()).unwrap();
        save(Some(&root), "alpha", &[], &BTreeSet::new()).unwrap();
        let names = list(Some(&root)).unwrap();
        fs::remove_dir_all(&root).unwrap();

        assert!(empty.is_empty());
        assert_eq!(names, ["alpha", "beta"]);
    }

    #[test]
    fn the_commands_save_load_and_list_the_session() {
        let root = folder("commands");
        let mut session = Session::new();
        session.push(Role::User, "first question".to_owned());
        let saved = command("/save work", &mut session, Some(&root));
        session.reset();
        let listed = command("/sessions", &mut session, Some(&root));
        let loaded = command("/load work", &mut session, Some(&root));
        let usage = command("/load", &mut session, Some(&root));
        fs::remove_dir_all(&root).unwrap();

        assert_eq!(saved.as_deref(), Some("Saved session work."));
        assert_eq!(listed.as_deref(), Some("work"));
        assert_eq!(loaded.as_deref(), Some("Loaded session work (1 messages)."));
        assert_eq!(session.messages()[0].content, "first question");
        assert_eq!(usage.as_deref(), Some("error: usage: /load <name>"));
        assert_eq!(command("hello", &mut session, Some(&root)), None);
    }

    #[test]
    fn a_session_file_that_is_not_a_session_is_refused() {
        let root = folder("bad-file");
        fs::create_dir_all(root.join(SESSIONS_DIR)).unwrap();
        fs::write(root.join(".vise/sessions/broken.json"), r#"{"messages":[{"role":"wizard","content":"x"}],"told":[]}"#).unwrap();
        let loaded = load(Some(&root), "broken");
        fs::remove_dir_all(&root).unwrap();

        assert!(loaded.err().unwrap().contains("known role"));
    }
}
