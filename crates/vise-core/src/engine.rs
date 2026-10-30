//! The engine: everything a frontend can ask the backend to do, and nothing about how it is shown. A frontend sends a
//! `Request` (a line to chat about, or a command) and receives `UiEvent`s through the `Frontend` it passes in. The
//! engine borrows the provider, the tools, the conversation and the sessions folder, which the caller owns.

use crate::after_turn;
use crate::before_turn;
use crate::command::Command;
use crate::default_model;
use crate::error::ProviderError;
use crate::frontend::{Change, DropCause, Frontend, UiEvent};
use serde::{Deserialize, Serialize};
use crate::profile;
use crate::provider::types::{Event, Provider};
use crate::saved_sessions;
use crate::session::{Conversation, Message, PartialTurn, Turn};
use crate::startup;
use crate::stop::Stop;
use crate::subagent;
use crate::shutdown;
use crate::tools::types::ToolRunner;
use crate::turn::{apply_whitelist, compact, hook_lines, prepare_message, run_turn, select_hooks, Compaction};
use std::cell::{Cell, RefCell};
use std::path::Path;

mod commands;
use commands::{note_command, session_command, toggle, tool_states};

/// What a frontend asks the engine to do.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Request {
    /// A line for the model.
    Chat(String),
    /// A command. `Command::Exit` ends the run, and `Command::Help` is the frontend's own to answer.
    Command(Command),
}

/// Whether the run goes on after a request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Flow {
    Continue,
    Exit,
}

pub struct Engine<'a> {
    provider: &'a dyn Provider,
    tools: &'a dyn ToolRunner,
    conversation: &'a mut Conversation,
    /// The folder the saved sessions are kept in, for `/save`, `/load`, autosave and resuming.
    sessions: &'a Path,
    /// The text of the profile chosen with `/profile NAME`. It is sent again whenever the history does not carry it.
    profile: Option<String>,
    /// The switch a frontend flips to stop the work that is running. Every clone is the same switch.
    stop: Stop,
}

impl<'a> Engine<'a> {
    pub fn new(
        provider: &'a dyn Provider,
        tools: &'a dyn ToolRunner,
        conversation: &'a mut Conversation,
        sessions: &'a Path,
        stop: Stop,
    ) -> Self {
        Self { provider, tools, conversation, sessions, profile: None, stop }
    }

    /// The switch that stops the running work. A frontend keeps a clone, for its own Ctrl+C or stop button, and flips it
    /// from any thread. The terminal installs its handler before the engine exists, so it does not use this one.
    #[allow(dead_code)]
    pub fn stop_handle(&self) -> Stop {
        self.stop.clone()
    }

    /// Prepares the run: trusts the profiles that exist now, imports old session files, resumes the last session unless
    /// `resume` is false, applies the saved default model, and reads the command files in `cwd`. Startup commands run
    /// last, and their output goes to the model with the first message.
    pub fn start(&mut self, cwd: &Path, resume: bool, ui: &mut dyn Frontend) {
        profile::confirm_existing(self.tools, ui);
        match saved_sessions::import(self.sessions) {
            Ok(0) => {}
            Ok(imported) => ui.status(format!(
                "imported {imported} session files into {}",
                self.sessions.join(saved_sessions::DATABASE).display()
            )),
            Err(err) => ui.error(format!("cannot import the session files: {err}")),
        }
        if resume {
            self.resume_last(ui);
        }
        match default_model::load() {
            Ok(Some(name)) => {
                if let Err(err) = self.provider.set_model(&name) {
                    ui.error(format!("the saved default model is not used: {err}"));
                }
            }
            Ok(None) => {}
            Err(err) => ui.error(format!("cannot read model.txt: {err}")),
        }
        if let Some(commands) = before_turn::load(cwd, ui) {
            self.conversation.set_before_turn(commands);
        }
        if let Some(commands) = after_turn::load(cwd, ui) {
            self.conversation.set_after_turn(commands);
        }
        match self.stop.work(|| startup::run(cwd, self.tools, ui)) {
            Ok(Some(text)) => self.conversation.set_startup(text),
            Ok(None) => {}
            Err(_) => ui.status("the startup commands were stopped".to_string()),
        }
    }

    /// Continues the most recently saved session, if there is one.
    fn resume_last(&mut self, ui: &mut dyn Frontend) {
        let resumed = saved_sessions::latest(self.sessions).and_then(|name| match name {
            Some(name) => saved_sessions::resume(self.sessions, &name).map(|(history, requests)| Some((name, history, requests))),
            None => Ok(None),
        });
        match resumed {
            Ok(Some((name, history, requests))) => {
                self.conversation.resume(name.clone(), history, requests);
                ui.status(format!("resumed session {name}"));
            }
            Ok(None) => {}
            Err(err) => ui.error(format!("the last session is not resumed: {err}")),
        }
    }

    /// Ends the run: the shutdown commands run, then those of the selected profile.
    pub fn shutdown(&mut self, cwd: &Path, ui: &mut dyn Frontend) {
        // The shutdown lines run outside `work`, so a Ctrl+C during them quits at once rather than waiting them out.
        let profile_shutdown = self.conversation.profile_hooks().shutdown.clone();
        shutdown::run_with_profile(cwd, &profile_shutdown, self.tools, ui);
    }

    /// Does what the request asks. Everything the user should see goes to `ui`.
    pub fn handle(&mut self, request: Request, ui: &mut dyn Frontend) -> Flow {
        match request {
            Request::Chat(line) => {
                self.chat(line, ui);
                Flow::Continue
            }
            Request::Command(command) => self.command(command, ui),
        }
    }

    fn command(&mut self, command: Command, ui: &mut dyn Frontend) -> Flow {
        match command {
            Command::Exit => return Flow::Exit,
            Command::Help => {}
            Command::Tools => ui.emit(UiEvent::Tools(tool_states(self.tools))),
            Command::Enable(name) => toggle(self.tools, &name, true, ui),
            Command::Disable(name) => toggle(self.tools, &name, false, ui),
            Command::Profiles => self.list_profiles(ui),
            Command::Profile(name) => self.select_profile(name, ui),
            command @ (Command::ListNotes(_) | Command::ShowNote(_) | Command::CreateNote(..) | Command::DeleteNote(_)) => {
                note_command(command, self.tools, ui)
            }
            command @ (Command::Sessions | Command::Save(_) | Command::Load(_)) => {
                session_command(command, self.conversation, self.sessions, ui)
            }
            Command::Models => match self.provider.models() {
                Ok(ids) => ui.emit(UiEvent::Models { current: self.provider.model(), ids }),
                Err(err) => ui.error(err.to_string()),
            },
            Command::UseModel(name) => match self.provider.set_model(&name) {
                Ok(()) => match default_model::save(&name) {
                    Ok(()) => ui.emit(UiEvent::Changed(Change::ModelSet { name, default_saved: true })),
                    Err(err) => {
                        ui.emit(UiEvent::Changed(Change::ModelSet { name: name.clone(), default_saved: false }));
                        ui.error(format!("the model is now {name}, but it could not be saved as the default: {err}"));
                    }
                },
                Err(err) => ui.error(err.to_string()),
            },
            Command::New => {
                self.conversation.replace_history(Vec::new());
                ui.emit(UiEvent::Changed(Change::Reset));
            }
            Command::Compact => match compact(self.provider, self.conversation) {
                Ok(Compaction::Summarized) => ui.emit(UiEvent::Changed(Change::Compacted)),
                Ok(Compaction::Dropped(removed)) => {
                    ui.emit(UiEvent::Changed(Change::OldestTurnDropped { removed, cause: DropCause::SummaryDidNotFit }))
                }
                Err(err) => ui.error(err.to_string()),
            },
            Command::Context => {
                let text = self.conversation.messages().first().map_or("", Message::content).to_string();
                let prompt_tokens = self.conversation.prompt_tokens();
                let size = match self.provider.context_size() {
                    Ok(size) => Some(size),
                    Err(err) => {
                        ui.error(err.to_string());
                        None
                    }
                };
                ui.emit(UiEvent::Context { text, prompt_tokens, size });
            }
        }
        Flow::Continue
    }

    /// Lists the profiles, and the notes that could not be read.
    fn list_profiles(&mut self, ui: &mut dyn Frontend) {
        match profile::names(&self.tools.notes_folder()) {
            Ok((names, skipped)) => {
                for line in skipped {
                    ui.error(line);
                }
                ui.emit(UiEvent::Profiles(names));
            }
            Err(err) => ui.error(err),
        }
    }

    /// Makes a profile the selected one: its tools and notes apply at once, its hook lines are listed when they are new
    /// or changed, and its instructions go with the next message.
    fn select_profile(&mut self, name: String, ui: &mut dyn Frontend) {
        let loaded = match profile::load(&self.tools.notes_folder(), &name) {
            Ok(loaded) => loaded,
            Err(err) => return ui.error(err),
        };
        let tool_changes = match apply_whitelist(self.tools, loaded.tools.as_deref()) {
            Ok(changes) => changes,
            Err(err) => return ui.error(err.to_string()),
        };
        self.tools.set_allowed_notes(loaded.notes);
        let hooks = loaded.hooks.fingerprint();
        let new_hooks = if self.tools.hooks_confirmed(&name, &hooks) { Vec::new() } else { hooks.clone() };
        ui.emit(UiEvent::Changed(Change::ProfileApplied { name: name.clone(), tool_changes, new_hooks }));
        self.tools.confirm_hooks(&name, &hooks);
        self.profile = Some(profile::marked(&name, &loaded.instructions));
        select_hooks(loaded.hooks, self.conversation, self.tools, ui);
        ui.emit(UiEvent::Changed(Change::ProfileSelected { name }));
    }

    /// Runs a chat line as a turn. While the after-turn command fails, its failure is sent as the next message, for up to
    /// `after_turn::FOLLOW_UPS` follow-up turns.
    fn chat(&mut self, line: String, ui: &mut dyn Frontend) {
        let mut pending = Some(line);
        let mut follow_ups = 0;
        while let Some(text) = pending.take() {
            pending = self.chat_turn(text, ui);
            if pending.is_some() {
                if follow_ups == after_turn::FOLLOW_UPS {
                    ui.error(format!(
                        "after-turn command still fails after {} follow-up turns",
                        after_turn::FOLLOW_UPS
                    ));
                    pending = None;
                } else {
                    follow_ups += 1;
                }
            }
        }
    }

    /// Sends a line to the model as one turn: adds the before-turn, startup, profile and notes text the history does not
    /// carry, runs the turn, commits it, and autosaves the history. Returns the failure text of the after-turn commands,
    /// when one fails.
    fn chat_turn(&mut self, line: String, ui: &mut dyn Frontend) -> Option<String> {
        let typed = line.clone();
        let message = prepare_message(line, self.profile.as_deref(), self.conversation, self.tools, ui);
        let (provider, tools, stop) = (self.provider, self.tools, &self.stop);
        // A subagent runs with this turn's approvals and the global hook lines, which its own profile's lines follow. Only
        // its tool lines reach this turn's display: its answer text is discarded, so the parent's reply is the only answer.
        let (global_before, global_after) = (self.conversation.before_turn().to_vec(), self.conversation.after_turn().to_vec());
        let streamed = Cell::new(false);
        let result = {
            // The approvals, the events and the subagent's lines all go to the same frontend, one at a time.
            let shared = RefCell::new(&mut *ui);
            let mut approve = |change: &str| shared.borrow_mut().approve(change);
            let mut on_event = |event: Event| {
                if matches!(event, Event::Answer(_)) {
                    streamed.set(true);
                }
                shared.borrow_mut().emit(UiEvent::Stream { event, nested: false });
            };
            let mut subagent = |name: &str, task: &str, approve: &mut dyn FnMut(&str) -> bool| {
                let mut tools_only = |event: Event| match event {
                    Event::Tool { .. } | Event::ToolFailed(_) => {
                        shared.borrow_mut().emit(UiEvent::Stream { event, nested: true })
                    }
                    _ => {}
                };
                subagent::run(
                    name,
                    task,
                    provider,
                    tools,
                    subagent::Parent {
                        hooks: (&global_before, &global_after),
                        stop,
                        approve,
                        on_event: &mut tools_only,
                    },
                )
            };
            run_turn(provider, self.conversation, message, tools, stop, &mut approve, &mut subagent, &mut on_event)
        };
        ui.emit(UiEvent::TurnEnded);
        // The press has been handled, so the next turn runs until it is stopped again.
        self.stop.clear();
        match result {
            Ok((turn, compaction)) => {
                if let Some(Compaction::Dropped(removed)) = compaction {
                    ui.emit(UiEvent::Changed(Change::OldestTurnDropped { removed, cause: DropCause::ContextFull }));
                }
                if !streamed.get() {
                    ui.emit(UiEvent::Reply(turn.reply().to_string()));
                }
                self.conversation.commit(turn);
                self.autosave(&typed, ui);
                let after_lines = hook_lines(self.conversation.after_turn(), &self.conversation.profile_hooks().after_turn);
                after_turn::run(&after_lines, self.tools, ui)
            }
            Err(ProviderError::Interrupted { stopped }) => {
                self.interrupted(typed, stopped, ui);
                None
            }
            Err(err) => {
                ui.error(err.to_string());
                None
            }
        }
    }

    /// Writes the history to the session this run saves to.
    fn autosave(&mut self, typed: &str, ui: &mut dyn Frontend) {
        if let Some(name) = self.conversation.autosave_target(typed) {
            if let Err(err) =
                saved_sessions::write(self.sessions, &name, self.conversation.history(), self.conversation.requests())
            {
                ui.error(err.to_string());
            }
        }
    }

    /// Records a stopped turn: what it reached, which is the prepared user message, any finished tool rounds, and the
    /// reply's text, goes into the history so the user and the model can see how far it got, and the history is autosaved
    /// as after any other turn. The after-turn lines do not run, because the turn did not finish, and nothing follows it:
    /// a stopped turn is never resent on its own. The messages are checked the way every turn is, so an interrupted round
    /// that left a tool result out is refused rather than stored. `handle` calls it; it is public so a frontend's tests
    /// can check what a stop leaves behind.
    pub fn interrupted(&mut self, typed: String, stopped: PartialTurn, ui: &mut dyn Frontend) {
        let requests = stopped.requests().to_vec();
        match stopped.into_messages(MARK).and_then(Turn::new) {
            Ok(turn) => self.conversation.commit(turn.with_requests(requests)),
            Err(err) => ui.error(err.to_string()),
        }
        self.autosave(&typed, ui);
        ui.notice("the turn was stopped before it finished".to_string());
    }
}

/// The line that marks a stopped turn in the history, so a later reader knows the turn did not finish.
const MARK: &str = "[the turn was interrupted]";

#[cfg(test)]
mod tests {
    use super::*;
    use crate::environment::Environment;
    use crate::error::ProviderError;
    use crate::frontend::test_support::TextUi;
    use crate::provider::types::SubagentRunner;
    use crate::session::RequestRecord;
    use crate::tools::types::{Invocation, ToolError};
    use std::path::PathBuf;

    /// A model that answers "hello" and, when asked to, shows the answer piece by piece and asks one question first.
    struct Scripted {
        stream: bool,
        asks: bool,
    }

    impl Provider for Scripted {
        fn complete(
            &self,
            _history: &[Message],
            input: String,
            _runner: &dyn ToolRunner,
            approve: &mut dyn FnMut(&str) -> bool,
            _subagent: &mut SubagentRunner,
        ) -> Result<Turn, ProviderError> {
            if self.asks {
                approve("create file x");
            }
            Turn::new(vec![
                Message::User(input),
                Message::Assistant { content: "hello".into(), tool_calls: Vec::new() },
            ])
            .map_err(ProviderError::Session)
        }

        fn complete_streaming(
            &self,
            history: &[Message],
            input: String,
            runner: &dyn ToolRunner,
            approve: &mut dyn FnMut(&str) -> bool,
            subagent: &mut SubagentRunner,
            on_event: &mut dyn FnMut(Event),
        ) -> Result<Turn, ProviderError> {
            if self.stream {
                on_event(Event::Answer("hel".into()));
                on_event(Event::Answer("lo".into()));
            }
            self.complete(history, input, runner, approve, subagent)
        }

        fn context_size(&self) -> Result<u64, ProviderError> {
            Ok(0)
        }

        fn summarize(&self, _history: &[Message]) -> Result<(String, RequestRecord), ProviderError> {
            Err(ProviderError::EmptyResponse)
        }
    }

    struct NoTools;

    impl ToolRunner for NoTools {
        fn run(&self, _invocation: &Invocation, _approve: &mut dyn FnMut(&str) -> bool) -> Result<String, ToolError> {
            Err(ToolError::Failed("no tools here".into()))
        }

        fn notes_folder(&self) -> PathBuf {
            std::env::temp_dir().join("vise-engine-no-notes")
        }
    }

    fn conversation() -> Conversation {
        Conversation::new(&Environment { cwd: PathBuf::from("C:/work") })
    }

    #[test]
    fn a_streamed_answer_reaches_the_frontend_as_events_and_is_not_repeated_as_a_reply() {
        let (provider, mut conversation, sessions) = (Scripted { stream: true, asks: false }, conversation(), PathBuf::from("unused"));
        let mut engine = Engine::new(&provider, &NoTools, &mut conversation, &sessions, Stop::new());
        let mut ui = TextUi::new();
        let flow = engine.handle(Request::Chat("hi".into()), &mut ui);
        drop(engine);
        assert_eq!(flow, Flow::Continue);
        let answers: Vec<&UiEvent> = ui.events.iter().filter(|event| matches!(event, UiEvent::Stream { .. })).collect();
        assert_eq!(answers.len(), 2, "{:?}", ui.events);
        assert!(ui.events.contains(&UiEvent::TurnEnded));
        assert!(!ui.events.iter().any(|event| matches!(event, UiEvent::Reply(_))), "it was already shown");
        assert_eq!(conversation.messages().len(), 3, "the turn is committed");
    }

    #[test]
    fn an_answer_that_was_not_streamed_arrives_whole_as_a_reply() {
        let (provider, mut conversation, sessions) = (Scripted { stream: false, asks: false }, conversation(), PathBuf::from("unused"));
        let mut engine = Engine::new(&provider, &NoTools, &mut conversation, &sessions, Stop::new());
        let mut ui = TextUi::new();
        engine.handle(Request::Chat("hi".into()), &mut ui);
        assert!(ui.events.contains(&UiEvent::Reply("hello".into())), "{:?}", ui.events);
    }

    #[test]
    fn the_frontend_answers_the_questions_a_turn_asks() {
        let (provider, mut conversation, sessions) = (Scripted { stream: false, asks: true }, conversation(), PathBuf::from("unused"));
        let mut engine = Engine::new(&provider, &NoTools, &mut conversation, &sessions, Stop::new());
        let mut ui = TextUi::new();
        ui.answers.push_back(true);
        engine.handle(Request::Chat("hi".into()), &mut ui);
        assert_eq!(ui.asked, vec!["create file x".to_string()]);
    }

    #[test]
    fn a_command_reports_through_the_frontend_and_exit_ends_the_run() {
        let (provider, mut conversation, sessions) = (Scripted { stream: false, asks: false }, conversation(), PathBuf::from("unused"));
        let mut engine = Engine::new(&provider, &NoTools, &mut conversation, &sessions, Stop::new());
        let mut ui = TextUi::new();
        assert_eq!(engine.handle(Request::Command(Command::New), &mut ui), Flow::Continue);
        assert_eq!(ui.events, vec![UiEvent::Changed(Change::Reset)]);
        assert_eq!(engine.handle(Request::Command(Command::Exit), &mut ui), Flow::Exit);
    }

    #[test]
    fn the_engines_stop_handle_is_the_switch_it_was_given() {
        let stop = Stop::new();
        let (provider, mut conversation, sessions) = (Scripted { stream: false, asks: false }, conversation(), PathBuf::from("unused"));
        let engine = Engine::new(&provider, &NoTools, &mut conversation, &sessions, stop.clone());
        let reached = engine.stop_handle().work(|| stop.request());
        assert!(reached.is_err(), "a request on the given switch reached work run on the engine's handle");
    }

    #[test]
    fn a_query_command_sends_data_not_text() {
        let (provider, mut conversation, sessions) = (Scripted { stream: false, asks: false }, conversation(), PathBuf::from("unused"));
        let mut engine = Engine::new(&provider, &NoTools, &mut conversation, &sessions, Stop::new());
        let mut ui = TextUi::new();
        engine.handle(Request::Command(Command::Tools), &mut ui);
        engine.handle(Request::Command(Command::Context), &mut ui);
        let tools = ui.events.iter().find_map(|event| match event {
            UiEvent::Tools(tools) => Some(tools),
            _ => None,
        });
        let tools = tools.expect("the tools arrive as data");
        assert!(tools.iter().any(|tool| tool.name == "read_file" && tool.enabled));
        assert!(
            ui.events.iter().any(|event| matches!(event, UiEvent::Context { size: Some(0), prompt_tokens: 0, .. })),
            "{:?}",
            ui.events
        );
        assert!(ui.output.is_empty(), "no prose came with the data: {:?}", ui.output);
    }
}
