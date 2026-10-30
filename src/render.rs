//! The live display of a reply. Prompt progress and thinking share one status line, which is overwritten
//! in place until answer text follows it. The output is shared with the approval prompts, so it is held here.

use crate::provider::types::Event;
use std::cell::{Cell, RefCell, RefMut};
use std::io::Write;

pub struct Render<'a, W: Write> {
    out: RefCell<&'a mut W>,
    status_open: Cell<bool>,
    line_open: Cell<bool>,
    streamed: Cell<bool>,
}

impl<'a, W: Write> Render<'a, W> {
    pub fn new(output: &'a mut W) -> Self {
        Self { out: RefCell::new(output), status_open: Cell::new(false), line_open: Cell::new(false), streamed: Cell::new(false) }
    }

    pub fn on_event(&self, event: Event) {
        match event {
            Event::Prompt { processed, total } => self.status(&format!("processing prompt: {processed} / {total} tokens")),
            Event::Thinking(count) => self.status(&format!("thinking: {count} tokens")),
            Event::Answer(text) => {
                self.end_status();
                self.streamed.set(true);
                self.put(&text);
            }
            // A call is kept as a line of its own, so the transcript shows which tools ran after the turn ends.
            Event::Tool { name, target } => {
                self.end_status();
                self.line(&match target {
                    Some(target) => format!("tool: {name} {target}"),
                    None => format!("tool: {name}"),
                });
            }
            Event::Finished => self.end_status(),
        }
    }

    /// Ends the line still open, if any. Called once a reply has ended, however it ended.
    pub fn end(&self) {
        if self.line_open.get() {
            self.newline();
        }
    }

    /// Whether answer text was drawn, so the reply need not be printed again.
    pub fn streamed(&self) -> bool {
        self.streamed.get()
    }

    /// The shared output, for the approval prompts.
    pub fn output(&self) -> RefMut<'_, &'a mut W> {
        self.out.borrow_mut()
    }

    fn status(&self, text: &str) {
        self.put(&format!("\r{text:<60}"));
        self.status_open.set(true);
    }

    fn end_status(&self) {
        if self.status_open.replace(false) {
            self.newline();
        }
    }

    /// Writes one complete line that stays in the transcript, on a line of its own.
    fn line(&self, text: &str) {
        self.end_status();
        if self.line_open.get() {
            self.newline();
        }
        self.put(text);
        self.newline();
    }

    fn put(&self, text: &str) {
        let mut out = self.out.borrow_mut();
        let _ = write!(out, "{text}");
        let _ = out.flush();
        self.line_open.set(true);
    }

    fn newline(&self) {
        let _ = writeln!(self.out.borrow_mut());
        self.line_open.set(false);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn answer_text_starts_on_a_new_line_after_the_status() {
        let mut buffer = Vec::new();
        let render = Render::new(&mut buffer);
        render.on_event(Event::Prompt { processed: 1, total: 2 });
        render.on_event(Event::Answer("hi".into()));
        drop(render);
        assert!(String::from_utf8(buffer).unwrap().ends_with("\nhi"));
    }

    #[test]
    fn a_tool_call_keeps_a_line_of_its_own() {
        let mut buffer = Vec::new();
        let render = Render::new(&mut buffer);
        render.on_event(Event::Prompt { processed: 1, total: 2 });
        render.on_event(Event::Tool { name: "read_file".into(), target: Some("src/repl.rs".into()) });
        render.on_event(Event::Thinking(3));
        render.on_event(Event::Tool { name: "list_notes".into(), target: None });
        render.on_event(Event::Answer("done".into()));
        drop(render);
        let text = String::from_utf8(buffer).unwrap();
        assert!(text.contains("\ntool: read_file src/repl.rs\n"), "{text:?}");
        assert!(text.contains("\ntool: list_notes\n"), "{text:?}");
        assert!(text.ends_with("\ndone"), "{text:?}");
    }

    #[test]
    fn end_closes_a_line_left_open_by_a_failed_reply() {
        let mut buffer = Vec::new();
        let render = Render::new(&mut buffer);
        render.on_event(Event::Answer("partial".into()));
        render.end();
        drop(render);
        assert_eq!(String::from_utf8(buffer).unwrap(), "partial\n");
    }
}
