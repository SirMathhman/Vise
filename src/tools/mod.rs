pub mod list_directory;
pub mod path;
pub mod types;

use std::path::{Path, PathBuf};
use types::{ToolCall, ToolError, ToolRunner, ToolSpec};

pub struct WorkspaceTools {
    cwd: PathBuf,
}

impl WorkspaceTools {
    pub fn new(cwd: PathBuf) -> Self {
        Self { cwd }
    }
}

impl ToolRunner for WorkspaceTools {
    fn run(&self, call: &ToolCall) -> Result<String, ToolError> {
        execute(call, &self.cwd)
    }
}

const SPECS: &[ToolSpec] = &[list_directory::SPEC];

pub fn specs() -> &'static [ToolSpec] {
    SPECS
}

fn execute(call: &ToolCall, cwd: &Path) -> Result<String, ToolError> {
    if call.name == list_directory::SPEC.name {
        list_directory::run(&call.arguments, cwd)
    } else {
        Err(ToolError::UnknownTool(call.name.clone()))
    }
}
