//! The sessions database: its schema, the transactional write of one session, and the reads, all over `folder`'s
//! `sessions.db`. Only this module opens a connection.

use super::legacy;
use super::messages::{self, Saved};
use super::{SessionStoreError, DATABASE, FOLDER};
use crate::session::{self, Message};
use rusqlite::{params, Connection, OptionalExtension};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS sessions (
    name TEXT PRIMARY KEY,
    saved_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
    session TEXT NOT NULL REFERENCES sessions(name) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
    content TEXT NOT NULL,
    call_id TEXT,
    tool_calls TEXT,
    PRIMARY KEY (session, position)
);
";

/// The session names in the sessions folder, sorted.
pub fn names() -> Result<Vec<String>, SessionStoreError> {
    list(Path::new(FOLDER))
}

/// The session names stored in `folder`, sorted. A folder or database that does not exist has no sessions.
pub fn list(folder: &Path) -> Result<Vec<String>, SessionStoreError> {
    let path = database(folder);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let connection = open(&path)?;
    let mut statement = connection
        .prepare("SELECT name FROM sessions ORDER BY name")
        .map_err(|err| SessionStoreError::Read { name: DATABASE.to_string(), err })?;
    let stored = statement
        .query_map([], |row| row.get::<_, String>(0))
        .and_then(|rows| rows.collect::<Result<Vec<String>, _>>())
        .map_err(|err| SessionStoreError::Read { name: DATABASE.to_string(), err })?;
    Ok(stored.into_iter().filter(|name| check_name(name).is_ok()).collect())
}

/// Checks that a session can be saved under `name`: the name is valid and no session has it yet. The REPL asks
/// for approval only after this passes.
pub fn check_save(name: &str) -> Result<(), SessionStoreError> {
    check_name(name)?;
    if exists(Path::new(FOLDER), name)? {
        return Err(SessionStoreError::AlreadyExists(name.to_string()));
    }
    Ok(())
}

/// Writes the history as a new session in the sessions folder.
pub fn save(name: &str, history: &[Message]) -> Result<(), SessionStoreError> {
    check_save(name)?;
    write(Path::new(FOLDER), name, history)
}

/// Whether the session `name` is stored in `folder`.
pub fn exists(folder: &Path, name: &str) -> Result<bool, SessionStoreError> {
    check_name(name)?;
    let path = database(folder);
    if !path.exists() {
        return Ok(false);
    }
    let connection = open(&path)?;
    let found = connection
        .query_row("SELECT 1 FROM sessions WHERE name = ?1", [name], |_| Ok(()))
        .optional()
        .map_err(|err| SessionStoreError::Read { name: name.to_string(), err })?;
    Ok(found.is_some())
}

/// Writes the history as the session `name` in `folder`, replacing any history stored under that name. The old
/// messages are removed and the new ones inserted in one transaction, so an interrupted write leaves the earlier
/// history. Only letters, digits, '-' and '_' are accepted in a name.
pub fn write(folder: &Path, name: &str, history: &[Message]) -> Result<(), SessionStoreError> {
    check_name(name)?;
    fs::create_dir_all(folder).map_err(SessionStoreError::Folder)?;
    let mut connection = open(&database(folder))?;
    replace(&mut connection, name, history).map_err(|err| SessionStoreError::Write { name: name.to_string(), err })
}

/// Reads the history of a saved session.
pub fn load(name: &str) -> Result<Vec<Message>, SessionStoreError> {
    check_name(name)?;
    let path = database(Path::new(FOLDER));
    let missing = || SessionStoreError::Read { name: name.to_string(), err: rusqlite::Error::QueryReturnedNoRows };
    if !path.exists() {
        return Err(missing());
    }
    let connection = open(&path)?;
    read(&connection, name).transpose()?.ok_or_else(missing)
}

/// Turns importable session files in `folder` into stored sessions: each `NAME.json` in the format sessions were
/// once saved as becomes the session `NAME`, unless that name is already stored. The files are left in place, so
/// an import can be repeated. Returns how many sessions were imported.
pub fn import(folder: &Path) -> Result<usize, SessionStoreError> {
    let entries = match fs::read_dir(folder) {
        Ok(entries) => entries,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(0),
        Err(err) => return Err(SessionStoreError::Folder(err)),
    };
    let importable: Vec<(String, PathBuf)> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let file = entry.file_name().into_string().ok()?;
            let name = file.strip_suffix(".json")?.to_string();
            check_name(&name).ok()?;
            Some((name, entry.path()))
        })
        .collect();
    if importable.is_empty() {
        return Ok(0);
    }
    let mut connection = open(&database(folder))?;
    let mut imported = 0;
    for (name, path) in importable {
        if stored(&connection, &name)? {
            continue;
        }
        let Ok(text) = fs::read_to_string(&path) else { continue };
        let Ok(history) = legacy::decode(&text) else { continue };
        replace(&mut connection, &name, &history).map_err(|err| SessionStoreError::Write { name, err })?;
        imported += 1;
    }
    Ok(imported)
}

fn database(folder: &Path) -> PathBuf {
    folder.join(DATABASE)
}

fn open(path: &Path) -> Result<Connection, SessionStoreError> {
    let connection = Connection::open(path).map_err(|err| SessionStoreError::Open { path: path.to_path_buf(), err })?;
    connection
        .execute_batch(&format!("PRAGMA foreign_keys = ON;\n{SCHEMA}"))
        .map_err(|err| SessionStoreError::Open { path: path.to_path_buf(), err })?;
    Ok(connection)
}

fn check_name(name: &str) -> Result<(), SessionStoreError> {
    let valid = !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if valid { Ok(()) } else { Err(SessionStoreError::InvalidName(name.to_string())) }
}

fn stored(connection: &Connection, name: &str) -> Result<bool, SessionStoreError> {
    let found = connection
        .query_row("SELECT 1 FROM sessions WHERE name = ?1", [name], |_| Ok(()))
        .optional()
        .map_err(|err| SessionStoreError::Read { name: name.to_string(), err })?;
    Ok(found.is_some())
}

/// Stores `history` as the session `name`, replacing what was stored before.
fn replace(connection: &mut Connection, name: &str, history: &[Message]) -> rusqlite::Result<()> {
    let rows = Saved::rows(history).map_err(|err| rusqlite::Error::ToSqlConversionFailure(Box::new(err)))?;
    let transaction = connection.transaction()?;
    transaction.execute("DELETE FROM messages WHERE session = ?1", [name])?;
    // An upsert rather than INSERT OR REPLACE: REPLACE deletes the conflicting row, and the cascade would then
    // delete the messages just written.
    transaction.execute(
        "INSERT INTO sessions (name, saved_at) VALUES (?1, unixepoch())
         ON CONFLICT(name) DO UPDATE SET saved_at = excluded.saved_at",
        [name],
    )?;
    {
        let mut insert = transaction.prepare(
            "INSERT INTO messages (session, position, role, content, call_id, tool_calls) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        )?;
        for (position, row) in rows.iter().enumerate() {
            let position = position as i64;
            insert.execute(params![name, position, row.role(), row.content(), row.call_id(), row.tool_calls()])?;
        }
    }
    transaction.commit()
}

/// Reads the history stored as the session `name`, or None when no session has that name. The stored messages are
/// checked for a valid history's shape, so a bad session is refused before it replaces the conversation.
fn read(connection: &Connection, name: &str) -> Option<Result<Vec<Message>, SessionStoreError>> {
    match stored(connection, name) {
        Ok(true) => {}
        Ok(false) => return None,
        Err(err) => return Some(Err(err)),
    }
    let rows = match messages::read(connection, name) {
        Ok(rows) => rows,
        Err(err) => return Some(Err(SessionStoreError::Read { name: name.to_string(), err })),
    };
    let history = match rows.into_iter().map(|row| row.message(name)).collect::<Result<Vec<Message>, _>>() {
        Ok(history) => history,
        Err(err) => return Some(Err(err)),
    };
    Some(session::check_history(&history).map_err(SessionStoreError::Shape).map(|()| history))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::types::{ToolCall, Value};
    use std::collections::HashMap;

    fn temp_folder(tag: &str) -> PathBuf {
        let folder = std::env::temp_dir().join(format!("vise-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&folder);
        folder
    }

    fn tool_history() -> Vec<Message> {
        let call = ToolCall {
            id: "call_1".into(),
            name: "read_file".into(),
            arguments: HashMap::from([
                ("path".to_string(), Value::Text("a.txt".into())),
                ("limit".to_string(), Value::Integer(5)),
                ("recursive".to_string(), Value::Bool(true)),
            ]),
        };
        vec![
            Message::User("read it".into()),
            Message::Assistant { content: String::new(), tool_calls: vec![call] },
            Message::Tool { call_id: "call_1".into(), content: "hello".into() },
            Message::Assistant { content: "done".into(), tool_calls: Vec::new() },
        ]
    }

    /// One turn that is only a message and a reply.
    fn reply(text: &str) -> Vec<Message> {
        vec![
            Message::User(text.into()),
            Message::Assistant { content: format!("{text} done"), tool_calls: Vec::new() },
        ]
    }

    fn stored_history(folder: &Path, name: &str) -> Option<Result<Vec<Message>, SessionStoreError>> {
        let connection = open(&database(folder)).expect("the database opens");
        read(&connection, name)
    }

    #[test]
    fn history_round_trips_with_tool_calls_and_arguments() {
        let folder = temp_folder("round-trip");
        write(&folder, "s", &tool_history()).expect("writes");
        let decoded = stored_history(&folder, "s").expect("the session exists").expect("decodes");
        fs::remove_dir_all(&folder).expect("the test folder is removed");
        assert_eq!(decoded.len(), 4);
        assert_eq!(decoded[0].content(), "read it");
        assert_eq!(decoded[1].tool_calls()[0].id, "call_1");
        assert!(matches!(&decoded[1].tool_calls()[0].arguments["limit"], Value::Integer(5)));
        assert!(matches!(&decoded[1].tool_calls()[0].arguments["recursive"], Value::Bool(true)));
        assert_eq!(decoded[2].tool_call_id(), Some("call_1"));
        assert_eq!(decoded[3].content(), "done");
    }

    #[test]
    fn a_system_message_is_not_stored() {
        let folder = temp_folder("system");
        write(&folder, "s", &[Message::System("context".into())]).expect("writes");
        let decoded = stored_history(&folder, "s").expect("the session exists").expect("decodes");
        fs::remove_dir_all(&folder).expect("the test folder is removed");
        assert!(decoded.is_empty());
    }

    #[test]
    fn read_reports_none_for_a_name_that_is_not_stored() {
        let folder = temp_folder("absent");
        write(&folder, "s", &reply("x")).expect("writes");
        let decoded = stored_history(&folder, "other");
        fs::remove_dir_all(&folder).expect("the test folder is removed");
        assert!(decoded.is_none());
    }

    #[test]
    fn read_rejects_a_tool_result_without_its_call() {
        let folder = temp_folder("shape");
        write(&folder, "s", &[Message::Tool { call_id: "c".into(), content: "x".into() }]).expect("writes");
        let decoded = stored_history(&folder, "s").expect("the session exists");
        fs::remove_dir_all(&folder).expect("the test folder is removed");
        assert!(matches!(decoded.err(), Some(SessionStoreError::Shape(_))));
    }

    #[test]
    fn listing_leaves_out_names_that_load_refuses() {
        let folder = temp_folder("listing");
        write(&folder, "b", &tool_history()).expect("writes b");
        write(&folder, "a", &tool_history()).expect("writes a");
        // A row whose name `load` would refuse, so it is never offered under a name that cannot be loaded.
        open(&database(&folder))
            .expect("the database opens")
            .execute("INSERT INTO sessions (name, saved_at) VALUES ('my notes', 0)", [])
            .expect("the row is inserted");
        let listed = list(&folder).expect("lists");
        fs::remove_dir_all(&folder).expect("the test folder is removed");
        assert_eq!(listed, vec!["a".to_string(), "b".to_string()]);
    }

    #[test]
    fn writing_the_same_name_replaces_the_history() {
        let folder = temp_folder("replace");
        write(&folder, "same", &reply("first")).expect("first write");
        write(&folder, "same", &reply("second")).expect("second write");
        let decoded = stored_history(&folder, "same").expect("the session exists").expect("decodes");
        fs::remove_dir_all(&folder).expect("the test folder is removed");
        assert_eq!(decoded.len(), 2);
        assert_eq!(decoded[0].content(), "second");
    }

    #[test]
    fn exists_reports_a_stored_name_and_a_missing_database() {
        let folder = temp_folder("exists");
        assert!(!exists(&folder, "same").expect("a missing database has no sessions"));
        write(&folder, "same", &reply("first")).expect("the write succeeds");
        let found = exists(&folder, "same").expect("the lookup succeeds");
        fs::remove_dir_all(&folder).expect("the test folder is removed");
        assert!(found);
    }

    #[test]
    fn a_name_with_a_separator_is_refused() {
        let folder = temp_folder("name");
        let refused = write(&folder, "a/b", &reply("x")).is_err();
        fs::remove_dir_all(&folder).ok();
        assert!(refused);
    }

    /// A session file in the format sessions were once saved as.
    const LEGACY: &str = r#"{"messages":[
{"role":"user","content":"read it"},
{"role":"assistant","content":"","tool_calls":[{"id":"call_1","name":"read_file","arguments":{"path":"a.txt","limit":5}}]},
{"role":"tool","call_id":"call_1","content":"hello"},
{"role":"assistant","content":"done","tool_calls":[]}
]}"#;

    #[test]
    fn import_turns_session_files_into_stored_sessions_once() {
        let folder = temp_folder("import");
        fs::create_dir_all(&folder).expect("the test folder is created");
        fs::write(folder.join("old.json"), LEGACY).expect("the session file is written");
        fs::write(folder.join("notes.txt"), "x").expect("a file that is not a session is written");
        let first = import(&folder).expect("imports");
        let second = import(&folder).expect("imports again");
        let decoded = stored_history(&folder, "old").expect("the session exists").expect("decodes");
        let file_kept = folder.join("old.json").exists();
        let files: Vec<String> = fs::read_dir(&folder)
            .expect("the test folder is read")
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|file| file != DATABASE)
            .collect();
        fs::remove_dir_all(&folder).expect("the test folder is removed");
        assert_eq!(first, 1);
        assert_eq!(second, 0);
        assert_eq!(decoded.len(), 4);
        assert_eq!(decoded[1].tool_calls()[0].name, "read_file");
        assert_eq!(decoded[2].tool_call_id(), Some("call_1"));
        assert!(file_kept, "the session file is left in place");
        assert_eq!(files.len(), 2, "the database is the only file added");
    }

    #[test]
    fn load_rejects_names_that_leave_the_folder() {
        let error = load("../secret").err().expect("expected the name to be rejected");
        assert!(matches!(error, SessionStoreError::InvalidName(_)));
    }
}
