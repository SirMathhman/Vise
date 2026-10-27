//! Profiles: named instructions kept as `.txt` files in the `profiles` folder. A profile's text is sent
//! with the next user message, so the system prompt at the start of the history never changes.

use crate::session::Message;
use crate::tools::specs;
use std::fs;
use std::io;
use std::path::PathBuf;

const FOLDER: &str = "profiles";
const MARK: &str = "[Instructions from profile ";

/// The text a profile adds to a user message: its name and its instructions.
pub fn marked(name: &str, text: &str) -> String {
    format!("{MARK}{name}]\n{text}")
}

/// Whether the latest profile text in `history` is `marked_text`. Compaction or a dropped turn can remove
/// it, and then the profile must be sent again.
pub fn carried(history: &[Message], marked_text: &str) -> bool {
    history
        .iter()
        .rev()
        .map(Message::content)
        .find(|text| text.starts_with(MARK))
        .is_some_and(|text| text.starts_with(marked_text))
}

/// The profile names, sorted: the `.txt` files in the folder without their extension. A folder that does
/// not exist has no profiles.
pub fn names() -> Result<Vec<String>, String> {
    let entries = match fs::read_dir(FOLDER) {
        Ok(entries) => entries,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(format!("cannot read the profiles folder: {err}")),
    };
    let mut names: Vec<String> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter_map(|file| file.strip_suffix(".txt").map(str::to_string))
        .collect();
    names.sort();
    Ok(names)
}

/// A profile: its instructions, and the tools it allows if its file names any on a `tools:` line.
#[derive(Debug)]
pub struct Profile {
    pub instructions: String,
    pub tools: Option<Vec<String>>,
}

/// Loads one profile. Only letters, digits, '-' and '_' are accepted in a name, so a name cannot reach
/// outside the folder.
pub fn load(name: &str) -> Result<Profile, String> {
    let valid = !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !valid {
        return Err(format!("'{name}' is not a profile name; use letters, digits, '-' and '_'"));
    }
    let text = fs::read_to_string(PathBuf::from(FOLDER).join(format!("{name}.txt")))
        .map_err(|err| format!("cannot read profile '{name}': {err}"))?;
    parse(&text)
}

/// Splits the optional `tools: a, b` first line from the instructions. Every name must be a tool.
fn parse(text: &str) -> Result<Profile, String> {
    let (first, rest) = text.split_once('\n').unwrap_or((text, ""));
    let Some(list) = first.trim().strip_prefix("tools:") else {
        return Ok(Profile { instructions: text.to_string(), tools: None });
    };
    let tools: Vec<String> =
        list.split(',').map(str::trim).filter(|name| !name.is_empty()).map(str::to_string).collect();
    let known = |name: &str| specs().iter().any(|spec| spec.name == name);
    if let Some(unknown) = tools.iter().find(|name| !known(name)) {
        return Err(format!("unknown tool '{unknown}' in the profile's tools line"));
    }
    Ok(Profile { instructions: rest.to_string(), tools: Some(tools) })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compaction_removes_the_profile_from_what_is_carried() {
        use crate::environment::Environment;
        use crate::session::{Conversation, Turn};
        use std::path::PathBuf;

        let marked_text = marked("coder", "be brief");
        let mut conversation = Conversation::new(&Environment { cwd: PathBuf::from("C:/work") });
        let turn = Turn::new(vec![
            Message::User(format!("{marked_text}\n\nhi")),
            Message::Assistant { content: "hello".into(), tool_calls: Vec::new() },
        ])
        .expect("a valid turn");
        conversation.commit(turn);
        assert!(carried(conversation.messages(), &marked_text));
        // Compaction keeps the last two turns, so two more turns push the profile's turn out.
        for input in ["next", "last"] {
            let plain = Turn::new(vec![
                Message::User(input.into()),
                Message::Assistant { content: "ok".into(), tool_calls: Vec::new() },
            ])
            .expect("a valid turn");
            conversation.commit(plain);
        }
        conversation.compact("summary".into());
        assert!(!carried(conversation.messages(), &marked_text));
    }

    #[test]
    fn tools_line_sets_the_whitelist_and_leaves_the_instructions() {
        let profile = parse("tools: read_file, list_directory\nbe brief").expect("valid profile");
        assert_eq!(profile.tools, Some(vec!["read_file".to_string(), "list_directory".to_string()]));
        assert_eq!(profile.instructions, "be brief");
    }

    #[test]
    fn profile_without_tools_line_has_no_whitelist() {
        let profile = parse("be brief").expect("valid profile");
        assert!(profile.tools.is_none());
        assert_eq!(profile.instructions, "be brief");
    }

    #[test]
    fn unknown_tool_in_whitelist_is_rejected() {
        let error = parse("tools: delete_everything\nbe brief").err().expect("expected the whitelist to be rejected");
        assert!(error.contains("unknown tool 'delete_everything'"));
    }

    #[test]
    fn load_rejects_names_that_leave_the_folder() {
        let error = load("../secret").expect_err("expected the name to be rejected");
        assert!(error.contains("is not a profile name"));
    }
}
