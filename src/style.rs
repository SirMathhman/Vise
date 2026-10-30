//! Terminal colors. They are written only after `enable_if_terminal` finds a terminal and no `NO_COLOR`, so piped output
//! and tests never see escape codes.

use std::io::{self, IsTerminal, Write};
use std::sync::atomic::{AtomicBool, Ordering};

static ENABLED: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Copy)]
pub enum Color {
    Red,
    Green,
    Cyan,
    Dim,
}

impl Color {
    fn code(self) -> &'static str {
        match self {
            Self::Red => "31",
            Self::Green => "32",
            Self::Cyan => "36",
            Self::Dim => "2",
        }
    }
}

/// Turns colors on when stdout is a terminal and `NO_COLOR` is not set. Called once at startup.
pub fn enable_if_terminal() {
    let on = io::stdout().is_terminal() && std::env::var_os("NO_COLOR").is_none();
    ENABLED.store(on, Ordering::Relaxed);
}

/// The text wrapped in `color`, or the text itself when colors are off.
pub fn paint(color: Color, text: &str) -> String {
    if ENABLED.load(Ordering::Relaxed) && !text.is_empty() {
        format!("\x1b[{}m{text}\x1b[0m", color.code())
    } else {
        text.to_string()
    }
}

/// The error stream. A line that starts with `error:` is written in red, and any other line is written as it is.
pub struct Errors<W: Write> {
    inner: W,
    pending: Vec<u8>,
}

impl<W: Write> Errors<W> {
    pub fn new(inner: W) -> Self {
        Self { inner, pending: Vec::new() }
    }

    /// Writes one line, with its line ending, which is kept outside the color.
    fn emit(&mut self, line: &[u8]) -> io::Result<()> {
        let text = String::from_utf8_lossy(line);
        let (body, ending) = match text.strip_suffix('\n') {
            Some(body) => (body, "\n"),
            None => (text.as_ref(), ""),
        };
        let painted = if body.starts_with("error:") { paint(Color::Red, body) } else { body.to_string() };
        self.inner.write_all(format!("{painted}{ending}").as_bytes())
    }
}

impl<W: Write> Write for Errors<W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.pending.extend_from_slice(buf);
        while let Some(end) = self.pending.iter().position(|&byte| byte == b'\n') {
            let line: Vec<u8> = self.pending.drain(..=end).collect();
            self.emit(&line)?;
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

impl<W: Write> Drop for Errors<W> {
    /// A line without its line ending is still written when the stream ends.
    fn drop(&mut self) {
        if !self.pending.is_empty() {
            let rest = std::mem::take(&mut self.pending);
            let _ = self.emit(&rest);
            let _ = self.inner.flush();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn errors_pass_through_unchanged_when_colors_are_off() {
        let mut buffer = Vec::new();
        {
            let mut errors = Errors::new(&mut buffer);
            write!(errors, "error: first\nsecond").unwrap();
        }
        assert_eq!(String::from_utf8(buffer).unwrap(), "error: first\nsecond");
    }
}
