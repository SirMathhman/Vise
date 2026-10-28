use crate::after_turn;
use crate::commands::{command, Command, HELP};
use crate::default_model;
use crate::notes;
use crate::profile;
use crate::provider::types::{Event, Provider};
use crate::render::Render;
use crate::subagent;
use crate::turn::{apply_whitelist, compact, hook_lines, prepare_message, run_turn, select_hooks, Compaction};
use crate::saved_sessions;
use crate::session::{Conversation, Message};
use crate::tools::types::{Invocation, ToolRunner};
use std::io::{self, BufRead, Write};

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

/// Runs a write the user asked for. It goes through the runner, so the user sees the same description and
/// approval a write from the model gets.
fn user_write(
    tools: &dyn ToolRunner,
    invocation: &Invocation,
    output: &mut impl Write,
    input: &mut impl BufRead,
    errors: &mut impl Write,
) -> io::Result<()> {
    let mut approve = |change: &str| ask(change, &mut *output, &mut *input);
    match tools.run(invocation, &mut approve) {
        Ok(message) => writeln!(output, "{message}"),
        Err(err) => writeln!(errors, "error: {err}"),
    }
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

/// The note commands. Writes go through the runner, so the user sees the same approval a write from the model gets.
fn note_command(
    command: Command,
    tools: &dyn ToolRunner,
    output: &mut impl Write,
    input: &mut impl BufRead,
    errors: &mut impl Write,
) -> io::Result<()> {
    match command {
        Command::ListNotes(category) => match notes::list(&category, None) {
            Ok(listed) if listed.is_empty() => writeln!(output, "no notes"),
            Ok(listed) => writeln!(output, "{}", notes::describe_list(&listed)),
            Err(err) => writeln!(errors, "error: {err}"),
        },
        Command::ShowNote(name) => match notes::read(&name) {
            Ok(note) => writeln!(output, "{}", notes::show(&note)),
            Err(err) => writeln!(errors, "error: {err}"),
        },
        Command::CreateNote(name, category) => {
            let placeholder = Invocation::CreateNote {
                name,
                summary: "placeholder".into(),
                category,
                content: String::new(),
            };
            user_write(tools, &placeholder, output, input, errors)
        }
        Command::DeleteNote(name) => user_write(tools, &Invocation::DeleteNote { name }, output, input, errors),
        _ => Ok(()),
    }
}

/// Saves the conversation as a session once the user approves it, the same approval a model write gets. A name
/// that is taken or invalid is refused before the user is asked.
fn save_session(
    name: &str,
    conversation: &Conversation,
    output: &mut impl Write,
    input: &mut impl BufRead,
    errors: &mut impl Write,
) -> io::Result<()> {
    if let Err(err) = saved_sessions::check_save(name) {
        return writeln!(errors, "error: {err}");
    }
    let history = conversation.history();
    let change = format!("save session {name} ({} messages) to sessions/{name}.json", history.len());
    if !ask(&change, output, input) {
        return writeln!(output, "session {name} not saved");
    }
    match saved_sessions::save(name, history) {
        Ok(()) => writeln!(output, "session {name} saved"),
        Err(err) => writeln!(errors, "error: {err}"),
    }
}

/// The session commands: listing, saving, and loading the conversation.
fn session_command(
    command: Command,
    conversation: &mut Conversation,
    output: &mut impl Write,
    input: &mut impl BufRead,
    errors: &mut impl Write,
) -> io::Result<()> {
    match command {
        Command::Sessions => match saved_sessions::names() {
            Ok(names) if names.is_empty() => writeln!(output, "no sessions: /save NAME stores the conversation"),
            Ok(names) => writeln!(output, "{}", names.join("\n")),
            Err(err) => writeln!(errors, "error: {err}"),
        },
        Command::Save(name) => save_session(&name, conversation, output, input, errors),
        Command::Load(name) => match saved_sessions::load(&name) {
            Ok(history) => {
                conversation.replace_history(history);
                writeln!(output, "session {name} loaded")
            }
            Err(err) => writeln!(errors, "error: {err}"),
        },
        _ => Ok(()),
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
    // The profile chosen with `/profile NAME`. Its text is sent again whenever the history does not carry it.
    let mut profile: Option<String> = None;
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
            Some(Command::Profiles) => match profile::names() {
                Ok(names) if names.is_empty() => writeln!(output, "no profiles: add .txt files to the profiles folder")?,
                Ok(names) => writeln!(output, "{}", names.join("\n"))?,
                Err(err) => writeln!(errors, "error: {err}")?,
            },
            Some(command @ (Command::ListNotes(_) | Command::ShowNote(_) | Command::CreateNote(..) | Command::DeleteNote(_))) => {
                note_command(command, tools, output, input, errors)?
            }
            Some(command @ (Command::Sessions | Command::Save(_) | Command::Load(_))) => {
                session_command(command, conversation, output, input, errors)?
            }
            Some(Command::Profile(name)) => match profile::load(&name) {
                Ok(loaded) => match apply_whitelist(tools, loaded.tools.as_deref()) {
                    Ok(changes) => {
                        for change in changes {
                            writeln!(output, "{change}")?;
                        }
                        tools.set_allowed_notes(loaded.notes);
                        profile = Some(profile::marked(&name, &loaded.instructions));
                        select_hooks(loaded.hooks, conversation, tools, output, errors)?;
                        writeln!(output, "profile {name} selected; its instructions go with your next message")?;
                    }
                    Err(err) => writeln!(errors, "error: {err}")?,
                },
                Err(err) => writeln!(errors, "error: {err}")?,
            },
            Some(Command::Models) => match provider.models() {
                Ok(ids) => {
                    let current = provider.model();
                    for id in ids {
                        let mark = if id == current { "* " } else { "  " };
                        writeln!(output, "{mark}{id}")?;
                    }
                }
                Err(err) => writeln!(errors, "error: {err}")?,
            },
            Some(Command::UseModel(name)) => match provider.set_model(&name) {
                Ok(()) => match default_model::save(&name) {
                    Ok(()) => writeln!(output, "model set to {name}, and kept as the default")?,
                    Err(err) => writeln!(errors, "error: the model is now {name}, but it could not be saved as the default: {err}")?,
                },
                Err(err) => writeln!(errors, "error: {err}")?,
            },
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
                let mut streams = Streams { input: &mut *input, output: &mut *output, errors: &mut *errors };
                chat(line, profile.as_deref(), provider, tools, conversation, &mut streams)?
            }
        }
    }
    Ok(())
}

/// The streams a chat turn writes to, and reads its approvals from.
struct Streams<'a> {
    input: &'a mut dyn BufRead,
    output: &'a mut dyn Write,
    errors: &'a mut dyn Write,
}

/// Runs a chat line as a turn. While the after-turn command fails, its failure is sent as the next message, for up to
/// `after_turn::FOLLOW_UPS` follow-up turns.
fn chat(
    line: String,
    profile: Option<&str>,
    provider: &dyn Provider,
    tools: &dyn ToolRunner,
    conversation: &mut Conversation,
    streams: &mut Streams,
) -> io::Result<()> {
    let mut pending = Some(line);
    let mut follow_ups = 0;
    while let Some(text) = pending.take() {
        pending = chat_turn(text, profile, provider, tools, conversation, streams)?;
        if pending.is_some() {
            if follow_ups == after_turn::FOLLOW_UPS {
                writeln!(
                    streams.errors,
                    "error: after-turn command still fails after {} follow-up turns",
                    after_turn::FOLLOW_UPS
                )?;
                pending = None;
            } else {
                follow_ups += 1;
            }
        }
    }
    Ok(())
}

/// Sends a line to the model as one turn: adds the before-turn, startup, profile and notes text the history does not
/// carry, runs the turn, commits it, and autosaves the history. Returns the failure text of the after-turn commands,
/// when one fails.
fn chat_turn(
    line: String,
    profile: Option<&str>,
    provider: &dyn Provider,
    tools: &dyn ToolRunner,
    conversation: &mut Conversation,
    streams: &mut Streams,
) -> io::Result<Option<String>> {
    let typed = line.clone();
    let message = prepare_message(line, profile, conversation, tools, &mut streams.output, &mut streams.errors)?;
    // The approval prompts share the output with the live display, and read their answers from the
    // same input as the lines themselves.
    let render = Render::new(&mut streams.output);
    let mut approve = |change: &str| ask(change, &mut *render.output(), &mut streams.input);
    let mut on_event = |event: Event| render.on_event(event);
    // A subagent runs with this turn's approvals and the global hook lines, which its own profile's lines follow.
    let (global_before, global_after) = (conversation.before_turn().to_vec(), conversation.after_turn().to_vec());
    let mut subagent = |name: &str, task: &str, approve: &mut dyn FnMut(&str) -> bool| {
        subagent::run(name, task, provider, tools, &global_before, &global_after, approve)
    };
    let result = run_turn(provider, conversation, message, tools, &mut approve, &mut subagent, &mut on_event);
    render.end();
    let streamed = render.streamed();
    match result {
        Ok((turn, compaction)) => {
            if let Some(Compaction::Dropped(removed)) = compaction {
                writeln!(
                    streams.output,
                    "the context was full, so the oldest turn was dropped ({removed} messages removed)"
                )?;
            }
            if !streamed {
                writeln!(streams.output, "{}", turn.reply())?;
            }
            conversation.commit(turn);
            if let Some((folder, name)) = conversation.autosave_target(&typed) {
                if let Err(err) = saved_sessions::write(&folder, &name, conversation.history()) {
                    writeln!(streams.errors, "error: {err}")?;
                }
            }
            let after_lines = hook_lines(conversation.after_turn(), &conversation.profile_hooks().after_turn);
            after_turn::run(&after_lines, tools, &mut streams.output, &mut streams.errors)
        }
        Err(err) => {
            writeln!(streams.errors, "error: {err}")?;
            Ok(None)
        }
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::types::SubagentRunner;
    use crate::session::HookLines;
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
        /// Replies to the first request and reports a full context for every later one.
        ReplyThenFull,
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

    #[test]
    fn profile_command_must_be_a_whole_word() {
        assert!(matches!(command("/profile coder"), Some(Command::Profile(name)) if name == "coder"));
        assert!(matches!(command("/profile"), Some(Command::Profiles)));
        assert!(command("/profiles").is_none());
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
    fn save_asks_for_approval_and_writes_nothing_when_declined() {
        let fake = Fake::new(Behavior::Reply);
        let mut conversation = conversation();
        let (output, _) = run_with("/save approval-test\nn\n", &fake, &mut conversation);
        assert!(output.contains("apply this change? [y/N]"));
        assert!(output.contains("session approval-test not saved"));
        assert!(!PathBuf::from("sessions/approval-test.json").exists());
    }

    #[test]
    fn completed_turn_is_autosaved_to_a_session_named_from_its_input() {
        let folder = std::env::temp_dir().join(format!("vise-autosave-{}", std::process::id()));
        let fake = Fake::new(Behavior::Reply);
        let mut conversation = conversation();
        conversation.enable_autosave(folder.clone());
        run_with("first\n", &fake, &mut conversation);
        let files: Vec<String> = std::fs::read_dir(&folder)
            .expect("autosave folder exists")
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        std::fs::remove_dir_all(&folder).expect("the test folder is removed");
        assert_eq!(files.len(), 1);
        assert!(files[0].starts_with("first-") && files[0].ends_with(".json"));
    }

    #[test]
    fn failed_autosave_reports_an_error_and_keeps_the_turn() {
        let path = std::env::temp_dir().join(format!("vise-autosave-file-{}", std::process::id()));
        std::fs::write(&path, "not a folder").expect("the test file is written");
        let fake = Fake::new(Behavior::Reply);
        let mut conversation = conversation();
        conversation.enable_autosave(path.clone());
        let (output, errors) = run_with("first\n", &fake, &mut conversation);
        std::fs::remove_file(&path).expect("the test file is removed");
        assert!(errors.contains("error: cannot use the sessions folder"));
        assert!(output.contains("reply"));
        assert_eq!(conversation.messages().len(), 3);
    }

    /// Reports every command as failing with exit code 1.
    struct Failing;

    impl ToolRunner for Failing {
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
        run(&mut "hi\n".as_bytes(), &mut Vec::new(), &mut errors, &fake, &Failing, &mut conversation).unwrap();
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
        run(&mut "hi\n".as_bytes(), &mut output, &mut errors, &fake, &Failing, &mut conversation).unwrap();
        let output = String::from_utf8(output).unwrap();
        assert_eq!(output.matches("after-turn: Write-Output x").count(), 1);
        assert!(String::from_utf8(errors).unwrap().contains("no longer fits"));
        assert_eq!(fake.inputs.borrow().len(), 3);
    }

    /// Reports every command as still running in the background.
    struct Backgrounded;

    impl ToolRunner for Backgrounded {
        fn run(&self, _invocation: &Invocation, _approve: &mut dyn FnMut(&str) -> bool) -> Result<String, ToolError> {
            Ok("background task 1 is still running.\n".into())
        }
    }

    #[test]
    fn background_command_does_not_start_a_follow_up() {
        let fake = Fake::new(Behavior::Reply);
        let mut conversation = conversation();
        conversation.set_after_turn(vec!["Write-Output x".into()]);
        run(&mut "hi\n".as_bytes(), &mut Vec::new(), &mut Vec::new(), &fake, &Backgrounded, &mut conversation).unwrap();
        assert_eq!(fake.inputs.borrow().len(), 1);
    }

    #[test]
    fn follow_ups_autosave_to_the_same_session_as_the_typed_turn() {
        let folder = std::env::temp_dir().join(format!("vise-follow-up-{}", std::process::id()));
        let fake = Fake::new(Behavior::Reply);
        let mut conversation = conversation();
        conversation.enable_autosave(folder.clone());
        conversation.set_after_turn(vec!["Write-Output x".into()]);
        run(&mut "hi\n".as_bytes(), &mut Vec::new(), &mut Vec::new(), &fake, &Failing, &mut conversation).unwrap();
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

        fn summarize(&self, _history: &[Message]) -> Result<String, ProviderError> {
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
        run(&mut "/model new\n".as_bytes(), &mut Vec::new(), &mut errors, &Switching, &NoTools, &mut conversation)
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
        );
        assert!(result.is_err());
    }
}
