use super::types::{Invocation, ToolError, ToolRunner};
use super::{create_directory, create_file, edit_file, list_directory, read_file};
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
    fn run(&self, invocation: &Invocation, approve: &mut dyn FnMut(&str) -> bool) -> Result<String, ToolError> {
        if invocation.writes() && !approve(&describe(invocation)) {
            return Err(ToolError::Failed("the user declined this change".into()));
        }
        match invocation {
            Invocation::ListDirectory { path, depth } => list_directory::run(path, *depth, &self.cwd),
            Invocation::ReadFile { path, start, end } => read_file::run(path, *start, *end, &self.cwd),
            Invocation::CreateFile { path, content } => create_file::run(path, content, &self.cwd),
            Invocation::CreateDirectory { path } => create_directory::run(path, &self.cwd),
            Invocation::EditFile { path, previous, new } => edit_file::run(path, previous, new, &self.cwd),
        }
    }
}

/// Describes a write so the user can decide whether to allow it.
fn describe(invocation: &Invocation) -> String {
    match invocation {
        Invocation::CreateFile { path, content } => format!("create file '{path}' with:\n{content}"),
        Invocation::CreateDirectory { path } => format!("create directory '{path}'"),
        Invocation::EditFile { path, previous, new } => format!("edit '{path}':\n- {previous}\n+ {new}"),
        Invocation::ListDirectory { .. } | Invocation::ReadFile { .. } => String::new(),
    }
}
