//! Approval of the model's edits. A tool that changes files or notes runs, and then the user keeps or undoes it. The REPL
//! asks on the terminal; a web tab asks in its chat, and the answer comes back as a request to the server while the turn
//! waits. Taking the edit back is done by the caller, from the verdict.

use std::collections::{BTreeMap, BTreeSet};
use std::io;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Condvar, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use crate::chunk::Chunk;

/// The text a tool returns in place of an edit the user denied.
pub const DENIED: &str = "error: the user denied this edit, so it was undone";

/// How often a waiting browser request checks whether its turn was stopped.
const POLL: Duration = Duration::from_millis(100);

/// What the user answered for one edit.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Answer {
    Allow,
    /// Allow this edit, and every later edit with the same tool in this conversation.
    AllowAlways,
    Deny,
    /// The turn was stopped while the answer was pending, or the input ended.
    Stop,
}

/// Where the answers come from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    Terminal,
    Browser,
}

/// The approval state of one session: the tools allowed for the conversation, and the browser requests waiting for an
/// answer. A subagent shares its parent's, so the user answers for the whole turn.
pub struct Approvals {
    source: Source,
    always: Mutex<BTreeSet<String>>,
    /// Each request id is `None` while it waits for an answer, and `Some` once answered.
    pending: Mutex<BTreeMap<u64, Option<Answer>>>,
    answered: Condvar,
    next_id: AtomicU64,
}

impl Approvals {
    pub fn new(source: Source) -> Self {
        Self {
            source,
            always: Mutex::default(),
            pending: Mutex::default(),
            answered: Condvar::new(),
            next_id: AtomicU64::new(1),
        }
    }

    pub fn is_always(&self, name: &str) -> bool {
        lock(&self.always).contains(name)
    }

    pub fn allow_always(&self, name: &str) {
        lock(&self.always).insert(name.to_owned());
    }

    /// Forgets the tools allowed for the conversation. A new conversation starts with none allowed.
    pub fn clear_always(&self) {
        lock(&self.always).clear();
    }

    /// Starts a request and returns its id. Only a browser request waits in the table; a terminal one is answered by
    /// reading input at once.
    pub fn open(&self) -> u64 {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        if self.source == Source::Browser {
            lock(&self.pending).insert(id, None);
        }
        id
    }

    /// Records the browser's answer to request `id`. Returns `false` when no request with that id is waiting, so a
    /// late or repeated answer is refused.
    pub fn answer(&self, id: u64, answer: Answer) -> bool {
        let mut pending = lock(&self.pending);
        match pending.get_mut(&id) {
            Some(slot) if slot.is_none() => {
                *slot = Some(answer);
                self.answered.notify_all();
                true
            }
            _ => false,
        }
    }

    /// Waits for the answer to request `id`. A stopped turn, or a browser request that never gets an answer before the
    /// turn is stopped, gives `Answer::Stop`.
    fn wait(&self, id: u64, cancel: &AtomicBool) -> Answer {
        match self.source {
            Source::Terminal => read_terminal(cancel),
            Source::Browser => self.wait_browser(id, cancel),
        }
    }

    fn wait_browser(&self, id: u64, cancel: &AtomicBool) -> Answer {
        let mut pending = lock(&self.pending);
        loop {
            if let Some(&Some(answer)) = pending.get(&id) {
                pending.remove(&id);
                return answer;
            }
            if cancel.load(Ordering::Relaxed) {
                pending.remove(&id);
                return Answer::Stop;
            }
            pending = self.answered.wait_timeout(pending, POLL).unwrap_or_else(PoisonError::into_inner).0;
        }
    }
}

impl Default for Approvals {
    fn default() -> Self {
        Self::new(Source::Terminal)
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    // A panic cannot leave these sets half-updated, so a poisoned lock is still safe to use.
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Reads the terminal's answer. End of input, or a stop during the read, counts as a stop.
fn read_terminal(cancel: &AtomicBool) -> Answer {
    let mut line = String::new();
    match io::stdin().read_line(&mut line) {
        Ok(read) if read > 0 && !cancel.load(Ordering::Relaxed) => parse_terminal(&line),
        _ => Answer::Stop,
    }
}

/// `y` allows the edit and `a` allows the tool for the conversation. Anything else, including an empty line, denies it.
fn parse_terminal(line: &str) -> Answer {
    match line.trim() {
        "y" | "yes" => Answer::Allow,
        "a" | "always" => Answer::AllowAlways,
        _ => Answer::Deny,
    }
}

/// Whether a tool call may run.
#[derive(Debug, PartialEq, Eq)]
pub enum Verdict {
    Run,
    Denied,
    Stopped,
}

/// Asks the user to keep or undo an edit that has already run, and waits for the answer. `result` is what the edit
/// reported, so the user sees its effect. `on_chunk` gets the request. An answer of `AllowAlways` also allows the tool
/// for the rest of the conversation.
pub fn ask(
    approvals: &Approvals,
    name: &str,
    arguments: &str,
    result: &str,
    cancel: &AtomicBool,
    on_chunk: &mut dyn FnMut(Chunk),
) -> Verdict {
    let id = approvals.open();
    on_chunk(Chunk::Approval { id, name, arguments, result });
    match approvals.wait(id, cancel) {
        Answer::Allow => Verdict::Run,
        Answer::AllowAlways => {
            approvals.allow_always(name);
            Verdict::Run
        }
        Answer::Deny => Verdict::Denied,
        Answer::Stop => Verdict::Stopped,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_terminal_answers_yes_always_or_no() {
        assert_eq!(parse_terminal("y\n"), Answer::Allow);
        assert_eq!(parse_terminal("a\n"), Answer::AllowAlways);
        assert_eq!(parse_terminal("\n"), Answer::Deny);
        assert_eq!(parse_terminal("no\n"), Answer::Deny);
    }

    #[test]
    fn a_browser_answer_is_returned_to_the_waiting_turn() {
        let approvals = Approvals::new(Source::Browser);
        let cancel = AtomicBool::new(false);
        let id = approvals.open();

        assert!(approvals.answer(id, Answer::Allow));
        assert_eq!(approvals.wait(id, &cancel), Answer::Allow);
        assert!(!approvals.answer(id, Answer::Deny));
    }

    #[test]
    fn a_stopped_turn_ends_a_browser_request_that_has_no_answer() {
        let approvals = Approvals::new(Source::Browser);
        let cancel = AtomicBool::new(true);
        let id = approvals.open();

        assert_eq!(approvals.wait(id, &cancel), Answer::Stop);
        assert!(!approvals.answer(id, Answer::Allow));
    }

    #[test]
    fn clearing_the_conversation_forgets_the_allowed_tools() {
        let approvals = Approvals::new(Source::Browser);
        approvals.allow_always("create_file");
        approvals.clear_always();

        assert!(!approvals.is_always("create_file"));
    }
}
