use serde::Deserialize;
use serde_json::{Value, json};
use std::fs;
use std::io;
use std::path::Path;

const MAX_DEPTH: u8 = 5;

#[derive(Deserialize)]
struct ListArgs {
    path: String,
    depth: u8,
}

pub fn definitions() -> Value {
    json!([{
        "type": "function",
        "function": {
            "name": "list_directory",
            "description": "List the files and directories inside a directory under the working directory, recursively to the given depth. Depth 1 lists only the directory's direct entries; depth 2 also lists the entries inside its subdirectories; the maximum is 5. Directories end with '/'.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Directory path relative to the working directory. Use '.' for the working directory itself."},
                    "depth": {"type": "integer", "minimum": 1, "maximum": MAX_DEPTH, "description": "How many levels to list."}
                },
                "required": ["path", "depth"]
            }
        }
    }])
}

pub fn execute(name: &str, arguments: &str, cwd: &Path) -> String {
    match name {
        "list_directory" => list_directory(arguments, cwd).unwrap_or_else(|err| format!("error: {err}")),
        _ => format!("error: unknown tool '{name}'"),
    }
}

fn list_directory(arguments: &str, cwd: &Path) -> Result<String, String> {
    let args: ListArgs = serde_json::from_str(arguments).map_err(|err| format!("invalid arguments: {err}"))?;
    if !(1..=MAX_DEPTH).contains(&args.depth) {
        return Err(format!("depth must be between 1 and {MAX_DEPTH}"));
    }
    let root = cwd.canonicalize().map_err(|err| err.to_string())?;
    let target = root
        .join(&args.path)
        .canonicalize()
        .map_err(|err| format!("cannot open '{}': {err}", args.path))?;
    if !target.starts_with(&root) {
        return Err(format!("'{}' is outside the working directory", args.path));
    }
    let mut entries = Vec::new();
    walk(&target, "", args.depth, &mut entries).map_err(|err| format!("cannot list '{}': {err}", args.path))?;
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
