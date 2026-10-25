use serde_json::{json, Value};
use std::future::Future;
use std::pin::Pin;
use std::sync::OnceLock;

use crate::error::AppError;

pub mod create_directory;
pub mod create_file;
pub mod edit_file;
pub mod list_files;
pub mod powershell;
pub mod read_file;

/// A tool: its identity (name + description), its JSON-Schema parameters,
/// and the executor that runs it. The OpenAI-style schema is derived from
/// these fields, so the identity the executor uses and the schema sent to
/// the model can never drift apart.
///
/// Executors are async so tools that block (e.g. running a process) can
/// await without stalling the loop. The argument is passed by value so the
/// returned future does not borrow from the caller.
pub struct Tool {
    pub name: &'static str,
    pub description: &'static str,
    pub parameters: Value,
    pub execute: fn(Value) -> Pin<Box<dyn Future<Output = Result<String, AppError>> + Send>>,
}

/// Build the OpenAI-style function schema from a tool's fields.
fn openai_schema(t: &Tool) -> Value {
    json!({
        "type": "function",
        "function": {
            "name": t.name,
            "description": t.description,
            "parameters": t.parameters,
        }
    })
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
            powershell::tool(),
        ]
    })
    .as_slice()
}

/// OpenAI-style tool schemas sent to Strata.
pub fn tool_schemas() -> Value {
    Value::Array(tools().iter().map(|t| openai_schema(t)).collect())
}

/// A human-readable list of the available tools (name + description).
pub fn tool_list() -> Value {
    Value::Array(
        tools()
            .iter()
            .map(|t| json!({ "name": t.name, "description": t.description }))
            .collect(),
    )
}

/// Execute a tool by name with parsed JSON arguments; returns the result text.
pub async fn execute_tool(name: &str, args: Value) -> Result<String, AppError> {
    let tool = tools()
        .iter()
        .find(|t| t.name == name)
        .ok_or_else(|| AppError::BadRequest(format!("unknown tool: {name}")))?;
    (tool.execute)(args).await
}
