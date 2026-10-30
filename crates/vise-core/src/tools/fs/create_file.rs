use super::path;
use crate::tools::types::{Arguments, Invocation, Param, ParamType, ToolError, ToolSpec};
use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;

pub const SPEC: ToolSpec = ToolSpec {
    name: "create_file",
    description: "Create a new text file under the working directory with the given content. Fails if the file already exists. The parent directory must exist; create it with create_directory first.",
    params: &[
        Param {
            name: "path",
            kind: ParamType::String,
            description: "File path relative to the working directory.",
        },
        Param {
            name: "content",
            kind: ParamType::String,
            description: "Full text content of the new file.",
        },
    ],
    bind,
};

fn bind(args: &Arguments) -> Result<Invocation, ToolError> {
    Ok(Invocation::CreateFile {
        path: args.text("path")?.to_string(),
        content: args.text("content")?.to_string(),
    })
}

pub fn run(requested: &str, content: &str, cwd: &Path) -> Result<String, ToolError> {
    let target = path::confine_new(cwd, requested)?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&target)
        .map_err(|err| ToolError::Failed(format!("cannot create '{requested}': {err}")))?;
    file.write_all(content.as_bytes())
        .map_err(|err| ToolError::Failed(format!("cannot write '{requested}': {err}")))?;
    Ok(format!("created '{requested}'"))
}
