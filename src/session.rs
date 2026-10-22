use std::collections::BTreeSet;

use crate::strata::{Message, Role};

/// The in-memory conversation history sent with each request, and the switched-off tools the model
/// has been told about in it.
pub struct Session {
    messages: Vec<Message>,
    told: BTreeSet<String>,
}

impl Session {
    pub fn new() -> Self {
        Session {
            messages: Vec::new(),
            told: BTreeSet::new(),
        }
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
    }
}
