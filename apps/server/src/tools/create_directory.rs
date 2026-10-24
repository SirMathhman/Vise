use serde_json::{json, Value};
use std::fs;
use std::path::Path;

use crate::error::AppError;
use super::Tool;

pub fn tool() -> Tool {
    Tool {
        name: "create_directory",
        schema: json!({
            "type": "function",
            "function": {
                "name": "create_directory",
                "description": "Create a new directory, including any missing parent directories. Fails if the path already exists as a file.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {"type": "string", "description": "The directory to create."}
                    },
                    "required": ["path"]
                }
            }
        }),
        execute: |args| Box::pin(async { create_directory(args) }),
    }
}

fn create_directory(args: Value) -> Result<String, AppError> {
    let path = args
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| AppError::BadRequest("missing 'path'".into()))?;

    let p = Path::new(path);
    if p.exists() {
        if p.is_dir() {
            return Ok(format!("directory already exists: {path}"));
        }
        return Err(AppError::BadRequest(format!("path is a file, not a directory: {path}")));
    }

    fs::create_dir_all(p)
        .map_err(|e| AppError::BadRequest(format!("cannot create directory {path}: {e}")))?;

    Ok(format!("created directory {path}"))
}
