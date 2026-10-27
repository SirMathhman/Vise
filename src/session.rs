use crate::environment::Environment;
use crate::error::SessionError;
use crate::tools::types::ToolCall;

/// One message in a conversation. Each role carries exactly the fields it needs, so a tool result
/// always has the call it answers.
pub enum Message {
    System(String),
    User(String),
    Assistant { content: String, tool_calls: Vec<ToolCall> },
    Tool { call_id: String, content: String },
}

impl Message {
    pub fn role(&self) -> &'static str {
        match self {
            Self::System(_) => "system",
            Self::User(_) => "user",
            Self::Assistant { .. } => "assistant",
            Self::Tool { .. } => "tool",
        }
    }

    pub fn content(&self) -> &str {
        match self {
            Self::System(content) | Self::User(content) => content,
            Self::Assistant { content, .. } | Self::Tool { content, .. } => content,
        }
    }

    pub fn tool_calls(&self) -> &[ToolCall] {
        match self {
            Self::Assistant { tool_calls, .. } => tool_calls,
            _ => &[],
        }
    }

    pub fn tool_call_id(&self) -> Option<&str> {
        match self {
            Self::Tool { call_id, .. } => Some(call_id),
            _ => None,
        }
    }
}

/// The messages one exchange adds to a conversation: the user's input, any tool exchanges, and the
/// reply. Only `Turn::new` builds one, and it checks that the turn ends with a plain reply.
pub struct Turn {
    messages: Vec<Message>,
}

impl Turn {
    pub fn new(messages: Vec<Message>) -> Result<Self, SessionError> {
        match messages.last() {
            Some(Message::Assistant { tool_calls, .. }) if tool_calls.is_empty() => Ok(Self { messages }),
            _ => Err(SessionError::MalformedTurn),
        }
    }

    pub fn reply(&self) -> &str {
        self.messages.last().map_or("", Message::content)
    }

    fn into_messages(self) -> Vec<Message> {
        self.messages
    }
}

pub struct Conversation {
    messages: Vec<Message>,
}

impl Conversation {
    pub fn new(env: &Environment) -> Self {
        let context = Message::System(format!("Current working directory: {}", env.cwd.display()));
        Self { messages: vec![context] }
    }

    pub fn commit(&mut self, turn: Turn) {
        self.messages.extend(turn.into_messages());
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
        assert_eq!(first.role(), "system");
        assert_eq!(first.content(), "Current working directory: C:/work/project");
    }
}
