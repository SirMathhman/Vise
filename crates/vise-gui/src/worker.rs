//! The thread that owns the engine. The provider and the tool runner are not `Sync`, so they are built on this thread and never
//! leave it; the window talks to it over channels. `ChannelFrontend` is the `Frontend` the engine sees: it sends every event to
//! the window, and an approval question blocks here until the window answers.

use std::sync::mpsc::{self, Receiver, Sender};
use std::thread::{self, JoinHandle};
use vise_core::engine::{Flow, Request};
use vise_core::frontend::{Frontend, UiEvent};
use vise_core::parts::Parts;
use vise_core::stop::Stop;

/// What the worker tells the window.
#[derive(Debug, PartialEq)]
pub enum Message {
    /// Something to show.
    Event(UiEvent),
    /// A change needs a yes or no. The worker waits for `Worker::answer`.
    Approval(String),
    /// The request just sent is finished.
    Handled(Flow),
    /// The worker has ended, after its shutdown commands ran.
    Exited,
}

/// What `Worker::poll` found.
#[derive(Debug, PartialEq)]
pub enum Poll {
    Message(Message),
    /// Nothing yet.
    Empty,
    /// The worker thread is gone and every message has been read. After a clean end the last message was `Exited`; without it
    /// the thread died, such as in a panic.
    Gone,
}

/// The window's handle on the worker thread.
pub struct Worker {
    requests: Option<Sender<Request>>,
    answers: Option<Sender<bool>>,
    messages: Receiver<Message>,
    thread: Option<JoinHandle<()>>,
}

impl Worker {
    /// Starts the worker. `make_parts` runs on the new thread, so the parts it builds never cross threads. `wake` is called
    /// after every message, so the window can redraw. `stop` is the switch the engine works under; the provider in the parts
    /// should hold a clone of the same one.
    pub fn spawn(
        stop: Stop,
        resume: bool,
        wake: impl Fn() + Send + 'static,
        make_parts: impl FnOnce() -> Result<Parts, String> + Send + 'static,
    ) -> Self {
        let (request_tx, request_rx) = mpsc::channel();
        let (answer_tx, answer_rx) = mpsc::channel();
        let (message_tx, message_rx) = mpsc::channel();
        let thread = thread::spawn(move || {
            let mut ui = ChannelFrontend { messages: message_tx, answers: answer_rx, wake: Box::new(wake) };
            run(stop, resume, make_parts, request_rx, &mut ui);
            ui.send(Message::Exited);
        });
        Self { requests: Some(request_tx), answers: Some(answer_tx), messages: message_rx, thread: Some(thread) }
    }

    /// Sends a request. False means the worker is gone.
    pub fn send(&self, request: Request) -> bool {
        self.requests.as_ref().is_some_and(|requests| requests.send(request).is_ok())
    }

    /// Answers the approval question the worker is waiting on.
    pub fn answer(&self, accepted: bool) {
        if let Some(answers) = &self.answers {
            let _ = answers.send(accepted);
        }
    }

    /// The next message, if one has arrived.
    pub fn poll(&self) -> Poll {
        match self.messages.try_recv() {
            Ok(message) => Poll::Message(message),
            Err(mpsc::TryRecvError::Empty) => Poll::Empty,
            Err(mpsc::TryRecvError::Disconnected) => Poll::Gone,
        }
    }

    /// Waits for the next message. `None` when the worker has gone.
    #[cfg(test)]
    pub fn wait(&self) -> Option<Message> {
        self.messages.recv_timeout(std::time::Duration::from_secs(10)).ok()
    }

    /// Ends the run: the worker finishes the request it is on (a question waiting for an answer is answered no), runs the
    /// shutdown commands, and stops.
    pub fn close(&mut self) {
        self.requests = None;
        self.answers = None;
    }

    /// Waits for the worker thread to end. Call `close` first.
    pub fn join(&mut self) {
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// The worker's body: build the parts, start the engine, handle requests until the window closes the channel, shut down.
fn run(
    stop: Stop,
    resume: bool,
    make_parts: impl FnOnce() -> Result<Parts, String>,
    requests: Receiver<Request>,
    ui: &mut ChannelFrontend,
) {
    let mut parts = match make_parts() {
        Ok(parts) => parts,
        Err(err) => return ui.error(err),
    };
    let cwd = parts.cwd.clone();
    let mut engine = parts.engine(stop);
    engine.start(&cwd, resume, ui);
    for request in requests {
        let flow = engine.handle(request, ui);
        ui.send(Message::Handled(flow));
        if flow == Flow::Exit {
            break;
        }
    }
    engine.shutdown(&cwd, ui);
}

/// The frontend the engine sees on the worker thread.
struct ChannelFrontend {
    messages: Sender<Message>,
    answers: Receiver<bool>,
    wake: Box<dyn Fn() + Send>,
}

impl ChannelFrontend {
    fn send(&mut self, message: Message) -> bool {
        let sent = self.messages.send(message).is_ok();
        (self.wake)();
        sent
    }
}

impl Frontend for ChannelFrontend {
    fn emit(&mut self, event: UiEvent) {
        self.send(Message::Event(event));
    }

    fn approve(&mut self, change: &str) -> bool {
        // A window that is gone, or one that answers nothing, declines.
        self.send(Message::Approval(change.to_string())) && self.answers.recv().unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use vise_core::command::Command;
    use vise_core::environment::Environment;
    use vise_core::error::ProviderError;
    use vise_core::provider::types::{Event, Provider, SubagentRunner};
    use vise_core::session::{Conversation, Message as ChatMessage, RequestRecord, Turn};
    use vise_core::tools::types::{Invocation, ToolError, ToolRunner};

    /// A model that streams "hello", and asks one question first when `asks`.
    struct Scripted {
        asks: bool,
    }

    impl Provider for Scripted {
        fn complete(
            &self,
            _history: &[ChatMessage],
            input: String,
            _runner: &dyn ToolRunner,
            approve: &mut dyn FnMut(&str) -> bool,
            _subagent: &mut SubagentRunner,
        ) -> Result<Turn, ProviderError> {
            let allowed = if self.asks { approve("create file x") } else { true };
            let reply = if allowed { "hello" } else { "declined" };
            Turn::new(vec![
                ChatMessage::User(input),
                ChatMessage::Assistant { content: reply.into(), tool_calls: Vec::new() },
            ])
            .map_err(ProviderError::Session)
        }

        fn complete_streaming(
            &self,
            history: &[ChatMessage],
            input: String,
            runner: &dyn ToolRunner,
            approve: &mut dyn FnMut(&str) -> bool,
            subagent: &mut SubagentRunner,
            on_event: &mut dyn FnMut(Event),
        ) -> Result<Turn, ProviderError> {
            on_event(Event::Answer("hel".into()));
            on_event(Event::Answer("lo".into()));
            self.complete(history, input, runner, approve, subagent)
        }

        fn context_size(&self) -> Result<u64, ProviderError> {
            Ok(0)
        }

        fn summarize(&self, _history: &[ChatMessage]) -> Result<(String, RequestRecord), ProviderError> {
            Err(ProviderError::EmptyResponse)
        }
    }

    struct NoTools(PathBuf);

    impl ToolRunner for NoTools {
        fn run(&self, _invocation: &Invocation, _approve: &mut dyn FnMut(&str) -> bool) -> Result<String, ToolError> {
            Err(ToolError::Failed("no tools here".into()))
        }

        fn notes_folder(&self) -> PathBuf {
            self.0.join("notes")
        }
    }

    /// Scripted parts in a fresh temporary directory, so nothing is read from or written to the real one.
    fn parts(tag: &str, asks: bool) -> Result<Parts, String> {
        let cwd = std::env::temp_dir().join(format!("vise-gui-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&cwd);
        std::fs::create_dir_all(&cwd).map_err(|err| err.to_string())?;
        let conversation = Conversation::new(&Environment { cwd: cwd.clone() });
        Ok(Parts {
            provider: Box::new(Scripted { asks }),
            tools: Box::new(NoTools(cwd.clone())),
            conversation,
            sessions: cwd.join("sessions"),
            cwd,
        })
    }

    /// Collects messages until the request is handled.
    fn until_handled(worker: &Worker, answer: Option<bool>) -> Vec<Message> {
        let mut seen = Vec::new();
        while let Some(message) = worker.wait() {
            let done = matches!(message, Message::Handled(_));
            if matches!(message, Message::Approval(_)) {
                worker.answer(answer.unwrap_or(false));
            }
            seen.push(message);
            if done {
                break;
            }
        }
        seen
    }

    /// Every message waiting.
    fn drained(worker: &Worker) -> Vec<Message> {
        std::iter::from_fn(|| match worker.poll() {
            Poll::Message(message) => Some(message),
            Poll::Empty | Poll::Gone => None,
        })
        .collect()
    }

    fn started(tag: &'static str, asks: bool) -> Worker {
        Worker::spawn(Stop::new(), false, || {}, move || parts(tag, asks))
    }

    #[test]
    fn a_chat_line_streams_events_and_is_handled() {
        let mut worker = started("chat", false);
        assert!(worker.send(Request::Chat("hi".into())));
        let seen = until_handled(&worker, None);
        let answers = seen.iter().filter(|m| matches!(m, Message::Event(UiEvent::Stream { .. }))).count();
        assert_eq!(answers, 2, "{seen:?}");
        assert!(seen.contains(&Message::Event(UiEvent::TurnEnded)));
        assert_eq!(seen.last(), Some(&Message::Handled(Flow::Continue)));
        worker.close();
        worker.join();
    }

    #[test]
    fn an_approval_question_waits_for_the_answer() {
        let mut worker = started("approve", true);
        worker.send(Request::Chat("hi".into()));
        let seen = until_handled(&worker, Some(true));
        assert!(seen.contains(&Message::Approval("create file x".into())), "{seen:?}");
        worker.close();
        worker.join();
    }

    #[test]
    fn closing_the_window_answers_a_waiting_question_no_and_the_worker_ends() {
        let mut worker = started("closed", true);
        worker.send(Request::Chat("hi".into()));
        loop {
            match worker.wait() {
                Some(Message::Approval(_)) => break,
                Some(_) => {}
                None => panic!("the question never came"),
            }
        }
        worker.close();
        worker.join();
        let rest = drained(&worker);
        assert_eq!(rest.last(), Some(&Message::Exited), "{rest:?}");
    }

    #[test]
    fn exit_is_handled_and_ends_the_worker() {
        let mut worker = started("exit", false);
        worker.send(Request::Command(Command::Exit));
        let seen = until_handled(&worker, None);
        assert_eq!(seen.last(), Some(&Message::Handled(Flow::Exit)));
        worker.close();
        worker.join();
        assert_eq!(drained(&worker).pop(), Some(Message::Exited));
    }

    #[test]
    fn parts_that_cannot_be_built_are_reported() {
        let mut worker = Worker::spawn(Stop::new(), false, || {}, || Err("no instructions".to_string()));
        let first = worker.wait();
        assert_eq!(first, Some(Message::Event(UiEvent::Error("no instructions".into()))));
        assert_eq!(worker.wait(), Some(Message::Exited));
        worker.close();
        worker.join();
    }
}
