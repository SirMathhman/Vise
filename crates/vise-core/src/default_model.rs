//! The default model: the name `/model NAME` chose, kept in `model.txt` in the working directory. `main` applies it at
//! each launch.

use std::fs;
use std::io;
use std::path::Path;

const FILE: &str = "model.txt";

/// The saved model name, or `None` when no default has been chosen.
pub fn load() -> io::Result<Option<String>> {
    read_default(Path::new(FILE))
}

/// Saves `name` as the default model, replacing any earlier one.
pub fn save(name: &str) -> io::Result<()> {
    write_default(Path::new(FILE), name)
}

/// The name stored at `path`, or `None` when the file is missing, empty, or only whitespace.
fn read_default(path: &Path) -> io::Result<Option<String>> {
    match fs::read_to_string(path) {
        Ok(text) => Ok(Some(text.trim().to_string()).filter(|name| !name.is_empty())),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err),
    }
}

fn write_default(path: &Path, name: &str) -> io::Result<()> {
    fs::write(path, name)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_file(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("vise-default-model-{name}-{}.txt", std::process::id()))
    }

    #[test]
    fn saved_name_is_read_back() {
        let path = temp_file("round-trip");
        write_default(&path, "a/b").unwrap();
        let read = read_default(&path).unwrap();
        fs::remove_file(&path).unwrap();
        assert_eq!(read, Some("a/b".to_string()));
    }

    #[test]
    fn empty_and_whitespace_files_are_no_default() {
        let path = temp_file("blank");
        write_default(&path, "  
").unwrap();
        let read = read_default(&path).unwrap();
        fs::remove_file(&path).unwrap();
        assert_eq!(read, None);
    }
}
