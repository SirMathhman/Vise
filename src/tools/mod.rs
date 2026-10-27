pub mod list_directory;
pub mod path;
pub mod read_file;
pub mod types;

use std::path::PathBuf;
use types::{Invocation, ToolError, ToolRunner, ToolSpec};

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

const SPECS: &[ToolSpec] = &[list_directory::SPEC, read_file::SPEC];

pub fn specs() -> &'static [ToolSpec] {
    SPECS
}
