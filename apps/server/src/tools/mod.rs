use serde_json::Value;
use std::sync::OnceLock;

use crate::error::AppError;

pub mod create_directory;
pub mod create_file;
pub mod edit_file;
pub mod list_files;
pub mod read_file;

/// A tool: its OpenAI-style JSON schema plus the executor that runs it.
pub struct Tool {
    pub name: &'static str,
    pub schema: Value,
    pub execute: fn(&Value) -> Result<String, AppError>,
}

/// The tool registry. Adding a tool is one entry here; the schema and
/// executor live together so they cannot drift apart.
fn tools() -> &'static [Tool] {
    static TOOLS: OnceLock<Vec<Tool>> = OnceLock::new();
    TOOLS.get_or_init(|| {
        vec![
            list_files::tool(),
            read_file::tool(),
            create_file::tool(),
            create_directory::tool(),
            edit_file::tool(),
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
