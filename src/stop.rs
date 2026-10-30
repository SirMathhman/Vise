//! The stop switch. A frontend asks running work to stop; the work notices, and the caller decides what to keep. A turn, a
//! request, or a tool runs inside `work`, so a request to stop reaches it. A request that arrives when no work is running,
//! or when a stop is already pending, is refused: what to do then, such as quitting, is the frontend's choice.
//!
//! The handle is cheap to clone and every clone is the same switch, so the engine, the provider and the frontend that
//! owns the Ctrl+C handler each hold one.

use std::fmt;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

/// A stop was asked for. Work that returns it stops early; the caller decides what to keep.
#[derive(Debug, PartialEq, Eq)]
pub struct Interrupted;

impl fmt::Display for Interrupted {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        write!(f, "interrupted")
    }
}

impl std::error::Error for Interrupted {}

/// Whether a stop was asked for, and how many nested pieces of work a stop can reach are running.
#[derive(Default)]
struct State {
    asked: AtomicBool,
    working: AtomicUsize,
}

#[derive(Clone, Default)]
pub struct Stop(Arc<State>);

impl Stop {
    pub fn new() -> Self {
        Self::default()
    }

    /// Asks the running work to stop. Returns whether the request was taken: false means no work was running, or a stop
    /// was already pending, and the frontend can treat that as a request to quit.
    pub fn request(&self) -> bool {
        self.running() && !self.0.asked.swap(true, Ordering::SeqCst)
    }

    /// Whether any work a stop can reach is running.
    fn running(&self) -> bool {
        self.0.working.load(Ordering::SeqCst) > 0
    }

    /// Runs `body` as work that a stop request reaches, and returns `Interrupted` if a stop was asked for, whether `body`
    /// noticed it or not. `body` can call `asked` as it goes, to stop early. Work nests: a tool inside a turn keeps the
    /// turn stoppable. A panic in `body` still ends the work, so a crash cannot leave the count too high to ever refuse.
    pub fn work<T>(&self, body: impl FnOnce() -> T) -> Result<T, Interrupted> {
        let value = self.tracked(body);
        if self.asked() { Err(Interrupted) } else { Ok(value) }
    }

    /// Runs `body` as work a stop request can reach, keeping its value: the caller decides what the stop means. Used
    /// where a stop must not throw the work away, such as a request whose own error carries the turn as it stood.
    pub fn tracked<T>(&self, body: impl FnOnce() -> T) -> T {
        /// Ends one piece of work even when `body` panics.
        struct Running<'a>(&'a State);

        impl Drop for Running<'_> {
            fn drop(&mut self) {
                self.0.working.fetch_sub(1, Ordering::SeqCst);
            }
        }

        self.0.working.fetch_add(1, Ordering::SeqCst);
        let running = Running(&self.0);
        let value = body();
        drop(running);
        value
    }

    /// Whether a stop was asked for. A request reads this between the chunks of a reply.
    pub fn asked(&self) -> bool {
        self.0.asked.load(Ordering::SeqCst)
    }

    /// Forgets a stop that has been handled, so the next turn runs normally.
    pub fn clear(&self) {
        self.0.asked.store(false, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn work_returns_its_value_when_nothing_asks_it_to_stop() {
        assert_eq!(Stop::new().work(|| 7).expect("not interrupted"), 7);
    }

    #[test]
    fn work_reports_interrupted_when_a_request_arrives_during_it() {
        let stop = Stop::new();
        let result = stop.work(|| {
            assert!(stop.request());
            7
        });
        assert_eq!(result.err(), Some(Interrupted));
    }

    #[test]
    fn a_request_with_no_work_running_is_refused() {
        assert!(!Stop::new().request());
    }

    #[test]
    fn a_second_request_is_refused() {
        let stop = Stop::new();
        let requests = stop.work(|| (stop.request(), stop.request())).err();
        assert_eq!(requests, Some(Interrupted), "the stop ends the work; the second request was refused");
        assert!(!stop.request());
    }

    #[test]
    fn a_request_after_the_work_ended_is_refused() {
        let stop = Stop::new();
        let pressed = stop.work(|| stop.request());
        assert_eq!(pressed.err(), Some(Interrupted));
        stop.clear();
        assert!(!stop.request(), "no work is running any more");
    }

    #[test]
    fn work_reports_interrupted_even_when_the_body_did_not_notice() {
        let stop = Stop::new();
        let result = stop.work(|| stop.0.asked.store(true, Ordering::SeqCst));
        assert!(result.is_err());
    }

    #[test]
    fn work_is_marked_as_running_only_while_it_runs() {
        let stop = Stop::new();
        let marked = stop.work(|| stop.running()).expect("not interrupted");
        assert!(marked, "a request is taken while the body runs");
        assert!(!stop.running(), "and not after it");
    }

    #[test]
    fn nested_work_keeps_the_outer_work_running() {
        let stop = Stop::new();
        let marked = stop.work(|| stop.work(|| ()).map(|()| stop.running())).expect("not interrupted");
        assert_eq!(marked, Ok(true), "a tool's own work does not end the turn's");
        assert!(!stop.running());
    }

    #[test]
    fn clear_forgets_an_asked_stop() {
        let stop = Stop::new();
        stop.0.asked.store(true, Ordering::SeqCst);
        stop.clear();
        assert!(!stop.asked());
    }

    #[test]
    fn a_clone_is_the_same_switch() {
        let stop = Stop::new();
        let other = stop.clone();
        stop.work(|| assert!(other.request())).expect_err("the clone's request reached the work");
    }
}
