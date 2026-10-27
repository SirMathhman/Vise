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

/// The note that tells the model which tools are enabled and which are not. It is prepended to a user
/// message whenever the enabled set has changed since the model was last told.
pub fn tool_note(enabled: &[&str]) -> String {
    let (on, off): (Vec<&str>, Vec<&str>) =
        specs().iter().map(|spec| spec.name).partition(|name| enabled.contains(name));
    let names = |list: &[&str]| if list.is_empty() { "none".to_string() } else { list.join(", ") };
    format!("[Tools enabled: {}. Tools disabled: {}.]", names(&on), names(&off))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn note_names_enabled_and_disabled_tools() {
        let note = tool_note(&["read_file"]);
        assert_eq!(note, "[Tools enabled: read_file. Tools disabled: list_directory, create_file, create_directory, edit_file, run_powershell, read_background, kill_background.]");
    }
}
