use std::fs;
use std::path::Path;

use serde_json::{Value, json};

pub const LIST_FILES: &str = "list_files";

/// The tool definitions sent with every chat request.
pub fn definitions() -> Value {
    json!([{
        "type": "function",
        "function": {
            "name": LIST_FILES,
            "description": "List the files and subdirectories in a directory, down to the given depth. Depth 1 lists only the directory's own entries. Subdirectories end with a slash.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Directory to list" },
                    "depth": { "type": "integer", "minimum": 1, "description": "How many levels to list; 1 is only the directory's own entries" }
                },
                "required": ["path", "depth"]
            }
        }
    }])
}

/// Runs a tool call and returns the text the model should see. Failures are returned as text too,
/// so the model can recover instead of the whole turn failing.
pub fn run(name: &str, arguments: &str) -> String {
    match name {
        LIST_FILES => list_files(arguments).unwrap_or_else(|err| format!("error: {err}")),
        _ => format!("error: unknown tool {name}"),
    }
}

fn list_files(arguments: &str) -> Result<String, String> {
    let args: Value =
        serde_json::from_str(arguments).map_err(|err| format!("invalid arguments: {err}"))?;
    let path = args
        .get("path")
        .and_then(Value::as_str)
        .ok_or("path must be a string")?;
    let depth = args
        .get("depth")
        .and_then(Value::as_u64)
        .filter(|depth| *depth >= 1)
        .ok_or("depth must be an integer of at least 1")?;

    let root = Path::new(path);
    if !root.is_dir() {
        return Err(format!("not a directory: {path}"));
    }
    let mut lines = Vec::new();
    walk(root, root, depth, &mut lines).map_err(|err| format!("could not read {path}: {err}"))?;
    Ok(lines.join("\n"))
}

fn walk(root: &Path, dir: &Path, depth: u64, lines: &mut Vec<String>) -> std::io::Result<()> {
    let mut entries = fs::read_dir(dir)?.collect::<Result<Vec<_>, _>>()?;
    entries.sort_by_key(|entry| entry.file_name());

    for entry in entries {
        let path = entry.path();
        let relative = path.strip_prefix(root).unwrap_or(&path).display().to_string();
        if entry.file_type()?.is_dir() {
            lines.push(format!("{relative}/"));
            if depth > 1 {
                walk(root, &path, depth - 1, lines)?;
            }
        } else {
            lines.push(relative);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    #[test]
    fn list_files_respects_depth() {
        let root = std::env::temp_dir().join(format!("vise-list-{}", std::process::id()));
        fs::create_dir_all(root.join("sub")).unwrap();
        fs::write(root.join("a.txt"), "").unwrap();
        fs::write(root.join("sub").join("b.txt"), "").unwrap();
        let path = root.display().to_string().replace('\\', "\\\\");

        let shallow = run(LIST_FILES, &format!(r#"{{"path":"{path}","depth":1}}"#));
        let deep = run(LIST_FILES, &format!(r#"{{"path":"{path}","depth":2}}"#));
        fs::remove_dir_all(&root).unwrap();

        let nested = format!("sub{}b.txt", std::path::MAIN_SEPARATOR);
        assert_eq!(shallow, "a.txt\nsub/");
        assert_eq!(deep, format!("a.txt\nsub/\n{nested}"));
    }
}
