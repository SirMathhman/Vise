use std::io;
use std::path::PathBuf;

pub struct Environment {
    pub cwd: PathBuf,
}

pub fn gather() -> io::Result<Environment> {
    Ok(Environment { cwd: std::env::current_dir()? })
}
