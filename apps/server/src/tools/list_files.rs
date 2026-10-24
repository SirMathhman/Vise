use serde_json::{json, Value};
use std::fs;
use std::path::Path;

use crate::error::AppError;
use super::Tool;

pub fn tool() -> Tool {
    Tool {
        name: "list_files",
        schema: json!({
            "type": "function",
            "function": {
                "name": "list_files",
                "description": "List the files and directories in a directory, recursively up to the given depth. depth is mandatory: 0 lists only the top level, 1 lists one level down, and so on.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {"type": "string", "description": "The directory to list."},
                        "depth": {"type": "integer", "description": "Maximum recursion depth (mandatory). 0 = top level only."}
                    },
                    "required": ["path", "depth"]
                }
            }
        }),
        execute: |args| Box::pin(async { list_files(args) }),
    }
}

fn list_files(args: Value) -> Result<String, AppError> {
    let path = args
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| AppError::BadRequest("missing 'path'".into()))?;
    let depth = args
        .get("depth")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| AppError::BadRequest("missing 'depth'".into()))?;
    if depth < 0 {
        return Err(AppError::BadRequest("depth must be >= 0".into()));
    }

    let root = Path::new(path);
    if !root.is_dir() {
        return Err(AppError::BadRequest(format!("not a directory: {path}")));
    }

    let mut lines = Vec::new();
    walk(root, root, 0, depth, &mut lines);
    Ok(lines.join("\n"))
}

fn walk(dir: &Path, root: &Path, current: i64, max: i64, out: &mut Vec<String>) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let full = entry.path();
        let rel = full.strip_prefix(root).unwrap_or_else(|_| full.as_path());
        let rel_str = rel.to_string_lossy();
        out.push(format!("{}{}", rel_str, if is_dir { "/" } else { "" }));
        if is_dir && current < max {
            walk(&entry.path(), root, current + 1, max, out);
        }
    }
}
