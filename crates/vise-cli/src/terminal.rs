//! The terminal frontend: it shows the engine's events on stdout and stderr, draws the live reply with `Render`, and asks
//! for approvals by reading `y` or `yes` from the same input the lines come from.

use vise_core::frontend::{Frontend, UiEvent};
use crate::render::Render;
use crate::style::{self, Color};
use std::io::{self, BufRead, Write};

pub struct TerminalFrontend<'a> {
    input: &'a mut dyn BufRead,
    /// Draws the reply and holds the output, which the approval prompts share.
    render: Render<&'a mut dyn Write>,
    errors: &'a mut dyn Write,
    /// The first write that failed. A frontend cannot return an error from `emit`, so the loop asks for it.
    failure: Option<io::Error>,
}

impl<'a> TerminalFrontend<'a> {
    pub fn new(input: &'a mut dyn BufRead, output: &'a mut dyn Write, errors: &'a mut dyn Write) -> Self {
        Self { input, render: Render::new(output), errors, failure: None }
    }

    /// Reads the next line the user typed, without its line ending. Returns `None` at the end of input.
    pub fn read_line(&mut self) -> io::Result<Option<String>> {
        read_line(&mut self.input)
    }

    /// The first write error since the last call, if any.
    pub fn take_failure(&mut self) -> Option<io::Error> {
        self.failure.take()
    }

    fn keep(&mut self, result: io::Result<()>) {
        if let Err(err) = result {
            self.failure.get_or_insert(err);
        }
    }
}

impl Frontend for TerminalFrontend<'_> {
    fn emit(&mut self, event: UiEvent) {
        match event {
            UiEvent::Notice(text) => {
                let result = self.render.notice(&text);
                self.keep(result);
            }
            UiEvent::Reply(text) => {
                let result = self.render.notice(&style::paint(Color::Green, &text));
                self.keep(result);
            }
            UiEvent::Status(text) => {
                let result = writeln!(self.errors, "{text}");
                self.keep(result);
            }
            UiEvent::Error(text) => {
                let result = writeln!(self.errors, "error: {text}");
                self.keep(result);
            }
            UiEvent::Stream { event, nested: false } => self.render.on_event(event),
            UiEvent::Stream { event, nested: true } => self.render.on_subagent_event(event),
            UiEvent::TurnEnded => self.render.end(),
        }
    }

    fn approve(&mut self, change: &str) -> bool {
        // The prompt shares the output with the live display, and reads its answer from the same input as the lines.
        ask(change, &mut *self.render.output(), &mut self.input)
    }
}

/// Reads one line without its line ending. Returns `None` at the end of input.
pub fn read_line(input: &mut impl BufRead) -> io::Result<Option<String>> {
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
