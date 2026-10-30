use super::path;
use crate::tools::types::{Arguments, Invocation, Param, ParamType, ToolError, ToolSpec};
use std::fs;
use std::path::Path;

pub const SPEC: ToolSpec = ToolSpec {
    name: "create_directory",
    description: "Create a directory under the working directory, including any missing parent directories. Succeeds if the directory already exists.",
    params: &[Param {
        name: "path",
        kind: ParamType::String,
        description: "Directory path relative to the working directory.",
    }],
    bind,
};

fn bind(args: &Arguments) -> Result<Invocation, ToolError> {
    Ok(Invocation::CreateDirectory { path: args.text("path")?.to_string() })
}

pub fn run(requested: &str, cwd: &Path) -> Result<String, ToolError> {
    let target = path::confine_new(cwd, requested)?;
    fs::create_dir_all(&target).map_err(|err| ToolError::Failed(format!("cannot create '{requested}': {err}")))?;
    Ok(format!("created directory '{requested}'"))
}
