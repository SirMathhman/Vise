use super::path;
use super::types::{Param, ParamType, ToolError, ToolSpec};
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
            kind: ParamType::Integer { min: Some(1), max: Some(MAX_DEPTH as u32) },
            description: "How many levels to list.",
        },
    ],
};

pub fn run(requested: &str, depth: u8, cwd: &Path) -> Result<String, ToolError> {
    if !(1..=MAX_DEPTH).contains(&depth) {
        return Err(ToolError::InvalidArguments(format!("depth must be between 1 and {MAX_DEPTH}")));
    }
    let target = path::confine(cwd, requested)?;
    let mut entries = Vec::new();
    walk(&target, "", depth, &mut entries)
        .map_err(|err| ToolError::Failed(format!("cannot list '{requested}': {err}")))?;
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
