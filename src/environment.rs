use std::fs;
use std::io;
use std::path::{Path, PathBuf};

pub struct Environment {
    pub cwd: PathBuf,
}

/// The file of standing instructions for the model, read from the working directory.
const INSTRUCTIONS_FILE: &str = "AGENTS.md";

pub fn gather() -> io::Result<Environment> {
    Ok(Environment { cwd: std::env::current_dir()? })
}

/// The text of `AGENTS.md` in `cwd`. A missing or unreadable file gives nothing, so the session starts
/// without it.
pub fn instructions(cwd: &Path) -> Option<String> {
    fs::read_to_string(cwd.join(INSTRUCTIONS_FILE)).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn instructions_are_read_from_the_working_directory() {
        let dir = std::env::temp_dir().join(format!("vise-instructions-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        assert!(instructions(&dir).is_none());
        fs::write(dir.join(INSTRUCTIONS_FILE), "be brief").unwrap();
        assert_eq!(instructions(&dir).as_deref(), Some("be brief"));
        fs::remove_dir_all(&dir).unwrap();
    }
}
