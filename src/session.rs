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
/// reply. Only `Turn::new` builds one, and it checks the whole shape: a user message, then an optional
/// summary of earlier rounds, then each assistant tool call followed by one result per call, then a
/// reply with no tool calls.
/// Whether a prompt of `prompt_tokens` has reached 80% of a `context_size` window. A prompt count of 0
/// means no request has been made yet, so it is never full.
pub fn over_budget(prompt_tokens: u64, context_size: u64) -> bool {
    prompt_tokens > 0 && prompt_tokens * 10 >= context_size * 8
}

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
                    if index + 1 == messages.len() {
                        return Ok(Self { messages, prompt_tokens: 0 });
                    }
                    // Only a summary may come before the end of a turn, and only directly after the user.
                    if index != 1 {
                        return Err(SessionError::MalformedTurn { index });
                    }
                    index += 1;
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

    /// Replaces the history with the system context, the summary as an assistant message, and the
    /// last two turns, which stay verbatim. The prompt token count is unknown until the next request.
    pub fn compact(&mut self, summary: String) {
        let turn_starts: Vec<usize> = self
            .messages
            .iter()
            .enumerate()
            .filter(|(_, message)| matches!(message, Message::User(_)))
            .map(|(index, _)| index)
            .collect();
        let keep_from = match turn_starts.len() {
            0 => self.messages.len(),
            1 => turn_starts[0],
            count => turn_starts[count - 2],
        };
        let kept = self.messages.split_off(keep_from);
        self.messages.truncate(1);
        self.messages.push(Message::Assistant { content: summary, tool_calls: Vec::new() });
        self.messages.extend(kept);
        self.prompt_tokens = 0;
    }

    /// Whether the last prompt has reached the compaction budget for a context of `context_size`.
    pub fn needs_compaction(&self, context_size: u64) -> bool {
        over_budget(self.prompt_tokens, context_size)
    }

    /// Drops the oldest part of the history: the summary if there is one, otherwise the oldest turn.
    /// Returns how many messages were removed.
    pub fn drop_oldest_turn(&mut self) -> usize {
        let end = self
            .messages
            .iter()
            .enumerate()
            .skip(2)
            .find(|(_, message)| matches!(message, Message::User(_)))
            .map_or(self.messages.len(), |(index, _)| index);
        self.messages.drain(1..end);
        self.prompt_tokens = 0;
        end - 1
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

    fn plain_turn(input: &str) -> Turn {
        Turn::new(vec![Message::User(input.into()), reply()]).ok().expect("a plain turn is well formed")
    }

    #[test]
    fn summary_may_precede_tool_rounds() {
        let messages = vec![Message::User("hi".into()), reply(), calls_message("c1"), result("c1"), reply()];
        assert!(Turn::new(messages).is_ok());
    }

    #[test]
    fn compact_keeps_system_summary_and_last_two_turns() {
        let env = Environment { cwd: PathBuf::from("C:/work") };
        let mut conversation = Conversation::new(&env);
        for input in ["a", "b", "c"] {
            conversation.commit(plain_turn(input));
        }
        conversation.compact("summary".into());
        let messages = conversation.messages();
        assert_eq!(messages.len(), 6);
        assert_eq!(messages[1].content(), "summary");
        assert_eq!(messages[2].content(), "b");
        assert_eq!(messages[4].content(), "c");
    }

    #[test]
    fn drop_oldest_turn_removes_the_summary_then_the_oldest_turn() {
        let env = Environment { cwd: PathBuf::from("C:/work") };
        let mut conversation = Conversation::new(&env);
        for input in ["a", "b"] {
            conversation.commit(plain_turn(input));
        }
        conversation.drop_oldest_turn();
        assert_eq!(conversation.messages().len(), 3);
        assert_eq!(conversation.messages()[1].content(), "b");
    }
}
