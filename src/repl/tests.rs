use super::*;
use crate::provider::types::SubagentRunner;
use crate::session::HookLines;
use crate::environment::Environment;
use crate::error::ProviderError;
use crate::session::{Message, PartialTurn, Turn};
use crate::tools::types::{Invocation, ToolCall, ToolError};
use std::cell::RefCell;
use std::collections::HashMap;
use std::path::PathBuf;

enum Behavior {
    Reply,
    ToolRound,
    Fail,
    /// Replies to the first request and reports a full context for every later one.
    ReplyThenFull,
    /// Presses Ctrl+C in place of replying, the way a stopped request reports.
    Interrupted,
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
        _subagent: &mut SubagentRunner,
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
            Behavior::Interrupted => {
                // The request was sent, so it carries a timing the audit log should keep.
                let timings = crate::session::Timings { prompt_ms: Some(12.5), prompt_n: Some(7), ..Default::default() };
                let request = crate::session::RequestRecord {
                    round: 1,
                    kind: "turn",
                    prompt_tokens: 41,
                    timings,
                };
                return Err(ProviderError::Interrupted {
                    stopped: PartialTurn::new(vec![Message::User(input)], "half a rep".into())
                        .with_requests(vec![request]),
                });
            }
            Behavior::ReplyThenFull if self.inputs.borrow().len() > 1 => return Err(ProviderError::ContextFull),
            Behavior::ReplyThenFull => vec![
                Message::User(input),
                Message::Assistant { content: "reply".into(), tool_calls: Vec::new() },
            ],
        };
        Turn::new(messages).map_err(ProviderError::Session)
    }

    fn context_size(&self) -> Result<u64, ProviderError> {
        Ok(0)
    }

    fn summarize(&self, _history: &[Message]) -> Result<(String, crate::session::RequestRecord), ProviderError> {
        if self.summary_full {
            return Err(ProviderError::ContextFull);
        }
        Ok(("summary".into(), crate::session::RequestRecord::default()))
    }
}

struct NoTools;

impl ToolRunner for NoTools {
    fn notes_folder(&self) -> PathBuf {
        std::env::temp_dir().join("vise-no-notes")
    }

    fn run(&self, _invocation: &Invocation, _approve: &mut dyn FnMut(&str) -> bool) -> Result<String, ToolError> {
        Err(ToolError::UnknownTool("none".into()))
    }
}

#[test]
fn profile_command_must_be_a_whole_word() {
    assert!(matches!(command("/profile coder"), Some(Command::Profile(name)) if name == "coder"));
    assert!(matches!(command("/profile"), Some(Command::Profiles)));
    assert!(command("/profiles").is_none());
}

fn conversation() -> Conversation {
    Conversation::new(&Environment { cwd: PathBuf::from("C:/work") })
}

/// The folder `/save` writes to in these tests: a temp folder, so the real sessions database is never touched.
fn sessions_folder() -> PathBuf {
    std::env::temp_dir().join(format!("vise-repl-sessions-{}", std::process::id()))
}

fn run_with(input: &str, provider: &Fake, conversation: &mut Conversation) -> (String, String) {
    run_in(input, provider, conversation, &sessions_folder())
}

/// Runs `input` with `sessions` as the sessions folder, for a test that reads what the run saved there.
fn run_in(input: &str, provider: &Fake, conversation: &mut Conversation, sessions: &Path) -> (String, String) {
    let mut output = Vec::new();
    let mut errors = Vec::new();
    run(&mut input.as_bytes(), &mut output, &mut errors, provider, &NoTools, conversation, sessions).unwrap();
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
fn a_stopped_turn_commits_the_text_it_reached() {
    let fake = Fake::new(Behavior::Interrupted);
    let mut conversation = conversation();
    let (output, errors) = run_with("hi\n", &fake, &mut conversation);
    let history = conversation.messages();
    assert_eq!(history.len(), 3, "the message and the partial reply are kept");
    assert!(history[2].content().starts_with("half a rep"));
    assert!(history[2].content().contains("[the turn was interrupted]"));
    assert!(output.contains("the turn was stopped before it finished"));
    assert!(!errors.contains("error:"));
}

#[test]
fn a_stopped_turn_keeps_the_tool_rounds_that_finished() {
    let rounds = vec![
        Message::User("hi".into()),
        Message::Assistant {
            content: String::new(),
            tool_calls: vec![ToolCall { id: "call_1".into(), name: "list_directory".into(), arguments: HashMap::new() }],
        },
        Message::Tool { call_id: "call_1".into(), content: "a.txt".into() },
    ];
    let messages = interrupted_turn(PartialTurn::new(rounds, String::new()));
    assert_eq!(messages.len(), 3, "the call, its result, and the marker");
    assert_eq!(messages[0].tool_calls().len(), 1, "the call is kept with its arguments");
    assert_eq!(messages[1].tool_call_id(), Some("call_1"));
    assert!(messages[2].content().contains("[the turn was interrupted]"));
}

#[test]
fn a_stopped_turn_with_no_reply_text_still_ends_with_an_assistant_message() {
    let messages = interrupted_turn(PartialTurn::new(vec![Message::User("hi".into())], String::new()));
    assert_eq!(messages.len(), 1);
    assert!(messages[0].content().contains("[the turn was interrupted]"));
}

/// The history a stopped turn adds, read back through the checks the recorder applies.
fn interrupted_turn(stopped: PartialTurn) -> Vec<Message> {
    let mut conversation = conversation();
    let mut input = "".as_bytes();
    let mut output = Vec::new();
    let mut errors = Vec::new();
    let mut streams = Streams { input: &mut input, output: &mut output, errors: &mut errors };
    interrupted("hi".into(), stopped, &mut conversation, &sessions_folder(), &mut streams).expect("the turn is recorded");
    let messages = conversation.messages();
    assert_eq!(messages[0].role(), "system");
    assert_eq!(messages[1].content(), "hi", "the prepared line is the turn's first message");
    messages[2..].iter().map(reduced).collect()
}

/// A message as the tests can hold it: the roles, the content, the call ids, and the calls' ids.
fn reduced(message: &Message) -> Message {
    let calls: Vec<ToolCall> = message
        .tool_calls()
        .iter()
        .map(|call| ToolCall { id: call.id.clone(), name: call.name.clone(), arguments: HashMap::new() })
        .collect();
    match message.role() {
        "user" => Message::User(message.content().to_string()),
        "tool" => Message::Tool {
            call_id: message.tool_call_id().unwrap_or_default().to_string(),
            content: message.content().to_string(),
        },
        _ => Message::Assistant { content: message.content().to_string(), tool_calls: calls },
    }
}

#[test]
fn a_stopped_turn_does_not_end_the_run() {
    let fake = Fake::new(Behavior::Interrupted);
    let mut conversation = conversation();
    run_with("hi\nnext\n/exit\nafter\n", &fake, &mut conversation);
    assert_eq!(*fake.inputs.borrow(), vec!["hi", "next"], "the run goes on with the next line");
}

#[test]
fn a_stopped_turn_runs_no_after_turn_lines() {
    let fake = Fake::new(Behavior::Interrupted);
    let mut conversation = conversation();
    conversation.set_after_turn(vec!["Write-Output x".into()]);
    run_with("hi\n", &fake, &mut conversation);
    assert_eq!(fake.inputs.borrow().len(), 1, "a stopped turn starts no follow-up");
}

#[test]
fn a_stopped_turn_is_autosaved() {
    let folder = std::env::temp_dir().join(format!("vise-interrupted-{}", std::process::id()));
    let fake = Fake::new(Behavior::Interrupted);
    let mut conversation = conversation();
    conversation.enable_autosave();
    run_in("hi\n", &fake, &mut conversation, &folder);
    let names = saved_sessions::list(&folder).expect("the sessions are listed");
    std::fs::remove_dir_all(&folder).expect("the test folder is removed");
    assert_eq!(names.len(), 1, "the partial turn is on disk");
}

#[test]
fn a_stopped_turn_keeps_the_timings_of_the_rounds_that_finished() {
    let fake = Fake::new(Behavior::Interrupted);
    let mut conversation = conversation();
    run_with("hi\n", &fake, &mut conversation);
    let requests = conversation.requests();
    assert_eq!(requests.len(), 1, "the request that was sent is in the log");
    assert_eq!(requests[0].timings.prompt_ms, Some(12.5));
    assert_eq!(requests[0].prompt_tokens, 41);
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

#[test]
fn before_turn_output_goes_with_each_turn_message() {
    let fake = Fake::new(Behavior::Reply);
    let mut conversation = conversation();
    conversation.set_before_turn(vec!["Write-Output x".into()]);
    let (_, errors) = run_with("hi\n", &fake, &mut conversation);
    let inputs = fake.inputs.borrow();
    assert!(inputs[0].starts_with("Before-turn command: Write-Output x") && inputs[0].ends_with("hi"));
    assert!(errors.contains("error: before-turn command failed"));
}

#[test]
fn before_turn_lines_run_before_every_turn() {
    let fake = Fake::new(Behavior::Reply);
    let mut conversation = conversation();
    conversation.set_before_turn(vec!["Write-Output x".into()]);
    run_with("first\nsecond\n", &fake, &mut conversation);
    let inputs = fake.inputs.borrow();
    assert_eq!(inputs.len(), 2);
    assert!(inputs.iter().all(|input| input.starts_with("Before-turn command: Write-Output x")));
}

#[test]
fn retried_turn_runs_the_before_turn_lines_again() {
    let fake = Fake::new(Behavior::Fail);
    let mut conversation = conversation();
    conversation.set_before_turn(vec!["Write-Output x".into()]);
    run_with("hi\n", &fake, &mut conversation);
    run_with("hi\n", &fake, &mut conversation);
    let inputs = fake.inputs.borrow();
    assert_eq!(inputs.len(), 2);
    assert!(inputs.iter().all(|input| input.starts_with("Before-turn command: Write-Output x")));
}

#[test]
fn startup_output_goes_with_the_first_message_only() {
    let fake = Fake::new(Behavior::Reply);
    let mut conversation = conversation();
    conversation.set_startup("Startup command: x\nout".into());
    run_with("hi\nagain\n", &fake, &mut conversation);
    let inputs = fake.inputs.borrow();
    assert!(inputs[0].starts_with("Startup command: x") && inputs[0].ends_with("hi"));
    assert_eq!(inputs[1], "again");
}

#[test]
fn save_is_written_without_a_prompt() {
    let folder = sessions_folder();
    let _ = std::fs::remove_dir_all(&folder);
    let fake = Fake::new(Behavior::Reply);
    let mut conversation = conversation();
    let (output, _) = run_with("/save no-prompt
", &fake, &mut conversation);
    let stored = saved_sessions::exists(&folder, "no-prompt");
    std::fs::remove_dir_all(&folder).expect("the test folder is removed");
    assert!(!output.contains("apply this change"), "{output:?}");
    assert!(output.contains("session no-prompt saved"), "{output:?}");
    assert!(stored.unwrap_or(false));
}

#[test]
fn completed_turn_is_autosaved_to_a_session_named_from_its_input() {
    let folder = std::env::temp_dir().join(format!("vise-autosave-{}", std::process::id()));
    let fake = Fake::new(Behavior::Reply);
    let mut conversation = conversation();
    conversation.enable_autosave();
    run_in("first\n", &fake, &mut conversation, &folder);
    let files: Vec<String> = std::fs::read_dir(&folder)
        .expect("autosave folder exists")
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    let names = saved_sessions::list(&folder).expect("the sessions are listed");
    std::fs::remove_dir_all(&folder).expect("the test folder is removed");
    assert_eq!(files, vec![saved_sessions::DATABASE.to_string()]);
    assert_eq!(names.len(), 1, "the run's first turn is the only saved session");
    assert!(names[0].starts_with("first-"));
}

#[test]
fn failed_autosave_reports_an_error_and_keeps_the_turn() {
    let path = std::env::temp_dir().join(format!("vise-autosave-file-{}", std::process::id()));
    std::fs::write(&path, "not a folder").expect("the test file is written");
    let fake = Fake::new(Behavior::Reply);
    let mut conversation = conversation();
    conversation.enable_autosave();
    let (output, errors) = run_in("first\n", &fake, &mut conversation, &path);
    std::fs::remove_file(&path).expect("the test file is removed");
    assert!(errors.contains("error: cannot use the sessions folder"));
    assert!(output.contains("reply"));
    assert_eq!(conversation.messages().len(), 3);
}

/// Reports every command as failing with exit code 1.
struct Failing;

impl ToolRunner for Failing {
    fn notes_folder(&self) -> PathBuf {
        std::env::temp_dir().join("vise-no-notes")
    }

    fn run(&self, _invocation: &Invocation, _approve: &mut dyn FnMut(&str) -> bool) -> Result<String, ToolError> {
        Ok("exit code: 1\nboom".into())
    }
}

#[test]
fn failing_after_turn_command_is_sent_to_the_model_up_to_the_limit() {
    let fake = Fake::new(Behavior::Reply);
    let mut conversation = conversation();
    conversation.set_after_turn(vec!["Write-Output x".into()]);
    let mut errors = Vec::new();
    run(&mut "hi\n".as_bytes(), &mut Vec::new(), &mut errors, &fake, &Failing, &mut conversation, &sessions_folder()).unwrap();
    let inputs = fake.inputs.borrow();
    assert_eq!(inputs.len(), 1 + after_turn::FOLLOW_UPS);
    assert!(inputs[1].starts_with("After-turn command failed: Write-Output x"));
    assert!(String::from_utf8(errors).unwrap().contains("still fails after 5 follow-up turns"));
}

#[test]
fn follow_up_that_overflows_ends_the_chain() {
    let fake = Fake::new(Behavior::ReplyThenFull);
    let mut conversation = conversation();
    conversation.set_after_turn(vec!["Write-Output x".into()]);
    let mut output = Vec::new();
    let mut errors = Vec::new();
    run(&mut "hi\n".as_bytes(), &mut output, &mut errors, &fake, &Failing, &mut conversation, &sessions_folder()).unwrap();
    let output = String::from_utf8(output).unwrap();
    assert_eq!(output.matches("after-turn: Write-Output x").count(), 1);
    assert!(String::from_utf8(errors).unwrap().contains("no longer fits"));
    assert_eq!(fake.inputs.borrow().len(), 3);
}

/// Reports every command as still running in the background.
struct Backgrounded;

impl ToolRunner for Backgrounded {
    fn notes_folder(&self) -> PathBuf {
        std::env::temp_dir().join("vise-no-notes")
    }

    fn run(&self, _invocation: &Invocation, _approve: &mut dyn FnMut(&str) -> bool) -> Result<String, ToolError> {
        Ok("background task 1 is still running.\n".into())
    }
}

#[test]
fn background_command_does_not_start_a_follow_up() {
    let fake = Fake::new(Behavior::Reply);
    let mut conversation = conversation();
    conversation.set_after_turn(vec!["Write-Output x".into()]);
    run(&mut "hi\n".as_bytes(), &mut Vec::new(), &mut Vec::new(), &fake, &Backgrounded, &mut conversation, &sessions_folder()).unwrap();
    assert_eq!(fake.inputs.borrow().len(), 1);
}

#[test]
fn follow_ups_autosave_to_the_same_session_as_the_typed_turn() {
    let folder = std::env::temp_dir().join(format!("vise-follow-up-{}", std::process::id()));
    let fake = Fake::new(Behavior::Reply);
    let mut conversation = conversation();
    conversation.enable_autosave();
    conversation.set_after_turn(vec!["Write-Output x".into()]);
    run(&mut "hi\n".as_bytes(), &mut Vec::new(), &mut Vec::new(), &fake, &Failing, &mut conversation, &folder).unwrap();
    let files = std::fs::read_dir(&folder).expect("autosave folder exists").count();
    std::fs::remove_dir_all(&folder).expect("the test folder is removed");
    assert_eq!(files, 1);
}

#[test]
fn profile_before_turn_hook_runs_after_the_global_lines() {
    let fake = Fake::new(Behavior::Reply);
    let mut conversation = conversation();
    conversation.set_before_turn(vec!["Write-Output global".into()]);
    conversation.set_profile_hooks(HookLines { before_turn: vec!["Write-Output profile".into()], ..HookLines::default() });
    run_with("hi\n", &fake, &mut conversation);
    let inputs = fake.inputs.borrow();
    let text = &inputs[0];
    let global = text.find("Before-turn command: Write-Output global").expect("the global line ran");
    let profile = text.find("Before-turn command: Write-Output profile").expect("the profile line ran");
    assert!(global < profile);
}

#[test]
fn selecting_hooks_runs_the_startup_hook_into_the_next_message() {
    let mut conversation = conversation();
    let hooks = HookLines { startup: vec!["Write-Output x".into()], ..HookLines::default() };
    select_hooks(hooks, &mut conversation, &NoTools, &mut Vec::new(), &mut Vec::new()).unwrap();
    let startup = conversation.startup().expect("the startup output is held");
    assert!(startup.starts_with("Startup command: Write-Output x"));
}

/// Accepts every model switch, so a test can reach the save of the default.
struct Switching;

impl Provider for Switching {
    fn complete(
        &self,
        _history: &[Message],
        _input: String,
        _runner: &dyn ToolRunner,
        _approve: &mut dyn FnMut(&str) -> bool,
        _subagent: &mut SubagentRunner,
    ) -> Result<Turn, ProviderError> {
        Err(ProviderError::EmptyResponse)
    }

    fn context_size(&self) -> Result<u64, ProviderError> {
        Ok(0)
    }

    fn summarize(&self, _history: &[Message]) -> Result<(String, crate::session::RequestRecord), ProviderError> {
        Err(ProviderError::EmptyResponse)
    }

    fn set_model(&self, _name: &str) -> Result<(), ProviderError> {
        Ok(())
    }
}

#[test]
fn refused_switch_writes_nothing_to_the_default_file() {
    let before = std::fs::read_to_string("model.txt").ok();
    let fake = Fake::new(Behavior::Reply);
    let mut conversation = conversation();
    let (_, errors) = run_with("/model not-listed\n", &fake, &mut conversation);
    assert!(errors.contains("error: this provider cannot change the model"));
    assert_eq!(std::fs::read_to_string("model.txt").ok(), before);
}

#[test]
fn failed_save_after_a_switch_says_the_switch_holds() {
    std::fs::create_dir("model.txt").expect("a directory stands where the default file goes");
    let mut conversation = conversation();
    let mut errors = Vec::new();
    run(&mut "/model new\n".as_bytes(), &mut Vec::new(), &mut errors, &Switching, &NoTools, &mut conversation, &sessions_folder())
        .unwrap();
    std::fs::remove_dir("model.txt").expect("the directory is removed");
    assert!(String::from_utf8(errors).unwrap().contains("the model is now new, but it could not be saved"));
}

#[test]
fn providers_without_a_model_choice_report_it_as_unsupported() {
    let fake = Fake::new(Behavior::Reply);
    assert!(matches!(fake.models(), Err(ProviderError::Unsupported(_))));
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
        &sessions_folder(),
    );
    assert!(result.is_err());
}
