use serde_json::{json, Value};
use std::fs;

use crate::error::AppError;
use super::Tool;

pub fn tool() -> Tool {
    Tool {
        name: "edit_file",
        schema: json!({
            "type": "function",
            "function": {
                "name": "edit_file",
                "description": "Replace the first occurrence of a previous text string with a new text string in a file. Fails if the previous text is not found exactly once.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {"type": "string", "description": "The file to edit."},
                        "previous_text": {"type": "string", "description": "The exact text to find and replace."},
                        "new_text": {"type": "string", "description": "The text to replace it with."}
                    },
                    "required": ["path", "previous_text", "new_text"]
                }
            }
        }),
        execute: |args| Box::pin(async { edit_file(args) }),
    }
}

fn edit_file(args: Value) -> Result<String, AppError> {
    let path = args
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| AppError::BadRequest("missing 'path'".into()))?;
    let previous_text = args
        .get("previous_text")
        .and_then(|v| v.as_str())
        .ok_or_else(|| AppError::BadRequest("missing 'previous_text'".into()))?;
    let new_text = args
        .get("new_text")
        .and_then(|v| v.as_str())
        .ok_or_else(|| AppError::BadRequest("missing 'new_text'".into()))?;

    let content = match fs::read_to_string(path) {
        Ok(c) => c,
        Err(e) => return Ok(format!("cannot read {path}: {e}")),
    };

    let count = content.matches(previous_text).count();
    if count == 0 {
        return Ok(format!("previous_text not found in {path}"));
    }
    if count > 1 {
        return Ok(format!(
            "previous_text is not unique in {path} (found {count} occurrences)"
        ));
    }

    let updated = content.replacen(previous_text, new_text, 1);
    match fs::write(path, updated) {
        Ok(_) => Ok(format!("edited {path} (replaced 1 occurrence)")),
        Err(e) => Ok(format!("cannot write {path}: {e}")),
    }
}
