//! The commands that act on the tools, the notes and the saved sessions. Each one reports its result, or its failure,
//! through the frontend. The typed writes go through the runner without a prompt.

use crate::commands::Command;
use crate::frontend::Frontend;
use crate::notes;
use crate::saved_sessions;
use crate::session::Conversation;
use crate::tools::types::{Invocation, ToolRunner};
use std::path::Path;

/// One line per tool in the catalogue, with whether the model may call it.
pub(super) fn tool_list(tools: &dyn ToolRunner) -> String {
    let enabled = tools.enabled();
    crate::tools::specs()
        .iter()
        .map(|spec| {
            let state = if enabled.contains(&spec.name) { "enabled" } else { "disabled" };
            format!("{}: {state}", spec.name)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Runs a write the user typed. The typed command is the approval, so no prompt is shown. Writes the model asks for still
/// wait for approval in the runner.
fn typed_write(tools: &dyn ToolRunner, invocation: &Invocation, ui: &mut dyn Frontend) {
    match tools.run(invocation, &mut |_: &str| true) {
        Ok(message) => ui.notice(message),
        Err(err) => ui.error(err.to_string()),
    }
}

/// Enables or disables a tool, reporting the result or the failure through `ui`.
pub(super) fn toggle(tools: &dyn ToolRunner, name: &str, on: bool, ui: &mut dyn Frontend) {
    match tools.set_enabled(name, on) {
        Ok(()) => ui.notice(format!("{name}: {}", if on { "enabled" } else { "disabled" })),
        Err(err) => ui.error(err.to_string()),
    }
}

/// The note commands. Writes go through the runner, which still checks the note whitelist and the other guards.
pub(super) fn note_command(command: Command, tools: &dyn ToolRunner, ui: &mut dyn Frontend) {
    match command {
        Command::ListNotes(category) => match notes::list(&tools.notes_folder(), &category, None) {
            Ok(listing) => {
                for line in listing.skipped {
                    ui.error(line);
                }
                if listing.notes.is_empty() {
                    ui.notice("no notes".to_string());
                } else {
                    ui.notice(notes::describe_list(&listing.notes));
                }
            }
            Err(err) => ui.error(err),
        },
        Command::ShowNote(name) => match notes::read(&tools.notes_folder(), &name) {
            Ok(note) => ui.notice(notes::show(&note)),
            Err(err) => ui.error(err),
        },
        Command::CreateNote(name, category) => {
            let placeholder = Invocation::CreateNote {
                name,
                summary: "placeholder".into(),
                category,
                content: String::new(),
            };
            typed_write(tools, &placeholder, ui)
        }
        Command::DeleteNote(name) => typed_write(tools, &Invocation::DeleteNote { name }, ui),
        _ => {}
    }
}

/// Saves the conversation as a session in `sessions`. A typed command does not prompt; a name that is taken or invalid
/// is refused by the save.
pub(super) fn save_session(name: &str, conversation: &Conversation, sessions: &Path, ui: &mut dyn Frontend) {
    match saved_sessions::save(sessions, name, conversation.history(), conversation.requests()) {
        Ok(()) => ui.notice(format!("session {name} saved")),
        Err(err) => ui.error(err.to_string()),
    }
}

/// The session commands: listing, saving, and loading the conversation.
pub(super) fn session_command(command: Command, conversation: &mut Conversation, sessions: &Path, ui: &mut dyn Frontend) {
    match command {
        Command::Sessions => match saved_sessions::names(sessions) {
            Ok(names) if names.is_empty() => ui.notice("no sessions: /save NAME stores the conversation".to_string()),
            Ok(names) => ui.notice(names.join("\n")),
            Err(err) => ui.error(err.to_string()),
        },
        Command::Save(name) => save_session(&name, conversation, sessions, ui),
        Command::Load(name) => match saved_sessions::load(sessions, &name) {
            Ok(history) => {
                conversation.replace_history(history);
                ui.notice(format!("session {name} loaded"));
            }
            Err(err) => ui.error(err.to_string()),
        },
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frontend::test_support::TextUi;
    use crate::tools::types::{ToolError, ToolRunner};

    /// Creates a note only if the approval it is given accepts the change, as the runner does for a write.
    struct Approving;

    impl ToolRunner for Approving {
        fn run(&self, _invocation: &Invocation, approve: &mut dyn FnMut(&str) -> bool) -> Result<String, ToolError> {
            if approve("create note") { Ok("created note".into()) } else { Err(ToolError::Failed("declined".into())) }
        }
    }

    #[test]
    fn the_users_own_create_is_not_asked_for_approval() {
        // A declined prompt would answer "no", so a create that still succeeds was not asked.
        let mut ui = TextUi::new();
        note_command(Command::CreateNote("b".into(), "profile".into()), &Approving, &mut ui);
        assert_eq!(ui.output, "created note\n");
        assert!(ui.errors.is_empty());
        assert!(ui.asked.is_empty(), "the user is not asked about their own command");
    }
}
