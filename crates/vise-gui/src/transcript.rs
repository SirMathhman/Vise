//! What the window shows, as plain data. A `Transcript` is built from the engine's `UiEvent`s and holds no egui types, so
//! its rules are tested without a window.

use crate::words;
use vise_core::frontend::UiEvent;
use vise_core::provider::types::Event;

/// One thing in the scrolling transcript.
#[derive(Debug, Clone, PartialEq)]
pub enum Item {
    /// What the user sent. The engine does not echo it, so the window adds it.
    User(String),
    /// The model's answer. `done` is false while it is still arriving.
    Assistant { text: String, done: bool },
    /// A tool call. `failed` holds why it did not run; `nested` marks a subagent's call.
    Tool { name: String, target: Option<String>, failed: Option<String>, nested: bool },
    /// A line from a command, shown as it is.
    Notice(String),
    /// A line about the run itself.
    Status(String),
    Error(String),
}

/// How far the current request has got, for the status strip.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Progress {
    #[default]
    Idle,
    Prompt { processed: u64, total: u64 },
    Thinking(usize),
}

#[derive(Debug, Default)]
pub struct Transcript {
    pub items: Vec<Item>,
    pub progress: Progress,
}

impl Transcript {
    /// Adds what the user sent.
    pub fn user_said(&mut self, text: String) {
        self.items.push(Item::User(text));
    }

    pub fn notice(&mut self, text: String) {
        self.items.push(Item::Notice(text));
    }

    /// Takes one event from the engine.
    pub fn apply(&mut self, event: UiEvent) {
        match event {
            UiEvent::Notice(text) => self.items.push(Item::Notice(text)),
            UiEvent::Status(text) => self.items.push(Item::Status(text)),
            UiEvent::Error(text) => self.items.push(Item::Error(text)),
            UiEvent::Reply(text) => self.items.push(Item::Assistant { text, done: true }),
            UiEvent::Stream { event, nested } => self.stream(event, nested),
            UiEvent::TurnEnded => self.finish(),
            other => {
                if let Some(text) = words::describe(&other) {
                    self.items.push(Item::Notice(text));
                }
            }
        }
    }

    /// Closes the answer that was arriving and clears the progress. Called when a turn or a request is over, however it ended.
    pub fn finish(&mut self) {
        if let Some(Item::Assistant { done, .. }) = self.items.last_mut() {
            *done = true;
        }
        self.progress = Progress::Idle;
    }

    fn stream(&mut self, event: Event, nested: bool) {
        match event {
            Event::Prompt { processed, total } => self.progress = Progress::Prompt { processed, total },
            Event::Thinking(count) => self.progress = Progress::Thinking(count),
            Event::Answer(chunk) => {
                self.progress = Progress::Idle;
                match self.items.last_mut() {
                    Some(Item::Assistant { text, done: false }) => text.push_str(&chunk),
                    _ => self.items.push(Item::Assistant { text: chunk, done: false }),
                }
            }
            Event::Tool { name, target } => {
                self.close_answer();
                self.items.push(Item::Tool { name, target, failed: None, nested });
            }
            Event::ToolFailed(reason) => match self.items.last_mut() {
                Some(Item::Tool { failed, .. }) => *failed = Some(reason),
                _ => self.items.push(Item::Error(reason)),
            },
            Event::Finished => self.progress = Progress::Idle,
        }
    }

    /// A tool call ends the answer that came before it.
    fn close_answer(&mut self) {
        if let Some(Item::Assistant { done, .. }) = self.items.last_mut() {
            *done = true;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn answer(text: &str) -> UiEvent {
        UiEvent::Stream { event: Event::Answer(text.into()), nested: false }
    }

    #[test]
    fn answer_chunks_join_into_one_item_until_the_turn_ends() {
        let mut transcript = Transcript::default();
        transcript.apply(answer("hel"));
        transcript.apply(answer("lo"));
        assert_eq!(transcript.items, vec![Item::Assistant { text: "hello".into(), done: false }]);
        transcript.apply(UiEvent::TurnEnded);
        assert_eq!(transcript.items, vec![Item::Assistant { text: "hello".into(), done: true }]);
    }

    #[test]
    fn a_whole_reply_is_a_finished_answer() {
        let mut transcript = Transcript::default();
        transcript.apply(UiEvent::Reply("hi".into()));
        assert_eq!(transcript.items, vec![Item::Assistant { text: "hi".into(), done: true }]);
    }

    #[test]
    fn a_tool_call_ends_the_answer_before_it_and_the_next_answer_starts_a_new_item() {
        let mut transcript = Transcript::default();
        transcript.apply(answer("let me look"));
        transcript.apply(UiEvent::Stream {
            event: Event::Tool { name: "read_file".into(), target: Some("a.txt".into()) },
            nested: false,
        });
        transcript.apply(answer("done"));
        assert_eq!(
            transcript.items,
            vec![
                Item::Assistant { text: "let me look".into(), done: true },
                Item::Tool { name: "read_file".into(), target: Some("a.txt".into()), failed: None, nested: false },
                Item::Assistant { text: "done".into(), done: false },
            ]
        );
    }

    #[test]
    fn a_failed_call_marks_the_tool_line_and_a_subagents_line_is_nested() {
        let mut transcript = Transcript::default();
        transcript.apply(UiEvent::Stream { event: Event::Tool { name: "run_subagent".into(), target: None }, nested: false });
        transcript.apply(UiEvent::Stream { event: Event::Tool { name: "read_file".into(), target: None }, nested: true });
        transcript.apply(UiEvent::Stream { event: Event::ToolFailed("missing".into()), nested: true });
        assert_eq!(
            transcript.items[1],
            Item::Tool { name: "read_file".into(), target: None, failed: Some("missing".into()), nested: true }
        );
    }

    #[test]
    fn a_failure_with_no_call_before_it_is_shown_as_an_error() {
        let mut transcript = Transcript::default();
        transcript.apply(UiEvent::Stream { event: Event::ToolFailed("odd".into()), nested: false });
        assert_eq!(transcript.items, vec![Item::Error("odd".into())]);
    }

    #[test]
    fn progress_follows_the_request_and_clears_with_the_answer() {
        let mut transcript = Transcript::default();
        transcript.apply(UiEvent::Stream { event: Event::Prompt { processed: 1, total: 4 }, nested: false });
        assert_eq!(transcript.progress, Progress::Prompt { processed: 1, total: 4 });
        transcript.apply(UiEvent::Stream { event: Event::Thinking(7), nested: false });
        assert_eq!(transcript.progress, Progress::Thinking(7));
        transcript.apply(answer("x"));
        assert_eq!(transcript.progress, Progress::Idle);
        assert_eq!(transcript.items.len(), 1, "progress adds no item");
    }

    #[test]
    fn notices_statuses_and_errors_are_kept_in_order() {
        let mut transcript = Transcript::default();
        transcript.apply(UiEvent::Status("resumed session x".into()));
        transcript.apply(UiEvent::Notice("hello".into()));
        transcript.apply(UiEvent::Error("bad".into()));
        assert_eq!(
            transcript.items,
            vec![Item::Status("resumed session x".into()), Item::Notice("hello".into()), Item::Error("bad".into())]
        );
    }
}
