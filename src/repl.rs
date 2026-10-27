use crate::error::ProviderError;
use crate::provider::types::Provider;
use crate::session::{Conversation, Message, Turn};
use crate::tools::types::ToolRunner;
use std::io::{self, BufRead, Write};

const HELP: &str = "\
/compact              summarize the conversation to free up context space
/context              show the working directory and the tokens used out of the context size
/exit                 end the session
/help                 show this list
/tools                list each tool and whether the model may call it
/tools enable NAME    let the model call a tool
/tools disable NAME   stop the model calling a tool";

enum Command {
    Compact,
    Exit,
    Context,
    Help,
    Tools,
    Enable(String),
    Disable(String),
}

/// Slash commands are handled here and never sent to the model. Any other line, including an unknown
/// slash command, is sent as a message.
fn command(line: &str) -> Option<Command> {
    let line = line.trim();
    if let Some(rest) = line.strip_prefix("/tools") {
        return match rest.split_whitespace().collect::<Vec<_>>().as_slice() {
            [] => Some(Command::Tools),
            ["enable", name] => Some(Command::Enable(name.to_string())),
            ["disable", name] => Some(Command::Disable(name.to_string())),
            _ => None,
        };
    }
    match line {
        "/exit" => Some(Command::Exit),
        "/context" => Some(Command::Context),
        "/help" => Some(Command::Help),
        "/compact" => Some(Command::Compact),
        _ => None,
    }
}

/// One line per tool in the catalogue, with whether the model may call it.
fn tool_list(tools: &dyn ToolRunner) -> String {
    let enabled = tools.enabled();
    crate::tools::specs()
        .iter()
        .map(|spec| {
            let state = if enabled.contains(&spec.name) { "enabled" } else { "disabled" };
            format!("{}: {state}", spec.name)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Enables or disables a tool, reporting the result on `output` or the failure on `errors`.
fn toggle(
    tools: &dyn ToolRunner,
    name: &str,
    on: bool,
    output: &mut impl Write,
    errors: &mut impl Write,
) -> io::Result<()> {
    match tools.set_enabled(name, on) {
        Ok(()) => writeln!(output, "{name}: {}", if on { "enabled" } else { "disabled" }),
        Err(err) => writeln!(errors, "error: {err}"),
    }
}

pub fn run(
    input: &mut impl BufRead,
    output: &mut impl Write,
    errors: &mut impl Write,
    provider: &dyn Provider,
    tools: &dyn ToolRunner,
    conversation: &mut Conversation,
) -> io::Result<()> {
    loop {
        let line = match read_line(input) {
            Ok(Some(line)) => line,
            Ok(None) => break,
            Err(err) => {
                writeln!(errors, "error: failed to read from stdin: {err}")?;
                break;
            }
        };
        match command(&line) {
            Some(Command::Exit) => break,
            Some(Command::Help) => writeln!(output, "{HELP}")?,
            Some(Command::Tools) => writeln!(output, "{}", tool_list(tools))?,
            Some(Command::Enable(name)) => toggle(tools, &name, true, output, errors)?,
            Some(Command::Disable(name)) => toggle(tools, &name, false, output, errors)?,
            Some(Command::Compact) => match compact(provider, conversation) {
                Ok(Compaction::Summarized) => writeln!(output, "conversation compacted")?,
                Ok(Compaction::Dropped(removed)) => writeln!(
                    output,
                    "the summary did not fit, so the oldest turn was dropped ({removed} messages removed)"
                )?,
                Err(err) => writeln!(errors, "error: {err}")?,
            },
            Some(Command::Context) => {
                let context = conversation.messages().first().map_or("", Message::content);
                writeln!(output, "{context}")?;
                match provider.context_size() {
                    Ok(total) => writeln!(output, "{} / {total}", conversation.prompt_tokens())?,
                    Err(err) => writeln!(errors, "error: {err}")?,
                }
            }
            None => {
                // Approval prompts read their answers from the same input as the lines themselves.
                let mut approve = |change: &str| ask(change, &mut *output, &mut *input);
                match run_turn(provider, conversation, line, tools, &mut approve) {
                    Ok((turn, compaction)) => {
                        if let Some(Compaction::Dropped(removed)) = compaction {
                            writeln!(output, "the context was full, so the oldest turn was dropped ({removed} messages removed)")?;
                        }
                        writeln!(output, "{}", turn.reply())?;
                        conversation.commit(turn);
                    }
                    Err(err) => writeln!(errors, "error: {err}")?,
                }
            }
        }
    }
    Ok(())
}

/// Reads one line without its line ending. Returns `None` at the end of input.
fn read_line(input: &mut impl BufRead) -> io::Result<Option<String>> {
    let mut line = String::new();
    if input.read_line(&mut line)? == 0 {
        return Ok(None);
    }
    Ok(Some(line.trim_end_matches(['\n', '\r']).to_string()))
}

/// Shows a proposed change and reads the answer. Only "y" or "yes" accepts it. A failure to read or
/// write declines it.
fn ask(change: &str, output: &mut impl Write, input: &mut impl BufRead) -> bool {
    if writeln!(output, "{change}\napply this change? [y/N]").and_then(|()| output.flush()).is_err() {
        return false;
    }
    matches!(read_line(input), Ok(Some(answer)) if matches!(answer.trim().to_lowercase().as_str(), "y" | "yes"))
}

/// How the history was shrunk: replaced by a summary, or cut by dropping the oldest turn.
#[derive(Clone, Copy)]
enum Compaction {
    Summarized,
    Dropped(usize),
}

/// Replaces the older history with a summary the model writes of it. If the summary request does not
/// fit in the context, the oldest turn is dropped instead.
fn compact(provider: &dyn Provider, conversation: &mut Conversation) -> Result<Compaction, ProviderError> {
    match provider.summarize(conversation.messages()) {
        Ok(summary) => {
            conversation.compact(summary);
            Ok(Compaction::Summarized)
        }
        Err(ProviderError::ContextFull) => Ok(Compaction::Dropped(conversation.drop_oldest_turn())),
        Err(err) => Err(err),
    }
}

/// Compacts the conversation before a turn when its last prompt has reached the budget.
fn compact_if_full(provider: &dyn Provider, conversation: &mut Conversation) -> Result<Option<Compaction>, ProviderError> {
    if conversation.needs_compaction(provider.context_size()?) {
        Ok(Some(compact(provider, conversation)?))
    } else {
        Ok(None)
    }
}

/// Sends a turn. If the context fills up during it, the conversation is compacted and the turn is
/// sent once more from the compacted history. Returns the turn and the last compaction it needed.
fn run_turn(
    provider: &dyn Provider,
    conversation: &mut Conversation,
    line: String,
    tools: &dyn ToolRunner,
    approve: &mut dyn FnMut(&str) -> bool,
) -> Result<(Turn, Option<Compaction>), ProviderError> {
    let mut compaction = compact_if_full(provider, conversation)?;
    match provider.complete(conversation.messages(), line.clone(), tools, approve) {
        Err(ProviderError::ContextFull) => {
            compaction = Some(compact(provider, conversation)?);
            let turn = provider.complete(conversation.messages(), line, tools, approve)?;
            Ok((turn, compaction))
        }
        result => Ok((result?, compaction)),
    }
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
        summary_full: bool,
    }

    impl Fake {
        fn new(behavior: Behavior) -> Self {
            Self { behavior, inputs: RefCell::new(Vec::new()), summary_full: false }
        }
    }

    impl Provider for Fake {
        fn complete(
            &self,
            _history: &[Message],
            input: String,
            _runner: &dyn ToolRunner,
            _approve: &mut dyn FnMut(&str) -> bool,
        ) -> Result<Turn, ProviderError> {
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

        fn context_size(&self) -> Result<u64, ProviderError> {
            Ok(0)
        }

        fn summarize(&self, _history: &[Message]) -> Result<String, ProviderError> {
            if self.summary_full {
                return Err(ProviderError::ContextFull);
            }
            Ok("summary".into())
        }
    }

    struct NoTools;

    impl ToolRunner for NoTools {
        fn run(&self, _invocation: &Invocation, _approve: &mut dyn FnMut(&str) -> bool) -> Result<String, ToolError> {
            Err(ToolError::UnknownTool("none".into()))
        }
    }

    fn conversation() -> Conversation {
        Conversation::new(&Environment { cwd: PathBuf::from("C:/work") })
    }

    fn run_with(input: &str, provider: &Fake, conversation: &mut Conversation) -> (String, String) {
        let mut output = Vec::new();
        let mut errors = Vec::new();
        run(&mut input.as_bytes(), &mut output, &mut errors, provider, &NoTools, conversation).unwrap();
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

    #[test]
    fn compact_reports_a_dropped_turn_when_the_summary_does_not_fit() {
        let fake = Fake { summary_full: true, ..Fake::new(Behavior::Reply) };
        let mut conversation = conversation();
        run_with("first\n", &fake, &mut conversation);
        let (output, _) = run_with("/compact\n", &fake, &mut conversation);
        assert!(output.contains("the summary did not fit, so the oldest turn was dropped"));
        assert!(!output.contains("conversation compacted"));
    }

    struct ClosedWriter;

    impl Write for ClosedWriter {
        fn write(&mut self, _buf: &[u8]) -> io::Result<usize> {
            Err(io::Error::from(io::ErrorKind::BrokenPipe))
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn closed_error_stream_is_returned_as_an_error() {
        let fake = Fake::new(Behavior::Fail);
        let mut conversation = conversation();
        let mut output = Vec::new();
        let result = run(
            &mut "hi\n".as_bytes(),
            &mut output,
            &mut ClosedWriter,
            &fake,
            &NoTools,
            &mut conversation,
        );
        assert!(result.is_err());
    }
}
