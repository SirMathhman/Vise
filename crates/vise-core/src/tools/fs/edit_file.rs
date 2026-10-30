use super::path;
use crate::tools::types::{Arguments, Invocation, Param, ParamType, ToolError, ToolSpec};
use std::fs;
use std::path::Path;

pub const SPEC: ToolSpec = ToolSpec {
    name: "edit_file",
    description: "Replace one exact occurrence of 'previous' with 'new' in an existing text file under the working directory. 'previous' must appear exactly once in the file; include enough surrounding text to make it unique.",
    params: &[
        Param {
            name: "path",
            kind: ParamType::String,
            description: "File path relative to the working directory.",
        },
        Param {
            name: "previous",
            kind: ParamType::String,
            description: "Exact text to replace. Must appear exactly once in the file.",
        },
        Param {
            name: "new",
            kind: ParamType::String,
            description: "Text to put in place of 'previous'.",
        },
    ],
    bind,
};

fn bind(args: &Arguments) -> Result<Invocation, ToolError> {
    Ok(Invocation::EditFile {
        path: args.text("path")?.to_string(),
        previous: args.text("previous")?.to_string(),
        new: args.text("new")?.to_string(),
    })
}

pub fn run(requested: &str, previous: &str, new: &str, cwd: &Path) -> Result<String, ToolError> {
    if previous.is_empty() {
        return Err(ToolError::InvalidArguments("'previous' must not be empty".into()));
    }
    let target = path::confine(cwd, requested)?;
    let text = fs::read_to_string(&target)
        .map_err(|err| ToolError::Failed(format!("cannot read '{requested}': {err}")))?;
    let matches = text.matches(previous).count();
    if matches != 1 {
        return Err(ToolError::Failed(format!(
            "'previous' appears {matches} times in '{requested}'; it must appear exactly once"
        )));
    }
    fs::write(&target, text.replacen(previous, new, 1))
        .map_err(|err| ToolError::Failed(format!("cannot write '{requested}': {err}")))?;
    Ok(format!("edited '{requested}'"))
}
