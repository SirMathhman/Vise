//! Profiles: named instructions kept as notes with the category `profile`, in the notes folder. A profile's header
//! lines (`tools:`, `notes:`, `hook KIND: COMMAND`) sit with the note's other header lines, and its text is the note's
//! content. A profile's text is sent with the next user message, so the system prompt at the start of the history never
//! changes.

use crate::notes::{self, Note};
use crate::session::{HookLines, Message};
use crate::tools::specs;
use crate::tools::types::ToolRunner;
use std::path::Path;

/// The profile every run has without a note: no instructions, every tool and note allowed, and no hooks.
pub const DEFAULT: &str = "default";
/// The category of a note that is a profile.
const CATEGORY: &str = "profile";
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

/// The profile names, sorted: the built-in default and the notes in `folder` whose category is `profile`.
pub fn names(folder: &Path) -> Result<Vec<String>, String> {
    let mut names: Vec<String> = notes::list(folder, CATEGORY, None)?.into_iter().map(|(name, _)| name).collect();
    if !names.iter().any(|name| name == DEFAULT) {
        names.push(DEFAULT.to_string());
    }
    names.sort();
    Ok(names)
}

/// Tells `tools` that the user has seen the hook lines of every profile that exists now. `main` calls it at launch, before
/// the model can write anything, so a subagent runs these profiles' hooks and not those of a profile written later.
pub fn confirm_existing(tools: &dyn ToolRunner) {
    let folder = tools.notes_folder();
    for name in names(&folder).unwrap_or_default() {
        if let Ok(profile) = load(&folder, &name) {
            tools.confirm_hooks(&name, &profile.hooks.fingerprint());
        }
    }
}

/// A profile: its instructions, the tools it allows if it has a `tools:` line, the notes it allows if
/// it has a `notes:` line, and the hooks its `hook KIND: COMMAND` lines bind.
#[derive(Debug)]
pub struct Profile {
    pub instructions: String,
    pub tools: Option<Vec<String>>,
    pub notes: Option<Vec<String>>,
    pub hooks: HookLines,
}

/// Loads one profile from the notes in `folder`. Only letters, digits, '-' and '_' are accepted in a name, so a name
/// cannot reach outside the folder. The note's category must be `profile`.
pub fn load(folder: &Path, name: &str) -> Result<Profile, String> {
    let valid = !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !valid {
        return Err(format!("'{name}' is not a profile name; use letters, digits, '-' and '_'"));
    }
    if name == DEFAULT {
        return Ok(Profile { instructions: String::new(), tools: None, notes: None, hooks: HookLines::default() });
    }
    let note = notes::read(folder, name)
        .map_err(|err| format!("cannot read profile '{name}' (a note with the category {CATEGORY}): {err}"))?;
    if note.category != CATEGORY {
        return Err(format!("note '{name}' is not a profile: its category is '{}'", note.category));
    }
    from_note(note)
}

/// A profile from its note: the note's other header lines set the tools, notes and hooks, and its content is the
/// instructions. A header line that is none of those is an error, so a misspelt `tools:` line is not ignored.
fn from_note(note: Note) -> Result<Profile, String> {
    let mut header = Header::default();
    for line in &note.extra {
        if !apply_header(&mut header, line)? {
            return Err(format!("unknown header line '{line}' in the profile; use tools:, notes: or hook KIND: COMMAND"));
        }
    }
    Ok(Profile { instructions: note.content, tools: header.tools, notes: header.notes, hooks: header.hooks })
}

/// What a profile's header lines have set so far.
#[derive(Default)]
struct Header {
    tools: Option<Vec<String>>,
    notes: Option<Vec<String>>,
    hooks: HookLines,
}

/// Applies one header line (`tools: a, b`, `notes: a, b`, or `hook KIND: COMMAND`). Every tool name must be a tool,
/// every note name must be a valid note name, and every hook kind must be a known one. Returns false, and changes
/// nothing, when the line is none of these.
fn apply_header(header: &mut Header, line: &str) -> Result<bool, String> {
    let line = line.trim();
    if let Some(list) = line.strip_prefix("tools:") {
        let listed = header_names(list);
        let known = |name: &str| specs().iter().any(|spec| spec.name == name);
        if let Some(unknown) = listed.iter().find(|name| !known(name)) {
            return Err(format!("unknown tool '{unknown}' in the profile's tools line"));
        }
        header.tools = Some(listed);
    } else if let Some(list) = line.strip_prefix("notes:") {
        let listed = header_names(list);
        if let Some(invalid) = listed.iter().find(|name| !notes::valid_name(name)) {
            return Err(format!("'{invalid}' is not a note name in the profile's notes line"));
        }
        header.notes = Some(listed);
    } else if let Some(hook) = line.strip_prefix("hook ") {
        add_hook(&mut header.hooks, hook)?;
    } else {
        return Ok(false);
    }
    Ok(true)
}

/// Splits the header lines (in any order) from the instructions in the text of a profile, one line at a time, until
/// the first line that is not a header line.
#[cfg(test)]
fn parse(text: &str) -> Result<Profile, String> {
    let mut header = Header::default();
    let mut instructions = text;
    loop {
        let (first, rest) = instructions.split_once('\n').unwrap_or((instructions, ""));
        if !apply_header(&mut header, first)? {
            break;
        }
        instructions = rest;
    }
    Ok(Profile { instructions: instructions.to_string(), tools: header.tools, notes: header.notes, hooks: header.hooks })
}

/// Adds one `KIND: COMMAND` hook line, from a `hook` header line without its keyword, to the hooks of that kind.
fn add_hook(hooks: &mut HookLines, hook: &str) -> Result<(), String> {
    let (kind, command) =
        hook.split_once(':').ok_or_else(|| format!("'hook {hook}' needs a kind and a command, as in 'hook before-turn: COMMAND'"))?;
    let command = command.trim();
    if command.is_empty() {
        return Err(format!("'hook {hook}' has no command"));
    }
    let lines = match kind.trim() {
        "startup" => &mut hooks.startup,
        "shutdown" => &mut hooks.shutdown,
        "before-turn" => &mut hooks.before_turn,
        "after-turn" => &mut hooks.after_turn,
        other => return Err(format!("unknown hook kind '{other}'; use startup, shutdown, before-turn or after-turn")),
    };
    lines.push(command.to_string());
    Ok(())
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
        conversation.compact("summary".into(), Default::default());
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
    fn hook_lines_are_bound_by_their_kind() {
        let profile = parse("hook before-turn: Write-Output a\nhook after-turn: Write-Output b\nbe brief").expect("valid profile");
        assert_eq!(profile.hooks.before_turn, vec!["Write-Output a".to_string()]);
        assert_eq!(profile.hooks.after_turn, vec!["Write-Output b".to_string()]);
        assert_eq!(profile.instructions, "be brief");
    }

    #[test]
    fn hook_lines_without_a_command_or_a_colon_are_rejected() {
        assert!(parse("hook startup:\nbe brief").is_err());
        assert!(parse("hook shutdown\nbe brief").is_err());
    }

    #[test]
    fn unknown_hook_kind_is_rejected() {
        let error = parse("hook middle: Write-Output a\nbe brief").err().expect("expected the hook to be rejected");
        assert!(error.contains("unknown hook kind 'middle'"));
    }

    /// A notes folder under the temp folder holding `files` as `NAME.md`. The test removes it.
    fn notes_with(tag: &str, files: &[(&str, &str)]) -> std::path::PathBuf {
        let folder = std::env::temp_dir().join(format!("vise-profile-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&folder);
        std::fs::create_dir_all(&folder).expect("the test folder is made");
        for (name, text) in files {
            std::fs::write(folder.join(format!("{name}.md")), text).expect("the note is written");
        }
        folder
    }

    #[test]
    fn default_profile_is_built_in() {
        let folder = notes_with("default", &[]);
        let loaded = load(&folder, DEFAULT).expect("default needs no note");
        assert!(loaded.instructions.is_empty() && loaded.tools.is_none() && loaded.notes.is_none());
        let listed = names(&folder).expect("names");
        std::fs::remove_dir_all(&folder).expect("the test folder is removed");
        assert!(listed.contains(&DEFAULT.to_string()));
    }

    #[test]
    fn load_rejects_names_that_leave_the_folder() {
        let folder = notes_with("names", &[]);
        let error = load(&folder, "../secret").expect_err("expected the name to be rejected");
        std::fs::remove_dir_all(&folder).expect("the test folder is removed");
        assert!(error.contains("is not a profile name"));
    }

    #[test]
    fn a_profile_note_sets_the_tools_notes_hooks_and_instructions() {
        let text = "---\nsummary: reader\ncategory: profile\ntools: read_file\nnotes: plan\nhook before-turn: Get-Date\n---\nbe brief";
        let folder = notes_with("load", &[("reader", text)]);
        let profile = load(&folder, "reader").expect("a profile note loads");
        std::fs::remove_dir_all(&folder).expect("the test folder is removed");
        assert_eq!(profile.tools, Some(vec!["read_file".to_string()]));
        assert_eq!(profile.notes, Some(vec!["plan".to_string()]));
        assert_eq!(profile.hooks.before_turn, vec!["Get-Date".to_string()]);
        assert_eq!(profile.instructions, "be brief");
    }

    #[test]
    fn a_note_with_another_category_is_not_a_profile() {
        let folder = notes_with("category", &[("plan", "---\nsummary: s\ncategory: memory\n---\ntext")]);
        let error = load(&folder, "plan").expect_err("expected the category to be refused");
        std::fs::remove_dir_all(&folder).expect("the test folder is removed");
        assert!(error.contains("is not a profile"), "{error}");
    }

    #[test]
    fn an_unknown_header_line_in_a_profile_note_is_refused() {
        let folder = notes_with("unknown", &[("odd", "---\nsummary: s\ncategory: profile\ntool: read_file\n---\ntext")]);
        let error = load(&folder, "odd").expect_err("expected the header line to be refused");
        std::fs::remove_dir_all(&folder).expect("the test folder is removed");
        assert!(error.contains("unknown header line 'tool: read_file'"), "{error}");
    }

    #[test]
    fn only_notes_with_the_profile_category_are_listed() {
        let folder = notes_with(
            "list",
            &[
                ("explore", "---\nsummary: s\ncategory: profile\n---\ntext"),
                ("plan", "---\nsummary: s\ncategory: memory\n---\ntext"),
            ],
        );
        let listed = names(&folder).expect("names");
        std::fs::remove_dir_all(&folder).expect("the test folder is removed");
        assert_eq!(listed, vec!["default".to_string(), "explore".to_string()]);
    }
}
