use crate::environment::{self, Environment};
use crate::error::SessionError;
use crate::tools::types::ToolCall;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

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
        check_shape(&messages)?;
        Ok(Self { messages, prompt_tokens: 0 })
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

/// Checks the shape `Turn::new` requires of one turn. The error carries the index of the first bad message.
fn check_shape(messages: &[Message]) -> Result<(), SessionError> {
    if !matches!(messages.first(), Some(Message::User(_))) {
        return Err(SessionError::MalformedTurn { index: 0 });
    }
    let mut index = 1;
    loop {
        match messages.get(index) {
            Some(Message::Assistant { tool_calls, .. }) if tool_calls.is_empty() => {
                if index + 1 == messages.len() {
                    return Ok(());
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

/// Checks a whole history, as a saved session holds it: an optional summary first, then turns that each pass
/// `check_shape`. The error carries the index of the first bad message within `history`.
pub fn check_history(history: &[Message]) -> Result<(), SessionError> {
    let start = usize::from(matches!(history.first(), Some(Message::Assistant { tool_calls, .. }) if tool_calls.is_empty()));
    let turn_ends = history
        .iter()
        .enumerate()
        .skip(start + 1)
        .filter(|(_, message)| matches!(message, Message::User(_)))
        .map(|(index, _)| index)
        .chain(std::iter::once(history.len()));
    let mut from = start;
    for to in turn_ends {
        if to > from {
            check_shape(&history[from..to])
                .map_err(|SessionError::MalformedTurn { index }| SessionError::MalformedTurn { index: from + index })?;
        }
        from = to;
    }
    Ok(())
}

/// Where automatic saves go, and the session this run writes to. The name is chosen after the run's first turn.
struct Autosave {
    folder: PathBuf,
    name: Option<String>,
}

/// A session name for an automatic save: the first input's words joined with '-', then the time in seconds, so
/// each run gets its own name.
fn autosave_name(first_input: &str) -> String {
    let words: Vec<String> = first_input
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|word| !word.is_empty())
        .map(str::to_ascii_lowercase)
        .collect();
    let mut slug = words.join("-");
    slug.truncate(40);
    let slug = slug.trim_end_matches('-');
    let seconds = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_secs());
    if slug.is_empty() { format!("session-{seconds}") } else { format!("{slug}-{seconds}") }
}

pub struct Conversation {
    messages: Vec<Message>,
    prompt_tokens: u64,
    autosave: Option<Autosave>,
    startup: Option<String>,
    before_turn: Option<PathBuf>,
}

impl Conversation {
    pub fn new(env: &Environment) -> Self {
        let mut context = format!("Current working directory: {}", env.cwd.display());
        // `main` reports an error from reading the file before the session starts, so it is ignored here.
        if let Some(instructions) = environment::instructions(&env.cwd).ok().flatten() {
            context.push_str("\n\n");
            context.push_str(&instructions);
        }
        Self { messages: vec![Message::System(context)], prompt_tokens: 0, autosave: None, startup: None, before_turn: None }
    }

    pub fn commit(&mut self, turn: Turn) {
        let (messages, prompt_tokens) = turn.into_parts();
        self.messages.extend(messages);
        self.prompt_tokens = prompt_tokens;
        // The first message carrying the startup output is now in the history.
        self.startup = None;
    }

    /// Text to send ahead of the next message, such as the output of the startup commands. It is kept until a turn
    /// is committed, so a failed turn carries it into the retry.
    pub fn startup(&self) -> Option<&str> {
        self.startup.as_deref()
    }

    pub fn set_startup(&mut self, text: String) {
        self.startup = Some(text);
    }

    /// Turns on the before-turn commands: each turn first runs the lines of the before-turn file in `cwd`.
    pub fn enable_before_turn(&mut self, cwd: PathBuf) {
        self.before_turn = Some(cwd);
    }

    /// The working directory whose before-turn file runs before each turn, or `None` when that is off.
    pub fn before_turn_dir(&self) -> Option<&Path> {
        self.before_turn.as_deref()
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

    /// Everything after the system context: the part a saved session holds.
    pub fn history(&self) -> &[Message] {
        &self.messages[1..]
    }

    /// Replaces the history with `history`, keeping this run's system context. The prompt token count is
    /// unknown until the next request.
    pub fn replace_history(&mut self, history: Vec<Message>) {
        self.messages.truncate(1);
        self.messages.extend(history);
        self.prompt_tokens = 0;
        // The loaded history goes to a new autosave file, so the file this run was writing keeps its earlier history.
        if let Some(autosave) = &mut self.autosave {
            autosave.name = None;
        }
    }

    /// Turns on automatic saves: after each completed turn, the history is written to a session in `folder`.
    pub fn enable_autosave(&mut self, folder: PathBuf) {
        self.autosave = Some(Autosave { folder, name: None });
    }

    /// The folder and session name the history is autosaved to, or None when autosave is off. The name is
    /// chosen from `first_input` the first time it is asked, and kept until the history is replaced.
    pub fn autosave_target(&mut self, first_input: &str) -> Option<(PathBuf, String)> {
        let autosave = self.autosave.as_mut()?;
        let name = autosave.name.get_or_insert_with(|| autosave_name(first_input)).clone();
        Some((autosave.folder.clone(), name))
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

    #[test]
    fn replace_history_keeps_only_this_runs_system_context() {
        let env = Environment { cwd: PathBuf::from("C:/work") };
        let mut conversation = Conversation::new(&env);
        conversation.commit(plain_turn("old"));
        conversation.replace_history(vec![Message::User("saved".into()), reply()]);
        assert_eq!(conversation.messages().len(), 3);
        assert_eq!(conversation.messages()[0].content(), "Current working directory: C:/work");
        assert_eq!(conversation.history().len(), 2);
        assert_eq!(conversation.history()[0].content(), "saved");
        assert_eq!(conversation.prompt_tokens(), 0);
    }

    #[test]
    fn autosave_name_starts_with_the_first_input_and_ends_with_a_time() {
        let name = autosave_name("Hello, World!");
        let (slug, seconds) = name.rsplit_once('-').expect("a name with a time");
        assert_eq!(slug, "hello-world");
        assert!(seconds.parse::<u64>().is_ok());
        assert!(autosave_name("  ?? ").starts_with("session-"));
    }

    #[test]
    fn autosave_name_keeps_at_most_40_slug_characters() {
        let name = autosave_name(&"word ".repeat(20));
        let (slug, _) = name.rsplit_once('-').expect("a name with a time");
        assert!(slug.len() <= 40);
        assert!(!slug.ends_with('-'));
    }

    #[test]
    fn replaced_history_gets_a_new_autosave_name() {
        let env = Environment { cwd: PathBuf::from("C:/work") };
        let mut conversation = Conversation::new(&env);
        conversation.enable_autosave(PathBuf::from("C:/unused"));
        let (_, before) = conversation.autosave_target("first").expect("autosave is on");
        conversation.replace_history(Vec::new());
        let (_, after) = conversation.autosave_target("second").expect("autosave is on");
        assert!(before.starts_with("first-"));
        assert!(after.starts_with("second-"));
    }

    #[test]
    fn autosave_is_off_by_default() {
        let env = Environment { cwd: PathBuf::from("C:/work") };
        assert!(Conversation::new(&env).autosave_target("first").is_none());
    }
}
