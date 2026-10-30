//! The terminal's input loop: it reads a line, turns it into a request for the engine, and ends the run on `/exit` or the
//! end of input. What the engine reports is shown by `TerminalFrontend`.

use crate::commands::{command, Command, HELP};
use crate::engine::{Engine, Flow, Request};
use crate::frontend::Frontend;
use crate::provider::types::Provider;
use crate::session::Conversation;
use crate::stop::Stop;
use crate::terminal::TerminalFrontend;
use crate::tools::types::ToolRunner;
use std::io::{self, BufRead, Write};
use std::path::Path;

#[cfg(test)]
mod tests;

/// Runs the loop over a new engine on these parts. The caller keeps ownership, so it can read the conversation after.
/// The program itself builds its engine to start and stop it too, so only the tests use this one.
#[cfg(test)]
pub fn run(
    input: &mut impl BufRead,
    output: &mut impl Write,
    errors: &mut impl Write,
    provider: &dyn Provider,
    tools: &dyn ToolRunner,
    conversation: &mut Conversation,
    sessions: &Path,
) -> io::Result<()> {
    let mut engine = Engine::new(provider, tools, conversation, sessions, Stop::new());
    run_engine(&mut engine, input, output, errors)
}

/// Reads lines until `/exit` or the end of input, and sends each to the engine. A write that fails ends the run with its
/// error.
pub fn run_engine(
    engine: &mut Engine<'_>,
    input: &mut impl BufRead,
    output: &mut impl Write,
    errors: &mut impl Write,
) -> io::Result<()> {
    let mut ui = TerminalFrontend::new(input, output, errors);
    loop {
        let line = match ui.read_line() {
            Ok(Some(line)) => line,
            Ok(None) => break,
            Err(err) => {
                ui.error(format!("failed to read from stdin: {err}"));
                break;
            }
        };
        let flow = match command(&line) {
            Some(Command::Help) => {
                ui.notice(HELP.to_string());
                Flow::Continue
            }
            Some(command) => engine.handle(Request::Command(command), &mut ui),
            None => engine.handle(Request::Chat(line), &mut ui),
        };
        if let Some(err) = ui.take_failure() {
            return Err(err);
        }
        if flow == Flow::Exit {
            break;
        }
    }
    ui.take_failure().map_or(Ok(()), Err)
}
