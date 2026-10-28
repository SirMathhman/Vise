//! The default model: the name `/model NAME` chose, kept in `model.txt` in the working directory. `main` applies it at
//! each launch.

use std::fs;
use std::io;

const FILE: &str = "model.txt";

/// The saved model name, or `None` when no default has been chosen.
pub fn load() -> io::Result<Option<String>> {
    match fs::read_to_string(FILE) {
        Ok(text) => Ok(Some(text.trim().to_string()).filter(|name| !name.is_empty())),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err),
    }
}

/// Saves `name` as the default model, replacing any earlier one.
pub fn save(name: &str) -> io::Result<()> {
    fs::write(FILE, name)
}
