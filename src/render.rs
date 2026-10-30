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
            Event::Tool { name, target } => self.line(&tool_text(&name, target.as_deref())),
            // The call above did not run, so the transcript says so rather than claiming it did.
            Event::ToolFailed(reason) => self.line(&format!("  did not run: {reason}")),
            Event::Finished => self.end_status(),
        }
    }

    /// A tool line of a subagent, indented under the parent's tool lines. Only its tool lines are shown, so any other
    /// event is ignored.
    pub fn on_subagent_event(&self, event: Event) {
        match event {
            Event::Tool { name, target } => self.line(&format!("{SUBAGENT_INDENT}{}", tool_text(&name, target.as_deref()))),
            Event::ToolFailed(reason) => self.line(&format!("{SUBAGENT_INDENT}  did not run: {reason}")),
            _ => {}
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

    /// Writes one complete line that stays in the transcript, on a line of its own. The text comes from the model, so
    /// control characters are replaced and it is cut short: a `\r` would overwrite the prefix, and a long command would
    /// flood the terminal.
    fn line(&self, text: &str) {
        self.end_status();
        if self.line_open.get() {
            self.newline();
        }
        self.put(&clean(text));
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

/// The indent of a subagent's tool lines, under the parent's `tool:` line that started it.
const SUBAGENT_INDENT: &str = "  ";

/// A tool call's line text: its name, then its target when there is one.
fn tool_text(name: &str, target: Option<&str>) -> String {
    match target {
        Some(target) => format!("tool: {name} {target}"),
        None => format!("tool: {name}"),
    }
}

/// The longest line the display writes whole. A path or a command longer than this is cut, so one call cannot fill the
/// screen.
const WIDEST: usize = 100;

/// A tool line's text as it can safely be shown: control characters replaced by spaces, and cut to `WIDEST` with an
/// ellipsis. The text is model-controlled, and a `\r` would overwrite the `tool:` prefix that explains it.
fn clean(text: &str) -> String {
    let flattened: String = text.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    if flattened.chars().count() <= WIDEST {
        return flattened;
    }
    let head: String = flattened.chars().take(WIDEST - 1).collect();
    format!("{}…", head.trim_end())
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
    fn a_tool_line_replaces_control_characters_and_is_cut_short() {
        let mut buffer = Vec::new();
        let render = Render::new(&mut buffer);
        render.on_event(Event::Tool { name: "read_file".into(), target: Some("a\rb".into()) });
        render.on_event(Event::Tool { name: "run_powershell".into(), target: Some("x".repeat(300)) });
        drop(render);
        let text = String::from_utf8(buffer).unwrap();
        assert!(text.contains("tool: read_file a b\n"), "{text:?}");
        let long = text.lines().find(|line| line.starts_with("tool: run_powershell")).expect("the long line");
        assert!(long.ends_with('…'), "{long:?}");
        assert!(long.chars().count() <= 100, "{long:?}");
    }

    #[test]
    fn a_subagent_tool_line_is_indented_under_the_parents() {
        let mut buffer = Vec::new();
        let render = Render::new(&mut buffer);
        render.on_event(Event::Tool { name: "run_subagent".into(), target: Some("default".into()) });
        render.on_subagent_event(Event::Tool { name: "read_file".into(), target: Some("a.txt".into()) });
        render.on_subagent_event(Event::ToolFailed("missing".into()));
        drop(render);
        let text = String::from_utf8(buffer).unwrap();
        assert!(text.starts_with("tool: run_subagent default
  tool: read_file a.txt
"), "{text:?}");
        assert!(text.ends_with("
    did not run: missing
"), "{text:?}");
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
