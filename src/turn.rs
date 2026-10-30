//! The turn logic: building a turn's message, running it with compaction, and the profile hooks that a turn or a
//! subagent applies. The chat loop in `repl` and the subagents in `subagent` both use it.

use crate::before_turn;
use crate::error::ProviderError;
use crate::file_commands::run_lines;
use crate::notes;
use crate::profile;
use crate::provider::types::{Event, Provider, SubagentRunner};
use crate::session::{Conversation, HookLines, Turn};
use crate::tools::specs;
use crate::tools::types::{ToolError, ToolRunner};
use std::io::{self, Write};

/// Makes the profile's whitelist the enabled set: exactly the listed tools. A profile without a whitelist
/// enables every tool. Returns one line for each tool whose state changed.
pub fn apply_whitelist(tools: &dyn ToolRunner, whitelist: Option<&[String]>) -> Result<Vec<String>, ToolError> {
    let allowed: Vec<&str> = match whitelist {
        Some(names) => names.iter().map(String::as_str).collect(),
        None => specs().iter().map(|spec| spec.name).collect(),
    };
    let enabled = tools.enabled();
    let mut changes = Vec::new();
    for spec in specs() {
        let on = allowed.contains(&spec.name);
        if enabled.contains(&spec.name) != on {
            tools.set_enabled(spec.name, on)?;
            changes.push(format!("{}: {}", spec.name, if on { "enabled" } else { "disabled" }));
        }
    }
    Ok(changes)
}

/// Makes a profile's hooks the active ones. Its startup-type lines run now, and their output goes to the model with
/// the next message.
pub fn select_hooks(
    hooks: HookLines,
    conversation: &mut Conversation,
    tools: &dyn ToolRunner,
    output: &mut impl Write,
    errors: &mut impl Write,
) -> io::Result<()> {
    let results = run_lines(&hooks.startup, "profile startup", tools, output, errors)?;
    let blocks: Vec<String> =
        results.iter().map(|(command, result)| format!("Startup command: {command}\n{result}")).collect();
    conversation.set_profile_hooks(hooks);
    if !blocks.is_empty() {
        conversation.append_startup(blocks.join("\n\n"));
    }
    Ok(())
}

/// The global lines of a hook type, followed by the selected profile's lines of that type.
pub fn hook_lines(global: &[String], profile: &[String]) -> Vec<String> {
    global.iter().chain(profile).cloned().collect()
}

/// The message a turn sends: the before-turn output, the startup text, the profile text, and the notes index, each
/// added where the history does not already carry it. Errors are reported on `errors`.
pub fn prepare_message(
    line: String,
    profile: Option<&str>,
    conversation: &Conversation,
    tools: &dyn ToolRunner,
    output: &mut impl Write,
    errors: &mut impl Write,
) -> io::Result<String> {
    let before_lines = hook_lines(conversation.before_turn(), &conversation.profile_hooks().before_turn);
    let before = before_turn::run(&before_lines, tools, output, errors)?;
    let line = match before {
        Some(text) => format!("{text}\n\n{line}"),
        None => line,
    };
    let line = match conversation.startup() {
        Some(text) => format!("{text}\n\n{line}"),
        None => line,
    };
    let message = match profile {
        Some(text) if !profile::carried(conversation.messages(), text) => format!("{text}\n\n{line}"),
        _ => line,
    };
    Ok(match notes::index(tools.allowed_notes().as_deref()) {
        Ok(index) if notes::needed(conversation.messages(), &index) => format!("{index}\n\n{message}"),
        Ok(_) => message,
        Err(err) => {
            writeln!(errors, "error: {err}")?;
            message
        }
    })
}

/// How the history was shrunk: replaced by a summary, or cut by dropping the oldest turn.
#[derive(Clone, Copy)]
pub enum Compaction {
    Summarized,
    Dropped(usize),
}

/// Replaces the older history with a summary the model writes of it. If the summary request does not
/// fit in the context, the oldest turn is dropped instead.
pub fn compact(provider: &dyn Provider, conversation: &mut Conversation) -> Result<Compaction, ProviderError> {
    match provider.summarize(conversation.messages()) {
        Ok(summary) => {
            conversation.compact(summary);
            Ok(Compaction::Summarized)
        }
        Err(ProviderError::ContextFull) => Ok(Compaction::Dropped(conversation.drop_oldest_turn())),
        Err(err) => Err(err),
    }
}

/// Compacts the conversation before a turn when its last prompt has reached the budget. A listed model with no
/// context size is not loaded yet: the turn's request loads it, so there is nothing to compact against until then.
pub fn compact_if_full(provider: &dyn Provider, conversation: &mut Conversation) -> Result<Option<Compaction>, ProviderError> {
    let size = match provider.context_size() {
        Err(ProviderError::ContextSizeUnknown { .. }) => return Ok(None),
        size => size?,
    };
    if conversation.needs_compaction(size) {
        Ok(Some(compact(provider, conversation)?))
    } else {
        Ok(None)
    }
}

/// Sends a turn. If the context fills up during it, the conversation is compacted and the turn is
/// sent once more from the compacted history. Returns the turn and the last compaction it needed.
pub fn run_turn(
    provider: &dyn Provider,
    conversation: &mut Conversation,
    line: String,
    tools: &dyn ToolRunner,
    approve: &mut dyn FnMut(&str) -> bool,
    subagent: &mut SubagentRunner,
    on_event: &mut dyn FnMut(Event),
) -> Result<(Turn, Option<Compaction>), ProviderError> {
    let mut compaction = compact_if_full(provider, conversation)?;
    match provider.complete_streaming(conversation.messages(), line.clone(), tools, approve, subagent, on_event) {
        Err(ProviderError::ContextFull) => {
            compaction = Some(compact(provider, conversation)?);
            let turn = provider.complete_streaming(conversation.messages(), line, tools, approve, subagent, on_event)?;
            Ok((turn, compaction))
        }
        result => Ok((result?, compaction)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::environment::Environment;
    use std::path::PathBuf;

    struct Unloaded;

    impl Provider for Unloaded {
        fn complete(
            &self,
            _history: &[crate::session::Message],
            _input: String,
            _runner: &dyn ToolRunner,
            _approve: &mut dyn FnMut(&str) -> bool,
            _subagent: &mut SubagentRunner,
        ) -> Result<Turn, ProviderError> {
            unreachable!()
        }

        fn context_size(&self) -> Result<u64, ProviderError> {
            Err(ProviderError::ContextSizeUnknown { expected: "model".into() })
        }

        fn summarize(&self, _history: &[crate::session::Message]) -> Result<String, ProviderError> {
            unreachable!()
        }
    }

    #[test]
    fn an_unloaded_model_does_not_stop_the_turn_before_it_is_sent() {
        let mut conversation = Conversation::new(&Environment { cwd: PathBuf::from("C:/work") });
        assert!(matches!(compact_if_full(&Unloaded, &mut conversation), Ok(None)));
    }
}
