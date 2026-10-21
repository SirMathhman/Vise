use std::fs;
use std::path::Path;

use serde_json::{Value, json};

pub const LIST_FILES: &str = "list_files";
pub const READ_FILE: &str = "read_file";

/// The tool definitions sent with every chat request.
pub fn definitions() -> Value {
    json!([
        {
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
        },
        {
            "type": "function",
            "function": {
                "name": READ_FILE,
                "description": "Read lines from a text file. Lines are 1-based: start is included and end is excluded, so start 3 and end 6 returns lines 3, 4 and 5. Each returned line is prefixed with its line number and a tab.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "File to read" },
                        "start": { "type": "integer", "minimum": 1, "description": "First line to return, 1-based and included" },
                        "end": { "type": "integer", "minimum": 1, "description": "Line after the last one to return, 1-based and excluded" }
                    },
                    "required": ["path", "start", "end"]
                }
            }
        }
    ])
}

/// Runs a tool call and returns the text the model should see. Failures are returned as text too,
/// so the model can recover instead of the whole turn failing.
pub fn run(name: &str, arguments: &str) -> String {
    match name {
        LIST_FILES => list_files(arguments).unwrap_or_else(|err| format!("error: {err}")),
        READ_FILE => read_file(arguments).unwrap_or_else(|err| format!("error: {err}")),
        _ => format!("error: unknown tool {name}"),
    }
}

fn parse_arguments(arguments: &str) -> Result<Value, String> {
    serde_json::from_str(arguments).map_err(|err| format!("invalid arguments: {err}"))
}

fn list_files(arguments: &str) -> Result<String, String> {
    let args = parse_arguments(arguments)?;
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

/// Returns lines `start` (included) to `end` (excluded), both 1-based, each prefixed with its number.
/// An end past the last line is clipped to the file; a range with nothing in it is an error.
fn read_file(arguments: &str) -> Result<String, String> {
    let args = parse_arguments(arguments)?;
    let path = args
        .get("path")
        .and_then(Value::as_str)
        .ok_or("path must be a string")?;
    let start = args
        .get("start")
        .and_then(Value::as_u64)
        .filter(|start| *start >= 1)
        .ok_or("start must be an integer of at least 1")?;
    let end = args
        .get("end")
        .and_then(Value::as_u64)
        .filter(|end| *end >= 1)
        .ok_or("end must be an integer of at least 1")?;

    let text = fs::read_to_string(path).map_err(|err| format!("could not read {path}: {err}"))?;
    let lines: Vec<&str> = text.lines().collect();
    let total = lines.len() as u64;
    let stop = end.min(total + 1);
    if start >= stop {
        return Err(format!("no lines in range {start} to {end}; {path} has {total} lines"));
    }

    let selected = &lines[(start - 1) as usize..(stop - 1) as usize];
    Ok(selected
        .iter()
        .enumerate()
        .map(|(offset, line)| format!("{}\t{line}", start + offset as u64))
        .collect::<Vec<_>>()
        .join("\n"))
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

    #[test]
    fn read_file_returns_numbered_lines_from_start_to_excluded_end() {
        let file = std::env::temp_dir().join(format!("vise-read-{}.txt", std::process::id()));
        fs::write(&file, "a\nb\nc\n").unwrap();
        let path = file.display().to_string();

        let middle = run(READ_FILE, &json!({ "path": path, "start": 2, "end": 4 }).to_string());
        let clipped = run(READ_FILE, &json!({ "path": path, "start": 1, "end": 10 }).to_string());
        let empty = run(READ_FILE, &json!({ "path": path, "start": 3, "end": 3 }).to_string());
        fs::remove_file(&file).unwrap();

        assert_eq!(middle, "2\tb\n3\tc");
        assert_eq!(clipped, "1\ta\n2\tb\n3\tc");
        assert!(empty.starts_with("error: no lines in range 3 to 3"));
    }
}
