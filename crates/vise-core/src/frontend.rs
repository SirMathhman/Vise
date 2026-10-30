//! What a user interface is to the backend. The backend never writes to a terminal and never reads from one: every message
//! for the user is a `UiEvent`, and every yes/no question is a `Frontend::approve` call. A frontend (the terminal today,
//! another one later) implements `Frontend` and decides how to show events and ask.

use crate::provider::types::Event;

/// One thing the backend tells the user. It is plain data, so a frontend can draw it, log it, or send it elsewhere.
#[derive(Debug, Clone, PartialEq)]
pub enum UiEvent {
    /// A line for the user, shown as it is.
    Notice(String),
    /// A line about the run itself, such as which session was resumed. It is not part of the conversation.
    Status(String),
    /// Something went wrong. The text has no "error:" prefix: the frontend adds whatever marks an error for it.
    Error(String),
    /// The whole answer, sent when it was not already shown piece by piece as `Stream` answer events.
    Reply(String),
    /// Progress of a model request: prompt processing, thinking, answer text, and the tool calls the reply makes.
    /// `nested` marks the events of a subagent, which a frontend can indent or group under the call that started it.
    Stream { event: Event, nested: bool },
    /// The turn is over, however it ended, so a frontend can close whatever it left open.
    TurnEnded,
}

pub trait Frontend {
    /// Shows or records one event.
    fn emit(&mut self, event: UiEvent);

    /// Shows a proposed change and returns whether the user accepts it. It blocks until the user answers.
    fn approve(&mut self, change: &str) -> bool;

    fn notice(&mut self, text: String) {
        self.emit(UiEvent::Notice(text));
    }

    fn status(&mut self, text: String) {
        self.emit(UiEvent::Status(text));
    }

    fn error(&mut self, text: String) {
        self.emit(UiEvent::Error(text));
    }
}

/// A frontend nobody looks at: it drops every event and declines every question. A subagent uses it for the messages of
/// its own setup, which are not shown.
pub struct Sink;

impl Frontend for Sink {
    fn emit(&mut self, _event: UiEvent) {}

    fn approve(&mut self, _change: &str) -> bool {
        false
    }
}

/// A frontend for tests: it records every event, and renders notices and errors as the terminal does, so a test can
/// read the text.
#[cfg(test)]
pub mod test_support {
    use super::{Frontend, UiEvent};
    use std::collections::VecDeque;

    #[derive(Default)]
    pub struct TextUi {
        /// What the terminal would print on its output: notices and replies, one per line.
        pub output: String,
        /// What it would print on its error stream: statuses, and errors with the `error: ` prefix.
        pub errors: String,
        pub events: Vec<UiEvent>,
        /// The answers to the approval questions, in order. An empty queue declines.
        pub answers: VecDeque<bool>,
        /// The changes it was asked to approve.
        pub asked: Vec<String>,
    }

    impl TextUi {
        pub fn new() -> Self {
            Self::default()
        }
    }

    impl Frontend for TextUi {
        fn emit(&mut self, event: UiEvent) {
            match &event {
                UiEvent::Notice(text) | UiEvent::Reply(text) => self.output.push_str(&format!("{text}\n")),
                UiEvent::Status(text) => self.errors.push_str(&format!("{text}\n")),
                UiEvent::Error(text) => self.errors.push_str(&format!("error: {text}\n")),
                UiEvent::Stream { .. } | UiEvent::TurnEnded => {}
            }
            self.events.push(event);
        }

        fn approve(&mut self, change: &str) -> bool {
            self.asked.push(change.to_string());
            self.answers.pop_front().unwrap_or(false)
        }
    }
}
