use crate::strata::{Message, Role};

/// The in-memory conversation history sent with each request.
pub struct Session {
    messages: Vec<Message>,
}

impl Session {
    pub fn new() -> Self {
        Session { messages: Vec::new() }
    }

    pub fn messages(&self) -> &[Message] {
        &self.messages
    }

    pub fn push(&mut self, role: Role, content: String) {
        self.messages.push(Message { role, content });
    }

    /// Drops the most recent message, used to roll back a turn that failed.
    pub fn pop(&mut self) {
        self.messages.pop();
    }

    pub fn reset(&mut self) {
        self.messages.clear();
    }
}
