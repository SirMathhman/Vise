//! The terminal's input loop: it reads a line, turns it into a request for the engine, and ends the run on `/exit` or the
//! end of input. What the engine reports is shown by `TerminalFrontend`.

use crate::commands::{command, HELP};
use vise_core::command::Command;
use vise_core::engine::{Engine, Flow, Request};
use vise_core::frontend::Frontend;
use crate::terminal::TerminalFrontend;
use std::io::{self, BufRead, Write};

#[cfg(test)]
mod tests;

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
