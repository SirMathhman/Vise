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

/// The largest `AGENTS.md` that is sent. It is part of the system message, which compaction never removes, so
/// a larger file would overflow every request.
const MAX_INSTRUCTIONS_BYTES: u64 = 16 * 1024;

/// The text of `AGENTS.md` in `cwd`, or `None` if there is no such file. A file that is too large, or that
/// cannot be read, is an error, so it is never dropped without a report.
pub fn instructions(cwd: &Path) -> Result<Option<String>, String> {
    let path = cwd.join(INSTRUCTIONS_FILE);
    let size = match fs::metadata(&path) {
        Ok(meta) => meta.len(),
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(format!("cannot read {}: {err}", path.display())),
    };
    if size > MAX_INSTRUCTIONS_BYTES {
        return Err(format!("{} is {size} bytes; the limit is {MAX_INSTRUCTIONS_BYTES}", path.display()));
    }
    fs::read_to_string(&path).map(Some).map_err(|err| format!("cannot read {}: {err}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn instructions_are_read_from_the_working_directory() {
        let dir = std::env::temp_dir().join(format!("vise-instructions-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        assert!(instructions(&dir).unwrap().is_none());
        fs::write(dir.join(INSTRUCTIONS_FILE), "be brief").unwrap();
        assert_eq!(instructions(&dir).unwrap().as_deref(), Some("be brief"));
        fs::remove_dir_all(&dir).unwrap();
    }
}
