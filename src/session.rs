use crate::environment::Environment;
use crate::tools::types::ToolCall;

#[derive(Clone, Copy)]
pub enum Role {
    System,
    User,
    Assistant,
    Tool,
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::System => "system",
            Self::User => "user",
            Self::Assistant => "assistant",
            Self::Tool => "tool",
        }
    }
}

pub struct Message {
    pub role: Role,
    pub content: String,
    pub tool_calls: Vec<ToolCall>,
    pub tool_call_id: Option<String>,
}

impl Message {
    pub fn new(role: Role, content: String) -> Self {
        Self { role, content, tool_calls: Vec::new(), tool_call_id: None }
    }
}

/// The messages one exchange adds to a conversation: the user's input, any tool exchanges, and the reply.
pub struct Turn {
    pub messages: Vec<Message>,
}

impl Turn {
    pub fn reply(&self) -> &str {
        self.messages.last().map_or("", |m| m.content.as_str())
    }
}

pub struct Conversation {
    messages: Vec<Message>,
}

impl Conversation {
    pub fn new(env: &Environment) -> Self {
        let context = Message::new(Role::System, format!("Current working directory: {}", env.cwd.display()));
        Self { messages: vec![context] }
    }

    pub fn commit(&mut self, turn: Turn) {
        self.messages.extend(turn.messages);
    }

    pub fn messages(&self) -> &[Message] {
        &self.messages
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn first_message_is_system_context_with_cwd() {
        let env = Environment { cwd: PathBuf::from("C:/work/project") };
        let conversation = Conversation::new(&env);
        let first = &conversation.messages()[0];
        assert_eq!(first.role.as_str(), "system");
        assert_eq!(first.content, "Current working directory: C:/work/project");
    }
}
