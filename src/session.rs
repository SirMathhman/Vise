use std::collections::BTreeSet;

use crate::strata::{Message, Role};

/// The in-memory conversation history sent with each request, and the switched-off tools the model
/// has been told about in it.
pub struct Session {
    messages: Vec<Message>,
    told: BTreeSet<String>,
    autosave: Option<String>,
}

impl Session {
    pub fn new() -> Self {
        Session {
            messages: Vec::new(),
            told: BTreeSet::new(),
            autosave: None,
        }
    }

    /// The name this conversation autosaves under. It is `None` until the first autosave picks one. A reset or a
    /// load clears it, so the next autosave starts a new saved session.
    pub fn autosave_name(&self) -> Option<&str> {
        self.autosave.as_deref()
    }

    pub fn set_autosave_name(&mut self, name: String) {
        self.autosave = Some(name);
    }

    pub fn messages(&self) -> &[Message] {
        &self.messages
    }

    pub fn told(&self) -> &BTreeSet<String> {
        &self.told
    }

    pub fn set_told(&mut self, told: BTreeSet<String>) {
        self.told = told;
    }

    pub fn push(&mut self, role: Role, content: String) {
        self.messages.push(Message { role, content });
    }

    /// Drops the most recent message, used to roll back a turn that failed.
    pub fn pop(&mut self) {
        self.messages.pop();
    }

    /// Starts a fresh conversation. The model knows nothing of it, so the next message announces
    /// every switched-off tool again.
    pub fn reset(&mut self) {
        self.messages.clear();
        self.told.clear();
        self.autosave = None;
    }

    /// Replaces the conversation with a saved one, including the switched-off tools the model was told about.
    pub fn restore(&mut self, messages: Vec<Message>, told: BTreeSet<String>) {
        self.messages = messages;
        self.told = told;
        self.autosave = None;
    }
}
