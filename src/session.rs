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
/// reply. Only `Turn::new` builds one, and it checks the whole shape: a user message, then each
/// assistant tool call followed by one result per call, then a reply with no tool calls.
pub struct Turn {
    messages: Vec<Message>,
    prompt_tokens: u64,
}

impl Turn {
    pub fn new(messages: Vec<Message>) -> Result<Self, SessionError> {
        if !matches!(messages.first(), Some(Message::User(_))) {
            return Err(SessionError::MalformedTurn { index: 0 });
        }
        let mut index = 1;
        loop {
            match messages.get(index) {
                Some(Message::Assistant { tool_calls, .. }) if tool_calls.is_empty() => {
                    return if index + 1 == messages.len() {
                        Ok(Self { messages, prompt_tokens: 0 })
                    } else {
                        Err(SessionError::MalformedTurn { index: index + 1 })
                    };
                }
                Some(Message::Assistant { tool_calls, .. }) => {
                    for (offset, call) in tool_calls.iter().enumerate() {
                        let position = index + 1 + offset;
                        match messages.get(position) {
                            Some(Message::Tool { call_id, .. }) if *call_id == call.id => {}
                            _ => return Err(SessionError::MalformedTurn { index: position }),
                        }
                    }
                    index += 1 + tool_calls.len();
                }
                _ => return Err(SessionError::MalformedTurn { index }),
            }
        }
    }

    /// Records how many prompt tokens the model reported for the request that produced this turn.
    pub fn with_prompt_tokens(mut self, prompt_tokens: u64) -> Self {
        self.prompt_tokens = prompt_tokens;
        self
    }

    pub fn reply(&self) -> &str {
        self.messages.last().map_or("", Message::content)
    }

    fn into_parts(self) -> (Vec<Message>, u64) {
        (self.messages, self.prompt_tokens)
    }
}

pub struct Conversation {
    messages: Vec<Message>,
    prompt_tokens: u64,
}

impl Conversation {
    pub fn new(env: &Environment) -> Self {
        let context = Message::System(format!("Current working directory: {}", env.cwd.display()));
        Self { messages: vec![context], prompt_tokens: 0 }
    }

    pub fn commit(&mut self, turn: Turn) {
        let (messages, prompt_tokens) = turn.into_parts();
        self.messages.extend(messages);
        self.prompt_tokens = prompt_tokens;
    }

    /// The prompt tokens the model reported for the most recent request, or 0 before any turn.
    pub fn prompt_tokens(&self) -> u64 {
        self.prompt_tokens
    }

    pub fn messages(&self) -> &[Message] {
        &self.messages
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::path::PathBuf;

    #[test]
    fn first_message_is_system_context_with_cwd() {
        let env = Environment { cwd: PathBuf::from("C:/work/project") };
        let conversation = Conversation::new(&env);
        let first = &conversation.messages()[0];
        assert_eq!(first.role(), "system");
        assert_eq!(first.content(), "Current working directory: C:/work/project");
    }

    fn call(id: &str) -> ToolCall {
        ToolCall { id: id.into(), name: "list_directory".into(), arguments: HashMap::new() }
    }

    fn calls_message(id: &str) -> Message {
        Message::Assistant { content: String::new(), tool_calls: vec![call(id)] }
    }

    fn result(id: &str) -> Message {
        Message::Tool { call_id: id.into(), content: "a.txt".into() }
    }

    fn reply() -> Message {
        Message::Assistant { content: "done".into(), tool_calls: Vec::new() }
    }

    fn rejected_at(messages: Vec<Message>) -> usize {
        match Turn::new(messages).err() {
            Some(SessionError::MalformedTurn { index }) => index,
            None => panic!("expected the turn to be rejected"),
        }
    }

    #[test]
    fn turn_must_start_with_user_message() {
        assert_eq!(rejected_at(vec![result("c1"), reply()]), 0);
    }

    #[test]
    fn tool_result_must_follow_its_call() {
        assert_eq!(rejected_at(vec![Message::User("hi".into()), result("c1"), reply()]), 1);
    }

    #[test]
    fn every_call_needs_a_result() {
        assert_eq!(rejected_at(vec![Message::User("hi".into()), calls_message("c1"), reply()]), 2);
    }

    #[test]
    fn turn_cannot_end_with_a_tool_call() {
        assert_eq!(rejected_at(vec![Message::User("hi".into()), calls_message("c1"), result("c1")]), 3);
    }

    #[test]
    fn tool_round_trip_is_accepted() {
        let messages = vec![Message::User("hi".into()), calls_message("c1"), result("c1"), reply()];
        assert!(Turn::new(messages).is_ok());
    }
}
