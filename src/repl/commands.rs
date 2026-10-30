//! The slash commands that act on the tools, the notes and the saved sessions. Each one writes its result to the
//! output, or its failure to the errors, and the writes it asks for go through the runner's approval.

use super::ask;
use crate::commands::Command;
use crate::notes;
use crate::saved_sessions;
use crate::session::Conversation;
use crate::tools::types::{Invocation, ToolRunner};
use std::io::{self, BufRead, Write};

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

/// Runs a write the user asked for. It goes through the runner, so the user sees the same description and
/// approval a write from the model gets.
pub(super) fn user_write(
    tools: &dyn ToolRunner,
    invocation: &Invocation,
    output: &mut impl Write,
    input: &mut impl BufRead,
    errors: &mut impl Write,
) -> io::Result<()> {
    let mut approve = |change: &str| ask(change, &mut *output, &mut *input);
    match tools.run(invocation, &mut approve) {
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

/// The note commands. Writes go through the runner, so the user sees the same approval a write from the model gets.
pub(super) fn note_command(
    command: Command,
    tools: &dyn ToolRunner,
    output: &mut impl Write,
    input: &mut impl BufRead,
    errors: &mut impl Write,
) -> io::Result<()> {
    match command {
        Command::ListNotes(category) => match notes::list(&category, None) {
            Ok(listed) if listed.is_empty() => writeln!(output, "no notes"),
            Ok(listed) => writeln!(output, "{}", notes::describe_list(&listed)),
            Err(err) => writeln!(errors, "error: {err}"),
        },
        Command::ShowNote(name) => match notes::read(&name) {
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
            // The user's own command is the approval, so no prompt is shown. Writes the model asks for still wait.
            match tools.run(&placeholder, &mut |_: &str| true) {
                Ok(message) => writeln!(output, "{message}"),
                Err(err) => writeln!(errors, "error: {err}"),
            }
        }
        Command::DeleteNote(name) => user_write(tools, &Invocation::DeleteNote { name }, output, input, errors),
        _ => Ok(()),
    }
}

/// Saves the conversation as a session once the user approves it, the same approval a model write gets. A name
/// that is taken or invalid is refused before the user is asked.
pub(super) fn save_session(
    name: &str,
    conversation: &Conversation,
    output: &mut impl Write,
    input: &mut impl BufRead,
    errors: &mut impl Write,
) -> io::Result<()> {
    if let Err(err) = saved_sessions::check_save(name) {
        return writeln!(errors, "error: {err}");
    }
    let history = conversation.history();
    let change = format!("save session {name} ({} messages) to sessions/{}", history.len(), saved_sessions::DATABASE);
    if !ask(&change, output, input) {
        return writeln!(output, "session {name} not saved");
    }
    match saved_sessions::save(name, history, conversation.requests()) {
        Ok(()) => writeln!(output, "session {name} saved"),
        Err(err) => writeln!(errors, "error: {err}"),
    }
}

/// The session commands: listing, saving, and loading the conversation.
pub(super) fn session_command(
    command: Command,
    conversation: &mut Conversation,
    output: &mut impl Write,
    input: &mut impl BufRead,
    errors: &mut impl Write,
) -> io::Result<()> {
    match command {
        Command::Sessions => match saved_sessions::names() {
            Ok(names) if names.is_empty() => writeln!(output, "no sessions: /save NAME stores the conversation"),
            Ok(names) => writeln!(output, "{}", names.join("\n")),
            Err(err) => writeln!(errors, "error: {err}"),
        },
        Command::Save(name) => save_session(&name, conversation, output, input, errors),
        Command::Load(name) => match saved_sessions::load(&name) {
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
        let mut input: &[u8] = b"n
";
        note_command(Command::CreateNote("b".into(), "profile".into()), &Approving, &mut output, &mut input, &mut errors)
            .unwrap();
        assert_eq!(String::from_utf8(output).unwrap(), "created note
");
        assert!(errors.is_empty());
    }
}
