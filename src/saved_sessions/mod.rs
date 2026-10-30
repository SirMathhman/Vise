//! Saved sessions: a conversation's history kept in one SQLite database in the `sessions` folder, with a row per
//! session and a row per message. The system context is not saved, so a loaded session keeps the working directory
//! of the run that loads it.

mod legacy;
mod messages;
mod store;

use crate::session::SessionError;
use std::fmt;
use std::path::PathBuf;

pub use store::{import, latest, load, names, resume, save, write};
#[cfg(test)]
pub use store::{exists, list};

pub const FOLDER: &str = "sessions";

/// The database file's name, inside the sessions folder.
pub const DATABASE: &str = "sessions.db";

/// Why a session could not be listed, saved or loaded. It lives here rather than in `error` because the database
/// driver's error appears in its variants.
#[derive(Debug)]
pub enum SessionStoreError {
    InvalidName(String),
    AlreadyExists(String),
    Folder(std::io::Error),
    Open { path: PathBuf, err: rusqlite::Error },
    Read { name: String, err: rusqlite::Error },
    Write { name: String, err: rusqlite::Error },
    Decode { name: String, err: serde_json::Error },
    Shape(SessionError),
}

impl fmt::Display for SessionStoreError {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        match self {
            Self::InvalidName(name) => write!(f, "'{name}' is not a session name; use letters, digits, '-' and '_'"),
            Self::AlreadyExists(name) => write!(f, "session '{name}' already exists in sessions/{DATABASE}"),
            Self::Folder(err) => write!(f, "cannot use the sessions folder: {err}"),
            Self::Open { path, err } => {
                write!(f, "cannot open the session database '{}': {err}", path.display())
            }
            Self::Read { name, err } => write!(f, "cannot read session '{name}': {err}"),
            Self::Write { name, err } => write!(f, "cannot save session '{name}': {err}"),
            Self::Decode { name, err } => write!(f, "session '{name}' holds tool calls that cannot be read: {err}"),
            Self::Shape(err) => write!(f, "the session is not a valid history: {err}"),
        }
    }
}

impl std::error::Error for SessionStoreError {}
