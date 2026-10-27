use super::path;
use crate::tools::types::{Arguments, Invocation, Param, ParamType, ToolError, ToolSpec};
use std::fs;
use std::path::Path;

const MAX_LINES: usize = 500;
const MAX_BYTES: usize = 100 * 1024;

pub const SPEC: ToolSpec = ToolSpec {
    name: "read_file",
    description: "Read lines from a text file under the working directory. Returns lines start through end (1-based, inclusive), up to 500 lines or 100 KB, whichever comes first. If the result stops early, the note at the end says where to resume. Binary files are refused.",
    params: &[
        Param {
            name: "path",
            kind: ParamType::String,
            description: "File path relative to the working directory.",
        },
        Param {
            name: "start",
            kind: ParamType::Integer { min: Some(1), max: None },
            description: "First line to read, 1-based.",
        },
        Param {
            name: "end",
            kind: ParamType::Integer { min: Some(1), max: None },
            description: "Last line to read, 1-based and inclusive.",
        },
    ],
    bind,
};

fn bind(args: &Arguments) -> Result<Invocation, ToolError> {
    Ok(Invocation::ReadFile {
        path: args.text("path")?.to_string(),
        start: usize::try_from(args.integer("start")?)
            .map_err(|_| ToolError::InvalidArguments("'start' is out of range".into()))?,
        end: usize::try_from(args.integer("end")?)
            .map_err(|_| ToolError::InvalidArguments("'end' is out of range".into()))?,
    })
}

pub fn run(requested: &str, start: usize, end: usize, cwd: &Path) -> Result<String, ToolError> {
    if start == 0 {
        return Err(ToolError::InvalidArguments("start must be at least 1".into()));
    }
    if end < start {
        return Err(ToolError::InvalidArguments("end must be at least start".into()));
    }
    let target = path::confine(cwd, requested)?;
    let bytes = fs::read(&target).map_err(|err| ToolError::Failed(format!("cannot read '{requested}': {err}")))?;
    let text = String::from_utf8(bytes)
        .map_err(|_| ToolError::Failed(format!("'{requested}' is not a UTF-8 text file")))?;

    let lines: Vec<&str> = text.lines().collect();
    if start > lines.len() {
        return Err(ToolError::InvalidArguments(format!(
            "start {start} is past the end of '{requested}', which has {} lines",
            lines.len()
        )));
    }
    let wanted_end = end.min(lines.len());
    let mut output = String::new();
    let mut last = start - 1;
    for line in lines.iter().skip(start - 1).take(wanted_end - start + 1).take(MAX_LINES) {
        if output.len() + line.len() + 1 > MAX_BYTES {
            break;
        }
        output.push_str(line);
        output.push('\n');
        last += 1;
    }
    if last == start - 1 {
        return Err(ToolError::Failed(format!("line {start} is longer than 100 KB")));
    }
    if last < wanted_end {
        output.push_str(&format!("[stopped after line {last}; read again with start {}]\n", last + 1));
    }
    Ok(output)
}
