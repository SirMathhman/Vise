use super::read_file;
use super::list_directory;
use super::types::{Invocation, ToolError, ToolRunner};
use std::path::PathBuf;

pub struct WorkspaceTools {
    cwd: PathBuf,
}

impl WorkspaceTools {
    pub fn new(cwd: PathBuf) -> Self {
        Self { cwd }
    }
}

impl ToolRunner for WorkspaceTools {
    fn run(&self, invocation: &Invocation) -> Result<String, ToolError> {
        match invocation {
            Invocation::ListDirectory { path, depth } => list_directory::run(path, *depth, &self.cwd),
            Invocation::ReadFile { path, start, end } => read_file::run(path, *start, *end, &self.cwd),
        }
    }
}
