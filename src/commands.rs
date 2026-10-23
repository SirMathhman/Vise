use crate::notes;
use crate::tools::{self, Switches};
use crate::workspace;
use std::path::Path;

/// Handles a `/tools`, `/enable <tool>`, or `/disable <tool>` line. Returns the text to show,
/// or `None` if the line is not one of these commands.
pub fn handle(line: &str, switches: &Switches) -> Option<String> {
    let mut words = line.split_whitespace();
    match words.next()? {
        "/tools" => Some(list(switches)),
        "/enable" => Some(set(words.next(), true, switches)),
        "/disable" => Some(set(words.next(), false, switches)),
        _ => None,
    }
}

fn list(switches: &Switches) -> String {
    let disabled = switches.snapshot();
    tools::NAMES
        .iter()
        .map(|name| {
            let state = if disabled.contains(*name) { "off" } else { "on" };
            format!("{name}: {state}")
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn set(name: Option<&str>, enabled: bool, switches: &Switches) -> String {
    match name {
        Some(name) if tools::NAMES.contains(&name) => {
            switches.set(name, enabled);
            let state = if enabled { "enabled" } else { "disabled" };
            format!("{name} {state}")
        }
        Some(name) => format!("error: unknown tool {name}"),
        None => "usage: /enable <tool> or /disable <tool>".to_owned(),
    }
}

/// What choosing a profile gives back: the reply to show, and the text the conversation takes as instructions.
pub struct Choice {
    pub reply: String,
    pub instructions: String,
}

/// Handles `/profile <scope>/<category>/<name>`. When the profile has a tool list, the tools on the list are
/// switched on for this session and every other tool is switched off. Returns `None` if the line is not this
/// command.
pub fn profile(line: &str, switches: &Switches, roots: notes::Roots) -> Option<Result<Choice, String>> {
    if line.split_whitespace().eq(["/profile", "default"]) {
        return Some(Ok(default_profile(switches, roots.working)));
    }
    let chosen = notes::profile_command(line, roots)?;
    Some(chosen.and_then(|profile| choose(profile, switches)))
}

/// The built-in default profile. It is applied when a conversation starts. `None` leaves the tool switches alone,
/// and an empty text adds nothing to the conversation.
const DEFAULT_TOOLS: Option<&[&str]> = None;
const DEFAULT_INSTRUCTIONS: &str = "";

/// Applies the built-in default profile, as a new conversation does. The working directory's AGENTS.md, if it has
/// one, joins the instructions too. The instructions come back empty when there is neither.
pub fn default_profile(switches: &Switches, root: Option<&Path>) -> Choice {
    if let Some(names) = DEFAULT_TOOLS {
        set_tools(names, switches);
    }
    let mut parts = Vec::new();
    if !DEFAULT_INSTRUCTIONS.is_empty() {
        parts.push(format!("[Profile default is active. Follow these instructions from now on.]\n\n{DEFAULT_INSTRUCTIONS}"));
    }
    parts.extend(project_instructions(root));
    Choice { reply: "Default profile is active.".to_owned(), instructions: parts.join("\n\n") }
}

/// The file whose text joins every new conversation, read from the working directory.
const PROJECT_FILE: &str = "AGENTS.md";

/// The instructions from the working directory's AGENTS.md. `None` when there is no working directory, or the file
/// is missing, unreadable, or blank. The path goes through the same confinement as the file tools.
fn project_instructions(root: Option<&Path>) -> Option<String> {
    let path = workspace::resolve(root, PROJECT_FILE, false).ok()?;
    let text = std::fs::read_to_string(path).ok()?;
    (!text.trim().is_empty()).then(|| format!("[Project instructions from {PROJECT_FILE}. Follow these instructions from now on.]\n\n{text}"))
}

/// Switches on the tools in `names` and switches every other tool off.
fn set_tools<S: AsRef<str>>(names: &[S], switches: &Switches) {
    for name in tools::NAMES {
        switches.set(name, names.iter().any(|listed| listed.as_ref() == name));
    }
}

fn choose(profile: notes::Profile, switches: &Switches) -> Result<Choice, String> {
    let reply = match &profile.tools {
        Some(names) => {
            if let Some(unknown) = names.iter().find(|name| !tools::NAMES.contains(&name.as_str())) {
                return Err(format!("profile {} lists an unknown tool: {unknown}", profile.label));
            }
            set_tools(names, switches);
            format!("Profile {} is active. Tools on: {}.", profile.label, names.join(", "))
        }
        None => format!("Profile {} is active. Tools are unchanged.", profile.label),
    };
    let instructions = format!(
        "[Profile {} is active. Follow these instructions from now on.]\n\n{}",
        profile.label, profile.instructions
    );
    Ok(Choice { reply, instructions })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_profile_leaves_tools_and_adds_no_instructions() {
        let switches = Switches::default();
        switches.set("delete_file", false);
        let roots = notes::Roots { working: None, home: None };
        let choice = profile("/profile default", &switches, roots).unwrap().unwrap();

        assert_eq!(choice.reply, "Default profile is active.");
        assert!(choice.instructions.is_empty());
        assert!(switches.snapshot().contains("delete_file"));
    }

    #[test]
    fn the_default_profile_carries_the_working_directorys_agents_file() {
        let root = std::env::temp_dir().join(format!("vise-agents-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("AGENTS.md"), "Run cargo test.\n").unwrap();
        let roots = notes::Roots { working: Some(&root), home: None };
        let choice = profile("/profile default", &Switches::default(), roots).unwrap().unwrap();
        std::fs::remove_dir_all(&root).unwrap();

        assert!(choice.instructions.starts_with("[Project instructions from AGENTS.md."));
        assert!(choice.instructions.ends_with("Run cargo test.\n"));
    }

    #[test]
    fn the_default_profile_adds_nothing_without_an_agents_file() {
        let root = std::env::temp_dir().join(format!("vise-no-agents-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let roots = notes::Roots { working: Some(&root), home: None };
        let choice = profile("/profile default", &Switches::default(), roots).unwrap().unwrap();
        std::fs::remove_dir_all(&root).unwrap();

        assert!(choice.instructions.is_empty());
    }

    #[test]
    fn choosing_a_profile_switches_tools_to_its_list() {
        use serde_json::json;

        let root = std::env::temp_dir().join(format!("vise-profile-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let roots = notes::Roots { working: Some(&root), home: None };
        let content = "---\nname: r\nsummary: S\nprofile: true\ntools: list_files, read_file\n---\nBe careful.\n";
        notes::run(notes::CREATE_NOTE, &json!({ "category": "c", "name": "r", "content": content }).to_string(), roots)
            .unwrap();
        let switches = Switches::default();
        let choice = profile("/profile local/c/r", &switches, roots).unwrap();
        let off = switches.snapshot();
        std::fs::remove_dir_all(&root).unwrap();

        assert!(choice.unwrap().instructions.ends_with("Be careful."));
        assert!(off.contains("delete_file"));
        assert!(!off.contains("list_files") && !off.contains("read_file"));
    }

    #[test]
    fn disable_and_enable_switch_a_tool_off_and_on() {
        let switches = Switches::default();

        assert_eq!(handle("/disable delete_file", &switches).unwrap(), "delete_file disabled");
        assert!(switches.snapshot().contains("delete_file"));
        assert_eq!(handle("/enable delete_file", &switches).unwrap(), "delete_file enabled");
        assert!(!switches.snapshot().contains("delete_file"));
        assert_eq!(handle("hello", &switches), None);
    }
}
