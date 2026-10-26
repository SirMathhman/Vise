use crate::environment::Environment;

#[derive(Clone, Copy)]
pub enum Role {
    System,
    User,
    Assistant,
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::System => "system",
            Self::User => "user",
            Self::Assistant => "assistant",
        }
    }
}

pub struct Message {
    pub role: Role,
    pub content: String,
}

pub struct Conversation {
    messages: Vec<Message>,
}

impl Conversation {
    pub fn new(env: &Environment) -> Self {
        let context = Message {
            role: Role::System,
            content: format!("Current working directory: {}", env.cwd.display()),
        };
        Self { messages: vec![context] }
    }

    pub fn push(&mut self, role: Role, content: String) {
        self.messages.push(Message { role, content });
    }

    pub fn pop_last(&mut self) {
        self.messages.pop();
    }

    pub fn messages(&self) -> &[Message] {
        &self.messages
    }
}
