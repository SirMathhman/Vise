use serde_json::{json, Value};
use std::fs;
use std::path::Path;
use std::sync::OnceLock;

use crate::error::AppError;

/// A tool: its OpenAI-style JSON schema plus the executor that runs it.
struct Tool {
    name: &'static str,
    schema: Value,
    execute: fn(&Value) -> Result<String, AppError>,
}

/// The tool registry. Adding a tool is one entry here; the schema and
/// executor live together so they cannot drift apart.
fn tools() -> &'static [Tool] {
    static TOOLS: OnceLock<Vec<Tool>> = OnceLock::new();
    TOOLS.get_or_init(|| {
        vec![
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
                execute: list_files,
            },
            Tool {
                name: "read_file",
                schema: json!({
                    "type": "function",
                    "function": {
                        "name": "read_file",
                        "description": "Read a text file and return its contents, optionally limited to a line range. Line numbers are 1-based. At most 500 lines are returned.",
                        "parameters": {
                            "type": "object",
                            "properties": {
                                "path": {"type": "string", "description": "The file to read."},
                                "start_line": {"type": "integer", "description": "First line to include (1-based). Defaults to 1."},
                                "end_line": {"type": "integer", "description": "Last line to include (1-based). Defaults to the end of the file."}
                            },
                            "required": ["path"]
                        }
                    }
                }),
                execute: read_file,
            },
        ]
    })
    .as_slice()
}

/// OpenAI-style tool schemas sent to Strata.
pub fn tool_schemas() -> Value {
    Value::Array(tools().iter().map(|t| t.schema.clone()).collect())
}

/// Execute a tool by name with parsed JSON arguments; returns the result text.
pub fn execute_tool(name: &str, args: &Value) -> Result<String, AppError> {
    let tool = tools()
        .iter()
        .find(|t| t.name == name)
        .ok_or_else(|| AppError::BadRequest(format!("unknown tool: {name}")))?;
    (tool.execute)(args)
}

fn list_files(args: &Value) -> Result<String, AppError> {
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

const MAX_READ_LINES: usize = 500;

fn read_file(args: &Value) -> Result<String, AppError> {
    let path = args
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| AppError::BadRequest("missing 'path'".into()))?;

    let start_line = args
        .get("start_line")
        .and_then(|v| v.as_i64())
        .unwrap_or(1);
    let end_line = args
        .get("end_line")
        .and_then(|v| v.as_i64())
        .unwrap_or(i64::MAX);

    if start_line < 1 {
        return Err(AppError::BadRequest("start_line must be >= 1".into()));
    }
    if end_line < start_line {
        return Err(AppError::BadRequest("end_line must be >= start_line".into()));
    }

    let content = fs::read_to_string(path)
        .map_err(|e| AppError::BadRequest(format!("cannot read {path}: {e}")))?;

    let lines: Vec<&str> = content.lines().collect();
    let total = lines.len() as i64;

    let start = (start_line - 1) as usize;
    let end = (end_line as usize).min(total as usize);
    if start >= total as usize {
        return Ok(format!("[no lines in range {start_line}..{end_line}; file has {total} lines]"));
    }

    let capped_end = end.min(start + MAX_READ_LINES);
    let selected = &lines[start..capped_end];
    let count = selected.len();
    let mut out = String::new();
    for (i, line) in selected.iter().enumerate() {
        out.push_str(&format!("{}: {}\n", start + i + 1, line));
    }
    if capped_end < end {
        out.push_str(&format!(
            "[first {} of {} lines shown; use end_line to read more]",
            count, total
        ));
    } else {
        out.push_str(&format!("[{} of {} lines shown]", count, total));
    }
    Ok(out)
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