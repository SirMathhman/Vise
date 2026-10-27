//! Profiles: named instructions kept as `.txt` files in the `profiles` folder. A profile's text is sent
//! with the next user message, so the system prompt at the start of the history never changes.

use crate::notes;
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

/// A profile: its instructions, the tools it allows if its file has a `tools:` line, and the notes it allows if
/// it has a `notes:` line.
#[derive(Debug)]
pub struct Profile {
    pub instructions: String,
    pub tools: Option<Vec<String>>,
    pub notes: Option<Vec<String>>,
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

/// Splits the header lines (`tools: a, b` and `notes: a, b`, in any order) from the instructions. Every tool
/// name must be a tool, and every note name must be a valid note name.
fn parse(text: &str) -> Result<Profile, String> {
    let (mut tools, mut notes) = (None, None);
    let mut instructions = text;
    loop {
        let (first, rest) = instructions.split_once('\n').unwrap_or((instructions, ""));
        let header = first.trim();
        if let Some(list) = header.strip_prefix("tools:") {
            let listed = header_names(list);
            let known = |name: &str| specs().iter().any(|spec| spec.name == name);
            if let Some(unknown) = listed.iter().find(|name| !known(name)) {
                return Err(format!("unknown tool '{unknown}' in the profile's tools line"));
            }
            tools = Some(listed);
        } else if let Some(list) = header.strip_prefix("notes:") {
            let listed = header_names(list);
            if let Some(invalid) = listed.iter().find(|name| !notes::valid_name(name)) {
                return Err(format!("'{invalid}' is not a note name in the profile's notes line"));
            }
            notes = Some(listed);
        } else {
            break;
        }
        instructions = rest;
    }
    Ok(Profile { instructions: instructions.to_string(), tools, notes })
}

/// The comma-separated names on a header line.
fn header_names(list: &str) -> Vec<String> {
    list.split(',').map(str::trim).filter(|name| !name.is_empty()).map(str::to_string).collect()
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
    fn notes_line_is_read_with_the_tools_line() {
        let profile = parse("notes: greeting, plan\ntools: read_file\nbe brief").expect("valid profile");
        assert_eq!(profile.notes, Some(vec!["greeting".to_string(), "plan".to_string()]));
        assert_eq!(profile.tools, Some(vec!["read_file".to_string()]));
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
