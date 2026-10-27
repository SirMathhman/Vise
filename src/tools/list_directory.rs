use super::path;
use super::types::{Param, ParamType, ToolError, ToolSpec};
use serde::Deserialize;
use std::fs;
use std::io;
use std::path::Path;

const MAX_DEPTH: u8 = 5;

pub const SPEC: ToolSpec = ToolSpec {
    name: "list_directory",
    description: "List the files and directories inside a directory under the working directory, recursively to the given depth. Depth 1 lists only the directory's direct entries; depth 2 also lists the entries inside its subdirectories; the maximum is 5. Directories end with '/'.",
    params: &[
        Param {
            name: "path",
            kind: ParamType::String,
            description: "Directory path relative to the working directory. Use '.' for the working directory itself.",
        },
        Param {
            name: "depth",
            kind: ParamType::Integer { min: 1, max: MAX_DEPTH },
            description: "How many levels to list.",
        },
    ],
};

#[derive(Deserialize)]
struct Args {
    path: String,
    depth: u8,
}

pub fn run(arguments: &str, cwd: &Path) -> Result<String, ToolError> {
    let args: Args =
        serde_json::from_str(arguments).map_err(|err| ToolError::InvalidArguments(err.to_string()))?;
    if !(1..=MAX_DEPTH).contains(&args.depth) {
        return Err(ToolError::InvalidArguments(format!("depth must be between 1 and {MAX_DEPTH}")));
    }
    let target = path::confine(cwd, &args.path)?;
    let mut entries = Vec::new();
    walk(&target, "", args.depth, &mut entries)
        .map_err(|err| ToolError::Failed(format!("cannot list '{}': {err}", args.path)))?;
    Ok(entries.join("\n"))
}

fn walk(dir: &Path, prefix: &str, depth: u8, out: &mut Vec<String>) -> io::Result<()> {
    let mut entries: Vec<_> = fs::read_dir(dir)?.collect::<io::Result<_>>()?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let name = entry.file_name().to_string_lossy().into_owned();
        let rel = format!("{prefix}{name}");
        if entry.file_type()?.is_dir() {
            out.push(format!("{rel}/"));
            if depth > 1 {
                walk(&entry.path(), &format!("{rel}/"), depth - 1, out)?;
            }
        } else {
            out.push(rel);
        }
    }
    Ok(())
}
