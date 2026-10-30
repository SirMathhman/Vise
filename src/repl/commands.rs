//! The slash commands that act on the tools, the notes and the saved sessions. Each one writes its result to the
//! output, or its failure to the errors. The typed writes go through the runner without a prompt.

use crate::commands::Command;
use crate::notes;
use crate::saved_sessions;
use crate::session::Conversation;
use crate::tools::types::{Invocation, ToolRunner};
use std::io::{self, Write};
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
fn typed_write(tools: &dyn ToolRunner, invocation: &Invocation, output: &mut impl Write, errors: &mut impl Write) -> io::Result<()> {
    match tools.run(invocation, &mut |_: &str| true) {
        Ok(message) => writeln!(output, "{message}"),
        Err(err) => writeln!(errors, "error: {err}"),
    }
}

/// Enables or disables a tool, reporting the result on `output` or the failure on `errors`.
pub(super) fn toggle(
    tools: &dyn ToolRunner,
    name: &str,
    on: bool,
    output: &mut impl Write,
    errors: &mut impl Write,
) -> io::Result<()> {
    match tools.set_enabled(name, on) {
        Ok(()) => writeln!(output, "{name}: {}", if on { "enabled" } else { "disabled" }),
        Err(err) => writeln!(errors, "error: {err}"),
    }
}

/// The note commands. Writes go through the runner, which still checks the note whitelist and the other guards.
pub(super) fn note_command(
    command: Command,
    tools: &dyn ToolRunner,
    output: &mut impl Write,
    errors: &mut impl Write,
) -> io::Result<()> {
    match command {
        Command::ListNotes(category) => match notes::list(&tools.notes_folder(), &category, None) {
            Ok(listing) => {
                for line in &listing.skipped {
                    writeln!(errors, "error: {line}")?;
                }
                if listing.notes.is_empty() {
                    writeln!(output, "no notes")
                } else {
                    writeln!(output, "{}", notes::describe_list(&listing.notes))
                }
            }
            Err(err) => writeln!(errors, "error: {err}"),
        },
        Command::ShowNote(name) => match notes::read(&tools.notes_folder(), &name) {
            Ok(note) => writeln!(output, "{}", notes::show(&note)),
            Err(err) => writeln!(errors, "error: {err}"),
        },
        Command::CreateNote(name, category) => {
            let placeholder = Invocation::CreateNote {
                name,
                summary: "placeholder".into(),
                category,
                content: String::new(),
            };
            typed_write(tools, &placeholder, output, errors)
        }
        Command::DeleteNote(name) => typed_write(tools, &Invocation::DeleteNote { name }, output, errors),
        _ => Ok(()),
    }
}

/// Saves the conversation as a session in `sessions`. A typed command does not prompt; a name that is taken or invalid
/// is refused by the save.
pub(super) fn save_session(
    name: &str,
    conversation: &Conversation,
    sessions: &Path,
    output: &mut impl Write,
    errors: &mut impl Write,
) -> io::Result<()> {
    match saved_sessions::save(sessions, name, conversation.history(), conversation.requests()) {
        Ok(()) => writeln!(output, "session {name} saved"),
        Err(err) => writeln!(errors, "error: {err}"),
    }
}

/// The session commands: listing, saving, and loading the conversation.
pub(super) fn session_command(
    command: Command,
    conversation: &mut Conversation,
    sessions: &Path,
    output: &mut impl Write,
    errors: &mut impl Write,
) -> io::Result<()> {
    match command {
        Command::Sessions => match saved_sessions::names(sessions) {
            Ok(names) if names.is_empty() => writeln!(output, "no sessions: /save NAME stores the conversation"),
            Ok(names) => writeln!(output, "{}", names.join("\n")),
            Err(err) => writeln!(errors, "error: {err}"),
        },
        Command::Save(name) => save_session(&name, conversation, sessions, output, errors),
        Command::Load(name) => match saved_sessions::load(sessions, &name) {
            Ok(history) => {
                conversation.replace_history(history);
                writeln!(output, "session {name} loaded")
            }
            Err(err) => writeln!(errors, "error: {err}"),
        },
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
        // A declined prompt would answer "n", so a create that still succeeds was not asked.
        let mut output = Vec::new();
        let mut errors = Vec::new();
        note_command(Command::CreateNote("b".into(), "profile".into()), &Approving, &mut output, &mut errors).unwrap();
        assert_eq!(String::from_utf8(output).unwrap(), "created note
");
        assert!(errors.is_empty());
    }
}
