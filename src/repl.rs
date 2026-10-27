use crate::provider::types::Provider;
use crate::session::{Conversation, Message};
use crate::tools::types::ToolRunner;
use std::io::{self, BufRead, Write};

enum Command {
    Exit,
    Context,
}

/// Slash commands are handled here and never sent to the model. Any other line, including an unknown
/// slash command, is sent as a message.
fn command(line: &str) -> Option<Command> {
    match line.trim() {
        "/exit" => Some(Command::Exit),
        "/context" => Some(Command::Context),
        _ => None,
    }
}

pub fn run(
    input: impl BufRead,
    output: &mut impl Write,
    errors: &mut impl Write,
    provider: &dyn Provider,
    tools: &dyn ToolRunner,
    conversation: &mut Conversation,
) -> io::Result<()> {
    for line in input.lines() {
        let line = match line {
            Ok(line) => line,
            Err(err) => {
                writeln!(errors, "error: failed to read from stdin: {err}")?;
                break;
            }
        };
        match command(&line) {
            Some(Command::Exit) => break,
            Some(Command::Context) => {
                let context = conversation.messages().first().map_or("", Message::content);
                writeln!(output, "{context}")?;
            }
            None => match provider.complete(conversation.messages(), line, tools) {
                Ok(turn) => {
                    writeln!(output, "{}", turn.reply())?;
                    conversation.commit(turn);
                }
                Err(err) => writeln!(errors, "error: {err}")?,
            },
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::environment::Environment;
    use crate::error::ProviderError;
    use crate::session::{Message, Turn};
    use crate::tools::types::{Invocation, ToolCall, ToolError};
    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::path::PathBuf;

    enum Behavior {
        Reply,
        ToolRound,
        Fail,
    }

    struct Fake {
        behavior: Behavior,
        inputs: RefCell<Vec<String>>,
    }

    impl Fake {
        fn new(behavior: Behavior) -> Self {
            Self { behavior, inputs: RefCell::new(Vec::new()) }
        }
    }

    impl Provider for Fake {
        fn complete(&self, _history: &[Message], input: String, _runner: &dyn ToolRunner) -> Result<Turn, ProviderError> {
            self.inputs.borrow_mut().push(input.clone());
            let messages = match self.behavior {
                Behavior::Reply => vec![
                    Message::User(input),
                    Message::Assistant { content: "reply".into(), tool_calls: Vec::new() },
                ],
                Behavior::ToolRound => vec![
                    Message::User(input),
                    Message::Assistant {
                        content: String::new(),
                        tool_calls: vec![ToolCall {
                            id: "call_1".into(),
                            name: "list_directory".into(),
                            arguments: HashMap::new(),
                        }],
                    },
                    Message::Tool { call_id: "call_1".into(), content: "a.txt".into() },
                    Message::Assistant { content: "done".into(), tool_calls: Vec::new() },
                ],
                Behavior::Fail => return Err(ProviderError::Transport("boom".into())),
            };
            Turn::new(messages).map_err(ProviderError::Session)
        }
    }

    struct NoTools;

    impl ToolRunner for NoTools {
        fn run(&self, _invocation: &Invocation) -> Result<String, ToolError> {
            Err(ToolError::UnknownTool("none".into()))
        }
    }

    fn conversation() -> Conversation {
        Conversation::new(&Environment { cwd: PathBuf::from("C:/work") })
    }

    fn run_with(input: &str, provider: &Fake, conversation: &mut Conversation) -> (String, String) {
        let mut output = Vec::new();
        let mut errors = Vec::new();
        run(input.as_bytes(), &mut output, &mut errors, provider, &NoTools, conversation).unwrap();
        (String::from_utf8(output).unwrap(), String::from_utf8(errors).unwrap())
    }

    #[test]
    fn failed_turn_leaves_history_unchanged() {
        let fake = Fake::new(Behavior::Fail);
        let mut conversation = conversation();
        let (output, errors) = run_with("hi\n", &fake, &mut conversation);
        assert_eq!(conversation.messages().len(), 1);
        assert!(errors.contains("error: request to the model failed (boom)"));
        assert!(output.is_empty());
    }

    #[test]
    fn slash_exit_ends_the_loop() {
        let fake = Fake::new(Behavior::Reply);
        let mut conversation = conversation();
        run_with("first\n/exit\nsecond\n", &fake, &mut conversation);
        assert_eq!(*fake.inputs.borrow(), vec!["first"]);
    }

    #[test]
    fn plain_exit_and_quit_are_sent_to_the_model() {
        let fake = Fake::new(Behavior::Reply);
        let mut conversation = conversation();
        run_with("exit\nquit\n", &fake, &mut conversation);
        assert_eq!(*fake.inputs.borrow(), vec!["exit", "quit"]);
    }

    #[test]
    fn empty_lines_are_sent_to_the_provider() {
        let fake = Fake::new(Behavior::Reply);
        let mut conversation = conversation();
        run_with("\n  \n", &fake, &mut conversation);
        assert_eq!(*fake.inputs.borrow(), vec!["", "  "]);
    }

    #[test]
    fn committed_tool_rounds_stay_in_history() {
        let fake = Fake::new(Behavior::ToolRound);
        let mut conversation = conversation();
        let (output, _) = run_with("list\n", &fake, &mut conversation);
        let messages = conversation.messages();
        assert_eq!(messages.len(), 5);
        assert_eq!(messages[2].tool_calls().len(), 1);
        assert_eq!(messages[3].role(), "tool");
        assert_eq!(messages[3].tool_call_id(), Some("call_1"));
        assert_eq!(output, "done\n");
    }
}
