use crate::after_turn;
use crate::commands::{command, Command, HELP};
use crate::default_model;
use crate::error::ProviderError;
use crate::interrupt;
use crate::profile;
use crate::provider::types::{Event, Provider};
use crate::render::Render;
use crate::style;
use crate::subagent;
use crate::turn::{apply_whitelist, compact, hook_lines, prepare_message, run_turn, select_hooks, Compaction};
use crate::saved_sessions;
use crate::session::{Conversation, Message, PartialTurn, Turn};
use crate::tools::types::ToolRunner;
use std::io::{self, BufRead, Write};
use std::path::Path;

mod commands;
use commands::{note_command, session_command, toggle, tool_list};
#[cfg(test)]
mod tests;

pub fn run(
    input: &mut impl BufRead,
    output: &mut impl Write,
    errors: &mut impl Write,
    provider: &dyn Provider,
    tools: &dyn ToolRunner,
    conversation: &mut Conversation,
    sessions: &Path,
) -> io::Result<()> {
    // The profile chosen with `/profile NAME`. Its text is sent again whenever the history does not carry it.
    let mut profile: Option<String> = None;
    loop {
        let line = match read_line(input) {
            Ok(Some(line)) => line,
            Ok(None) => break,
            Err(err) => {
                writeln!(errors, "error: failed to read from stdin: {err}")?;
                break;
            }
        };
        match command(&line) {
            Some(Command::Exit) => break,
            Some(Command::Help) => writeln!(output, "{HELP}")?,
            Some(Command::Tools) => writeln!(output, "{}", tool_list(tools))?,
            Some(Command::Enable(name)) => toggle(tools, &name, true, output, errors)?,
            Some(Command::Disable(name)) => toggle(tools, &name, false, output, errors)?,
            Some(Command::Profiles) => match profile::names() {
                Ok(names) if names.is_empty() => writeln!(output, "no profiles: add .txt files to the profiles folder")?,
                Ok(names) => writeln!(output, "{}", names.join("\n"))?,
                Err(err) => writeln!(errors, "error: {err}")?,
            },
            Some(command @ (Command::ListNotes(_) | Command::ShowNote(_) | Command::CreateNote(..) | Command::DeleteNote(_))) => {
                note_command(command, tools, output, errors)?
            }
            Some(command @ (Command::Sessions | Command::Save(_) | Command::Load(_))) => {
                session_command(command, conversation, sessions, output, errors)?
            }
            Some(Command::Profile(name)) => match profile::load(&name) {
                Ok(loaded) => match apply_whitelist(tools, loaded.tools.as_deref()) {
                    Ok(changes) => {
                        for change in changes {
                            writeln!(output, "{change}")?;
                        }
                        tools.set_allowed_notes(loaded.notes);
                        tools.confirm_profile(&name);
                        profile = Some(profile::marked(&name, &loaded.instructions));
                        select_hooks(loaded.hooks, conversation, tools, output, errors)?;
                        writeln!(output, "profile {name} selected; its instructions go with your next message")?;
                    }
                    Err(err) => writeln!(errors, "error: {err}")?,
                },
                Err(err) => writeln!(errors, "error: {err}")?,
            },
            Some(Command::Models) => match provider.models() {
                Ok(ids) => {
                    let current = provider.model();
                    for id in ids {
                        let mark = if id == current { "* " } else { "  " };
                        writeln!(output, "{mark}{id}")?;
                    }
                }
                Err(err) => writeln!(errors, "error: {err}")?,
            },
            Some(Command::UseModel(name)) => match provider.set_model(&name) {
                Ok(()) => match default_model::save(&name) {
                    Ok(()) => writeln!(output, "model set to {name}, and kept as the default")?,
                    Err(err) => writeln!(errors, "error: the model is now {name}, but it could not be saved as the default: {err}")?,
                },
                Err(err) => writeln!(errors, "error: {err}")?,
            },
            Some(Command::New) => {
                conversation.replace_history(Vec::new());
                writeln!(output, "started a new conversation")?;
            }
            Some(Command::Compact) => match compact(provider, conversation) {
                Ok(Compaction::Summarized) => writeln!(output, "conversation compacted")?,
                Ok(Compaction::Dropped(removed)) => writeln!(
                    output,
                    "the summary did not fit, so the oldest turn was dropped ({removed} messages removed)"
                )?,
                Err(err) => writeln!(errors, "error: {err}")?,
            },
            Some(Command::Context) => {
                let context = conversation.messages().first().map_or("", Message::content);
                writeln!(output, "{context}")?;
                match provider.context_size() {
                    Ok(total) => writeln!(output, "{} / {total}", conversation.prompt_tokens())?,
                    Err(err) => writeln!(errors, "error: {err}")?,
                }
            }
            None => {
                let mut streams = Streams { input: &mut *input, output: &mut *output, errors: &mut *errors };
                chat(line, profile.as_deref(), provider, tools, conversation, &mut streams)?
            }
        }
    }
    Ok(())
}

/// The streams a chat turn writes to, and reads its approvals from.
struct Streams<'a> {
    input: &'a mut dyn BufRead,
    output: &'a mut dyn Write,
    errors: &'a mut dyn Write,
}

/// Runs a chat line as a turn. While the after-turn command fails, its failure is sent as the next message, for up to
/// `after_turn::FOLLOW_UPS` follow-up turns.
fn chat(
    line: String,
    profile: Option<&str>,
    provider: &dyn Provider,
    tools: &dyn ToolRunner,
    conversation: &mut Conversation,
    streams: &mut Streams,
) -> io::Result<()> {
    let mut pending = Some(line);
    let mut follow_ups = 0;
    while let Some(text) = pending.take() {
        pending = chat_turn(text, profile, provider, tools, conversation, streams)?;
        if pending.is_some() {
            if follow_ups == after_turn::FOLLOW_UPS {
                writeln!(
                    streams.errors,
                    "error: after-turn command still fails after {} follow-up turns",
                    after_turn::FOLLOW_UPS
                )?;
                pending = None;
            } else {
                follow_ups += 1;
            }
        }
    }
    Ok(())
}

/// Sends a line to the model as one turn: adds the before-turn, startup, profile and notes text the history does not
/// carry, runs the turn, commits it, and autosaves the history. Returns the failure text of the after-turn commands,
/// when one fails.
fn chat_turn(
    line: String,
    profile: Option<&str>,
    provider: &dyn Provider,
    tools: &dyn ToolRunner,
    conversation: &mut Conversation,
    streams: &mut Streams,
) -> io::Result<Option<String>> {
    let typed = line.clone();
    let message = prepare_message(line, profile, conversation, tools, &mut streams.output, &mut streams.errors)?;
    // The approval prompts share the output with the live display, and read their answers from the
    // same input as the lines themselves.
    let render = Render::new(&mut streams.output);
    let mut approve = |change: &str| ask(change, &mut *render.output(), &mut streams.input);
    let mut on_event = |event: Event| render.on_event(event);
    // A subagent runs with this turn's approvals and the global hook lines, which its own profile's lines follow. Only
    // its tool lines reach this turn's display: its answer text is discarded, so the parent's reply is the only answer.
    let (global_before, global_after) = (conversation.before_turn().to_vec(), conversation.after_turn().to_vec());
    let mut subagent = |name: &str, task: &str, approve: &mut dyn FnMut(&str) -> bool| {
        let mut tools_only = |event: Event| match event {
            Event::Tool { .. } | Event::ToolFailed(_) => render.on_subagent_event(event),
            _ => {}
        };
        subagent::run(
            name,
            task,
            provider,
            tools,
            subagent::Parent {
                hooks: (&global_before, &global_after),
                approve,
                on_event: &mut tools_only,
            },
        )
    };
    let result = run_turn(provider, conversation, message, tools, &mut approve, &mut subagent, &mut on_event);
    render.end();
    let streamed = render.streamed();
    // The press has been handled, so the next turn runs until it is stopped again.
    interrupt::clear();
    match result {
        Ok((turn, compaction)) => {
            if let Some(Compaction::Dropped(removed)) = compaction {
                writeln!(
                    streams.output,
                    "the context was full, so the oldest turn was dropped ({removed} messages removed)"
                )?;
            }
            if !streamed {
                writeln!(streams.output, "{}", style::paint(style::Color::Green, turn.reply()))?;
            }
            conversation.commit(turn);
            if let Some((folder, name)) = conversation.autosave_target(&typed) {
                if let Err(err) =
                    saved_sessions::write(&folder, &name, conversation.history(), conversation.requests())
                {
                    writeln!(streams.errors, "error: {err}")?;
                }
            }
            let after_lines = hook_lines(conversation.after_turn(), &conversation.profile_hooks().after_turn);
            after_turn::run(&after_lines, tools, &mut streams.output, &mut streams.errors)
        }
        Err(ProviderError::Interrupted { stopped }) => interrupted(typed, stopped, conversation, streams),
        Err(err) => {
            writeln!(streams.errors, "error: {err}")?;
            Ok(None)
        }
    }
}

/// The line that marks a stopped turn in the history, so a later reader knows the turn did not finish.
const MARK: &str = "[the turn was interrupted]";

/// Records a stopped turn: what it reached, which is the prepared user message, any finished tool rounds, and the
/// reply's text, goes into the history so the user and the model can see how far it got, and the history is autosaved
/// as after any other turn. The after-turn lines do not run, because the turn did not finish, and nothing follows it: a
/// stopped turn is never resent on its own. The messages are checked the way every turn is, so an interrupted round
/// that left a tool result out is refused rather than stored.
fn interrupted(
    typed: String,
    stopped: PartialTurn,
    conversation: &mut Conversation,
    streams: &mut Streams,
) -> io::Result<Option<String>> {
    let requests = stopped.requests().to_vec();
    match stopped.into_messages(MARK).and_then(Turn::new) {
        Ok(turn) => conversation.commit(turn.with_requests(requests)),
        Err(err) => writeln!(streams.errors, "error: {err}")?,
    }
    if let Some((folder, name)) = conversation.autosave_target(&typed) {
        if let Err(err) = saved_sessions::write(&folder, &name, conversation.history(), conversation.requests()) {
            writeln!(streams.errors, "error: {err}")?;
        }
    }
    writeln!(streams.output, "the turn was stopped before it finished")?;
    Ok(None)
}

/// Reads one line without its line ending. Returns `None` at the end of input.
fn read_line(input: &mut impl BufRead) -> io::Result<Option<String>> {
    let mut line = String::new();
    if input.read_line(&mut line)? == 0 {
        return Ok(None);
    }
    Ok(Some(line.trim_end_matches(['\n', '\r']).to_string()))
}

/// Shows a proposed change and reads the answer. Only "y" or "yes" accepts it. A failure to read or
/// write declines it.
fn ask(change: &str, output: &mut impl Write, input: &mut impl BufRead) -> bool {
    if writeln!(output, "{change}\napply this change? [y/N]").and_then(|()| output.flush()).is_err() {
        return false;
    }
    matches!(read_line(input), Ok(Some(answer)) if matches!(answer.trim().to_lowercase().as_str(), "y" | "yes"))
}
