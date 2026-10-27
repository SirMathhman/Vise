//! The tool catalogue sent with every request. It lists every tool, enabled or not, so it never changes
//! during a session and the prompt cache stays valid across toggles.

use crate::tools::specs;
use crate::tools::types::{ParamType, ToolSpec};

const FORMAT: &str = "To call a tool, reply with only this, with no other text:\n\
<tool_call>\n{\"name\": \"<tool name>\", \"arguments\": {...}}\n</tool_call>\n\nTools:\n";

pub fn catalogue() -> String {
    specs().iter().fold(FORMAT.to_string(), |mut text, spec| {
        text.push_str(&describe(spec));
        text.push('\n');
        text
    })
}

fn describe(spec: &ToolSpec) -> String {
    let params: Vec<String> = spec
        .params
        .iter()
        .map(|param| format!("{} ({}): {}", param.name, kind(&param.kind), param.description))
        .collect();
    format!("- {}: {} Arguments: {}", spec.name, spec.description, params.join("; "))
}

fn kind(kind: &ParamType) -> String {
    match kind {
        ParamType::String => "string".into(),
        ParamType::Integer { min: Some(min), max: Some(max) } => format!("integer from {min} to {max}"),
        ParamType::Integer { .. } => "integer".into(),
        ParamType::Boolean => "boolean".into(),
    }
}
