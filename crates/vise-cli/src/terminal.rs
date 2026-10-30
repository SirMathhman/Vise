//! The terminal frontend: it shows the engine's events on stdout and stderr, draws the live reply with `Render`, and asks
//! for approvals by reading `y` or `yes` from the same input the lines come from.

use vise_core::frontend::{Change, DropCause, Frontend, UiEvent};
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

    /// Words something the engine changed.
    fn changed(&mut self, change: Change) {
        match change {
            Change::ToolToggled { name, enabled } => self.text(format!("{name}: {}", state(enabled))),
            Change::ProfileApplied { name, tool_changes, new_hooks } => {
                for tool in tool_changes {
                    self.text(format!("{}: {}", tool.name, state(tool.enabled)));
                }
                if !new_hooks.is_empty() {
                    self.text(format!(
                        "profile {name}: these hook lines are new or changed since the run started, and run without a prompt:"
                    ));
                    for line in new_hooks {
                        self.text(format!("  {line}"));
                    }
                }
            }
            Change::ProfileSelected { name } => {
                self.text(format!("profile {name} selected; its instructions go with your next message"));
            }
            Change::SessionSaved { name } => self.text(format!("session {name} saved")),
            Change::SessionLoaded { name } => self.text(format!("session {name} loaded")),
            // When the default was not kept, an error line says so.
            Change::ModelSet { name, default_saved: true } => {
                self.text(format!("model set to {name}, and kept as the default"));
            }
            Change::ModelSet { default_saved: false, .. } => {}
            Change::Compacted => self.text("conversation compacted".to_string()),
            Change::OldestTurnDropped { removed, cause: DropCause::SummaryDidNotFit } => {
                self.text(format!("the summary did not fit, so the oldest turn was dropped ({removed} messages removed)"));
            }
            Change::OldestTurnDropped { removed, cause: DropCause::ContextFull } => {
                self.text(format!("the context was full, so the oldest turn was dropped ({removed} messages removed)"));
            }
            Change::Reset => self.text("started a new conversation".to_string()),
            Change::NoteCreated { name } => self.text(format!("created note '{name}'")),
            Change::NoteDeleted { name } => self.text(format!("deleted note '{name}'")),
        }
    }

    /// Shows a plain line on the output.
    fn text(&mut self, text: String) {
        let result = self.render.notice(&text);
        self.keep(result);
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
            UiEvent::Changed(change) => self.changed(change),
            UiEvent::Note { summary, category, content, .. } => {
                self.text(format!("summary: {summary}\ncategory: {category}\n\n{content}"));
            }
            UiEvent::Tools(tools) => {
                let lines: Vec<String> = tools
                    .iter()
                    .map(|tool| format!("{}: {}", tool.name, if tool.enabled { "enabled" } else { "disabled" }))
                    .collect();
                self.text(lines.join("\n"));
            }
            UiEvent::Profiles(names) if names.is_empty() => {
                self.text("no profiles: a profile is a note with the category profile".to_string());
            }
            UiEvent::Profiles(names) => self.text(names.join("\n")),
            UiEvent::Models { current, ids } => {
                let lines: Vec<String> =
                    ids.iter().map(|id| format!("{}{id}", if *id == current { "* " } else { "  " })).collect();
                self.text(if lines.is_empty() { "no models".to_string() } else { lines.join("\n") });
            }
            UiEvent::Sessions(names) if names.is_empty() => {
                self.text("no sessions: /save NAME stores the conversation".to_string());
            }
            UiEvent::Sessions(names) => self.text(names.join("\n")),
            UiEvent::Notes(notes) if notes.is_empty() => self.text("no notes".to_string()),
            UiEvent::Notes(notes) => {
                let lines: Vec<String> = notes
                    .iter()
                    .map(|note| format!("{} [{}]: {}", note.name, note.category, note.summary))
                    .collect();
                self.text(lines.join("\n"));
            }
            UiEvent::Context { text, prompt_tokens, size } => {
                self.text(text);
                if let Some(size) = size {
                    self.text(format!("{prompt_tokens} / {size}"));
                }
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

/// "enabled" or "disabled".
fn state(enabled: bool) -> &'static str {
    if enabled { "enabled" } else { "disabled" }
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

#[cfg(test)]
mod tests {
    use super::*;
    use vise_core::frontend::{Change, DropCause, NoteLine, ToolState};

    /// What the terminal prints on its output for these events.
    fn shown(events: Vec<UiEvent>) -> String {
        let (mut output, mut errors, mut input) = (Vec::new(), Vec::new(), "".as_bytes());
        {
            let mut ui = TerminalFrontend::new(&mut input, &mut output, &mut errors);
            for event in events {
                ui.emit(event);
            }
        }
        String::from_utf8(output).unwrap()
    }

    #[test]
    fn query_results_are_worded_by_the_terminal() {
        let text = shown(vec![
            UiEvent::Tools(vec![ToolState { name: "read_file".into(), enabled: false }]),
            UiEvent::Models { current: "b".into(), ids: vec!["a".into(), "b".into()] },
            UiEvent::Notes(vec![NoteLine { name: "plan".into(), category: "memory".into(), summary: "s".into() }]),
            UiEvent::Context { text: "context".into(), prompt_tokens: 3, size: Some(10) },
        ]);
        let expected = ["read_file: disabled", "  a", "* b", "plan [memory]: s", "context", "3 / 10", ""].join("\n");
        assert_eq!(text, expected);
    }

    #[test]
    fn nothing_to_list_is_said_in_the_terminals_words() {
        let text = shown(vec![UiEvent::Sessions(Vec::new()), UiEvent::Notes(Vec::new())]);
        assert_eq!(text, "no sessions: /save NAME stores the conversation\nno notes\n");
    }

    #[test]
    fn changes_are_worded_by_the_terminal() {
        let text = shown(vec![
            UiEvent::Changed(Change::ToolToggled { name: "read_file".into(), enabled: true }),
            UiEvent::Changed(Change::ProfileApplied {
                name: "explore".into(),
                tool_changes: vec![ToolState { name: "create_file".into(), enabled: false }],
                new_hooks: vec!["before-turn: Get-Date".into()],
            }),
            UiEvent::Changed(Change::ProfileSelected { name: "explore".into() }),
            UiEvent::Changed(Change::SessionSaved { name: "a".into() }),
            UiEvent::Changed(Change::SessionLoaded { name: "b".into() }),
            UiEvent::Changed(Change::ModelSet { name: "m".into(), default_saved: true }),
            UiEvent::Changed(Change::ModelSet { name: "n".into(), default_saved: false }),
            UiEvent::Changed(Change::Compacted),
            UiEvent::Changed(Change::OldestTurnDropped { removed: 2, cause: DropCause::SummaryDidNotFit }),
            UiEvent::Changed(Change::OldestTurnDropped { removed: 3, cause: DropCause::ContextFull }),
            UiEvent::Changed(Change::Reset),
            UiEvent::Changed(Change::NoteCreated { name: "x".into() }),
            UiEvent::Changed(Change::NoteDeleted { name: "x".into() }),
            UiEvent::Note { name: "plan".into(), summary: "s".into(), category: "memory".into(), content: "text".into() },
            UiEvent::Models { current: String::new(), ids: Vec::new() },
        ]);
        let expected = [
            "read_file: enabled",
            "create_file: disabled",
            "profile explore: these hook lines are new or changed since the run started, and run without a prompt:",
            "  before-turn: Get-Date",
            "profile explore selected; its instructions go with your next message",
            "session a saved",
            "session b loaded",
            "model set to m, and kept as the default",
            "conversation compacted",
            "the summary did not fit, so the oldest turn was dropped (2 messages removed)",
            "the context was full, so the oldest turn was dropped (3 messages removed)",
            "started a new conversation",
            "created note 'x'",
            "deleted note 'x'",
            "summary: s",
            "category: memory",
            "",
            "text",
            "no models",
            "",
        ]
        .join("\n");
        assert_eq!(text, expected);
    }
}
