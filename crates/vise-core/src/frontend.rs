//! What a user interface is to the backend. The backend never writes to a terminal and never reads from one: every message
//! for the user is a `UiEvent`, and every yes/no question is a `Frontend::approve` call. A frontend (the terminal today,
//! another one later) implements `Frontend` and decides how to show events and ask.

use crate::provider::types::Event;
use serde::{Deserialize, Serialize};

/// A tool and whether the model may call it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolState {
    pub name: String,
    pub enabled: bool,
}

/// Why the oldest turn was dropped from the history.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DropCause {
    /// A summary of the history did not fit in the context, so `/compact` dropped a turn instead.
    SummaryDidNotFit,
    /// The context filled up during a turn.
    ContextFull,
}

/// Something the engine changed, as a fact. The frontend words it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Change {
    ToolToggled { name: String, enabled: bool },
    /// A profile's tools and notes now apply. `new_hooks` lists its hook lines (`KIND: COMMAND`) when they are new or changed
    /// since the run started, and run without a prompt.
    ProfileApplied { name: String, tool_changes: Vec<ToolState>, new_hooks: Vec<String> },
    /// The profile is selected, and its instructions go with the next message.
    ProfileSelected { name: String },
    SessionSaved { name: String },
    SessionLoaded { name: String },
    /// The model in use is `name`. `default_saved` is whether it was also kept as the default for the next launch.
    ModelSet { name: String, default_saved: bool },
    /// The history was replaced by a summary.
    Compacted,
    OldestTurnDropped { removed: usize, cause: DropCause },
    /// The conversation was emptied.
    Reset,
    NoteCreated { name: String },
    NoteDeleted { name: String },
}

/// A note as the notes index shows it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NoteLine {
    pub name: String,
    pub category: String,
    pub summary: String,
}

/// One thing the backend tells the user. It is plain data, so a frontend can draw it, log it, or send it elsewhere.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum UiEvent {
    /// A line for the user, shown as it is.
    Notice(String),
    /// A line about the run itself, such as which session was resumed. It is not part of the conversation.
    Status(String),
    /// Something went wrong. The text has no "error:" prefix: the frontend adds whatever marks an error for it.
    Error(String),
    /// The whole answer, sent when it was not already shown piece by piece as `Stream` answer events.
    Reply(String),
    /// Something the engine changed. How to word it is the frontend's business.
    Changed(Change),
    /// The results of the query commands, as data. How to word them, and what to say when one is empty, is the frontend's
    /// business. Every tool, and whether the model may call it:
    Tools(Vec<ToolState>),
    /// The profile names, the built-in `default` included.
    Profiles(Vec<String>),
    /// The model ids the server lists, and the one in use.
    Models { current: String, ids: Vec<String> },
    /// The saved sessions' names.
    Sessions(Vec<String>),
    /// The notes the command asked for.
    Notes(Vec<NoteLine>),
    /// One note in full.
    Note { name: String, summary: String, category: String, content: String },
    /// The standing context message, the tokens the last request used, and the context size when the server reports it.
    Context { text: String, prompt_tokens: u64, size: Option<u64> },
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
                // Data, not text: a test reads the event.
                UiEvent::Changed(_)
                | UiEvent::Note { .. }
                | UiEvent::Tools(_)
                | UiEvent::Profiles(_)
                | UiEvent::Models { .. }
                | UiEvent::Sessions(_)
                | UiEvent::Notes(_)
                | UiEvent::Context { .. } => {}
            }
            self.events.push(event);
        }

        fn approve(&mut self, change: &str) -> bool {
            self.asked.push(change.to_string());
            self.answers.pop_front().unwrap_or(false)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_and_requests_survive_a_round_trip_through_json() {
        use crate::command::Command;
        use crate::engine::Request;
        let events = vec![
            UiEvent::Notice("hi".into()),
            UiEvent::Models { current: "a".into(), ids: vec!["a".into(), "b".into()] },
            UiEvent::Tools(vec![ToolState { name: "read_file".into(), enabled: true }]),
            UiEvent::Stream { event: Event::Tool { name: "read_file".into(), target: Some("a.txt".into()) }, nested: true },
            UiEvent::Context { text: "context".into(), prompt_tokens: 3, size: None },
            UiEvent::Changed(Change::ProfileApplied {
                name: "explore".into(),
                tool_changes: vec![ToolState { name: "create_file".into(), enabled: false }],
                new_hooks: vec!["before-turn: Get-Date".into()],
            }),
            UiEvent::Changed(Change::OldestTurnDropped { removed: 2, cause: DropCause::ContextFull }),
            UiEvent::Note { name: "plan".into(), summary: "s".into(), category: "memory".into(), content: "text".into() },
            UiEvent::TurnEnded,
        ];
        for event in events {
            let json = serde_json::to_string(&event).expect("encodes");
            assert_eq!(serde_json::from_str::<UiEvent>(&json).expect("decodes"), event, "{json}");
        }
        let request = Request::Command(Command::Save("work".into()));
        let json = serde_json::to_string(&request).expect("encodes");
        assert_eq!(serde_json::from_str::<Request>(&json).expect("decodes"), request, "{json}");
    }
}
