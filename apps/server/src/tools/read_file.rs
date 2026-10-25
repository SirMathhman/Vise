use serde_json::{json, Value};
use std::fs;

use crate::error::AppError;
use super::Tool;

const MAX_READ_LINES: usize = 500;

pub fn tool() -> Tool {
    Tool {
        name: "read_file",
        description: "Read a text file and return its contents, optionally limited to a line range. Line numbers are 1-based. At most 500 lines are returned.",
        parameters: json!({
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "The file to read."},
                "start_line": {"type": "integer", "description": "First line to include (1-based). Defaults to 1."},
                "end_line": {"type": "integer", "description": "Last line to include (1-based). Defaults to the end of the file."}
            },
            "required": ["path"]
        }),
        execute: |args| Box::pin(async { read_file(args) }),
    }
}

fn read_file(args: Value) -> Result<String, AppError> {
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

    let content = match fs::read_to_string(path) {
        Ok(c) => c,
        Err(e) => return Ok(format!("cannot read {path}: {e}")),
    };

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
