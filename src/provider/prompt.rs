//! The tool catalogue sent with every request. It lists every tool, enabled or not, so it never changes
//! during a session and the prompt cache stays valid across toggles.

use crate::session::Message;
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

const NOTE_START: &str = "[Tools enabled:";

/// The note that tells the model which tools are enabled and which are not. It is prepended to a user
/// message whenever the history does not already state the current set.
pub fn tool_note(enabled: &[&str]) -> String {
    let (on, off): (Vec<&str>, Vec<&str>) =
        specs().iter().map(|spec| spec.name).partition(|name| enabled.contains(name));
    let names = |list: &[&str]| if list.is_empty() { "none".to_string() } else { list.join(", ") };
    format!("{NOTE_START} {}. Tools disabled: {}.]", names(&on), names(&off))
}

/// Whether the latest tool note in `history` states the current enabled set. Compaction or dropping a
/// turn can remove the note, and then the model must be told again.
pub fn is_announced(history: &[Message], enabled: &[&str]) -> bool {
    let note = tool_note(enabled);
    history
        .iter()
        .rev()
        .map(Message::content)
        .find(|text| text.starts_with(NOTE_START))
        .is_some_and(|text| text.starts_with(&note))
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
        assert_eq!(note, "[Tools enabled: read_file. Tools disabled: list_directory, create_file, create_directory, edit_file, run_powershell, read_background, kill_background, list_notes, read_note, create_note, update_note, delete_note.]");
    }

    #[test]
    fn note_in_history_must_match_the_enabled_set() {
        let all: Vec<&str> = specs().iter().map(|spec| spec.name).collect();
        let announced = vec![Message::User(format!("{}\n\nhello", tool_note(&all)))];
        assert!(is_announced(&announced, &all));
        assert!(!is_announced(&announced, &["read_file"]));
        assert!(!is_announced(&[Message::User("hello".into())], &all));
    }
}
