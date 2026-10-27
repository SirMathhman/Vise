use super::path;
use super::types::{Param, ParamType, ToolError, ToolSpec};
use serde::Deserialize;
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
};

#[derive(Deserialize)]
struct Args {
    path: String,
    start: usize,
    end: usize,
}

pub fn run(arguments: &str, cwd: &Path) -> Result<String, ToolError> {
    let args: Args =
        serde_json::from_str(arguments).map_err(|err| ToolError::InvalidArguments(err.to_string()))?;
    if args.start == 0 {
        return Err(ToolError::InvalidArguments("start must be at least 1".into()));
    }
    if args.end < args.start {
        return Err(ToolError::InvalidArguments("end must be at least start".into()));
    }
    let target = path::confine(cwd, &args.path)?;
    let bytes = fs::read(&target).map_err(|err| ToolError::Failed(format!("cannot read '{}': {err}", args.path)))?;
    let text = String::from_utf8(bytes)
        .map_err(|_| ToolError::Failed(format!("'{}' is not a UTF-8 text file", args.path)))?;

    let lines: Vec<&str> = text.lines().collect();
    if args.start > lines.len() {
        return Err(ToolError::InvalidArguments(format!(
            "start {} is past the end of '{}', which has {} lines",
            args.start,
            args.path,
            lines.len()
        )));
    }
    let wanted_end = args.end.min(lines.len());
    let mut output = String::new();
    let mut last = args.start - 1;
    for line in lines.iter().skip(args.start - 1).take(wanted_end - args.start + 1).take(MAX_LINES) {
        if output.len() + line.len() + 1 > MAX_BYTES {
            break;
        }
        output.push_str(line);
        output.push('\n');
        last += 1;
    }
    if last == args.start - 1 {
        return Err(ToolError::Failed(format!("line {} is longer than 100 KB", args.start)));
    }
    if last < wanted_end {
        output.push_str(&format!("[stopped after line {last}; read again with start {}]\n", last + 1));
    }
    Ok(output)
}
