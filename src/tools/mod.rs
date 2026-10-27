pub mod list_directory;
pub mod path;
pub mod read_file;
pub mod types;

use std::path::PathBuf;
use types::{Arguments, Invocation, ToolError, ToolRunner, ToolSpec};

/// Maps a validated set of arguments to the typed invocation for the named tool.
pub fn bind(name: &str, args: &Arguments) -> Result<Invocation, ToolError> {
    if name == list_directory::SPEC.name {
        Ok(Invocation::ListDirectory {
            path: args.text("path")?.to_string(),
            depth: u8::try_from(args.integer("depth")?).map_err(|_| ToolError::InvalidArguments("'depth' is out of range".into()))?,
        })
    } else if name == read_file::SPEC.name {
        Ok(Invocation::ReadFile {
            path: args.text("path")?.to_string(),
            start: usize::try_from(args.integer("start")?).map_err(|_| ToolError::InvalidArguments("'start' is out of range".into()))?,
            end: usize::try_from(args.integer("end")?).map_err(|_| ToolError::InvalidArguments("'end' is out of range".into()))?,
        })
    } else {
        Err(ToolError::UnknownTool(name.to_string()))
    }
}

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
