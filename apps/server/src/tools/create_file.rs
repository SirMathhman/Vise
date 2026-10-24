use serde_json::{json, Value};
use std::fs;
use std::path::Path;

use crate::error::AppError;
use super::Tool;

pub fn tool() -> Tool {
    Tool {
        name: "create_file",
        schema: json!({
            "type": "function",
            "function": {
                "name": "create_file",
                "description": "Create a new file with the given content. Fails if the file already exists. Parent directories must already exist.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {"type": "string", "description": "The file to create."},
                        "content": {"type": "string", "description": "The content to write to the file."}
                    },
                    "required": ["path", "content"]
                }
            }
        }),
        execute: create_file,
    }
}

fn create_file(args: &Value) -> Result<String, AppError> {
    let path = args
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| AppError::BadRequest("missing 'path'".into()))?;
    let content = args
        .get("content")
        .and_then(|v| v.as_str())
        .ok_or_else(|| AppError::BadRequest("missing 'content'".into()))?;

    if Path::new(path).exists() {
        return Err(AppError::BadRequest(format!("file already exists: {path}")));
    }

    fs::write(path, content)
        .map_err(|e| AppError::BadRequest(format!("cannot create {path}: {e}")))?;

    Ok(format!("created {path} ({} bytes)", content.len()))
}
