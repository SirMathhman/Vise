//! Ctrl+C. The handler never ends the process on its own: it raises a flag, and the code that can be stopped decides.
//! A turn, a request, or a tool runs inside `work`, so the first Ctrl+C asks that work to stop. Anywhere else, or
//! after a stop is already asked for, Ctrl+C quits.

use std::fmt;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

/// Whether a stop was asked for, and how many nested pieces of work a stop can reach are running.
static ASKED: AtomicBool = AtomicBool::new(false);
static WORKING: AtomicUsize = AtomicUsize::new(0);

/// A stop was asked for. Work that returns it stops early; the caller decides what to keep.
#[derive(Debug, PartialEq, Eq)]
pub struct Interrupted;

impl fmt::Display for Interrupted {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        write!(f, "interrupted")
    }
}

impl std::error::Error for Interrupted {}

/// What one press of Ctrl+C does.
#[derive(Debug, PartialEq, Eq)]
enum Press {
    /// Work is running and no stop was asked for yet: ask it to stop.
    Stop,
    /// Nothing a stop can reach, or a stop is already pending: end the process.
    Quit,
}

/// Installs the Ctrl+C handler. With work running, the first press only asks it to stop; every other press quits.
pub fn install() -> Result<(), ctrlc::Error> {
    ctrlc::set_handler(|| match press() {
        Press::Stop => eprintln!("\ninterrupting; press Ctrl+C again to quit"),
        Press::Quit => std::process::exit(130),
    })
}

/// Decides a press, and records a stop. Kept apart from `install` so the deciding can be tested without a console.
fn press() -> Press {
    if running() && !ASKED.swap(true, Ordering::SeqCst) { Press::Stop } else { Press::Quit }
}

/// Whether any work a stop can reach is running.
fn running() -> bool {
    WORKING.load(Ordering::SeqCst) > 0
}

/// Runs `body` as work that a Ctrl+C stops, and returns `Interrupted` if a stop was asked for, whether `body` noticed
/// it or not. `body` can call `asked` as it goes, to stop early. Work nests: a tool inside a turn keeps the turn
/// stoppable.
pub fn work<T>(body: impl FnOnce() -> T) -> Result<T, Interrupted> {
    WORKING.fetch_add(1, Ordering::SeqCst);
    let result = body();
    WORKING.fetch_sub(1, Ordering::SeqCst);
    if ASKED.load(Ordering::SeqCst) { Err(Interrupted) } else { Ok(result) }
}

/// Whether a stop was asked for. A request reads this between the chunks of a reply.
pub fn asked() -> bool {
    ASKED.load(Ordering::SeqCst)
}

/// Forgets a stop that has been handled, so the next turn runs normally.
pub fn clear() {
    ASKED.store(false, Ordering::SeqCst);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// The flags are global, so the tests here take turns.
    static GATE: Mutex<()> = Mutex::new(());

    /// Puts both flags back, so one test cannot see another's stop.
    fn reset() {
        ASKED.store(false, Ordering::SeqCst);
        WORKING.store(0, Ordering::SeqCst);
    }

    #[test]
    fn work_returns_its_value_when_nothing_asks_it_to_stop() {
        let _gate = GATE.lock().unwrap_or_else(|e| e.into_inner());
        reset();
        assert_eq!(work(|| 7).expect("not interrupted"), 7);
    }

    #[test]
    fn work_reports_interrupted_when_a_press_arrives_during_it() {
        let _gate = GATE.lock().unwrap_or_else(|e| e.into_inner());
        reset();
        let result = work(|| {
            assert_eq!(press(), Press::Stop);
            7
        });
        reset();
        assert_eq!(result.err(), Some(Interrupted));
    }

    #[test]
    fn a_press_with_no_work_running_quits() {
        let _gate = GATE.lock().unwrap_or_else(|e| e.into_inner());
        reset();
        assert_eq!(press(), Press::Quit);
    }

    #[test]
    fn a_second_press_quits() {
        let _gate = GATE.lock().unwrap_or_else(|e| e.into_inner());
        reset();
        let presses = work(|| (press(), press())).err();
        reset();
        assert_eq!(presses, Some(Interrupted), "the stop ends the work; the second press asked to quit");
    }

    #[test]
    fn a_press_after_the_work_ended_quits() {
        let _gate = GATE.lock().unwrap_or_else(|e| e.into_inner());
        reset();
        let pressed = work(|| press());
        reset();
        assert_eq!(pressed.err(), Some(Interrupted));
        assert_eq!(press(), Press::Quit, "no work is running any more");
    }

    #[test]
    fn work_reports_interrupted_even_when_the_body_did_not_notice() {
        let _gate = GATE.lock().unwrap_or_else(|e| e.into_inner());
        reset();
        let result = work(|| {
            ASKED.store(true, Ordering::SeqCst);
        });
        reset();
        assert!(result.is_err());
    }

    #[test]
    fn work_is_marked_as_running_only_while_it_runs() {
        let _gate = GATE.lock().unwrap_or_else(|e| e.into_inner());
        reset();
        let marked = work(|| running()).expect("not interrupted");
        reset();
        assert!(marked, "the press is caught while the body runs");
        assert!(!running(), "and not after it");
    }

    #[test]
    fn nested_work_keeps_the_outer_work_running() {
        let _gate = GATE.lock().unwrap_or_else(|e| e.into_inner());
        reset();
        let marked = work(|| work(|| ()).map(|()| running())).expect("not interrupted");
        reset();
        assert_eq!(marked, Ok(true), "a tool's own work does not end the turn's");
        assert!(!running());
    }

    #[test]
    fn clear_forgets_an_asked_stop() {
        let _gate = GATE.lock().unwrap_or_else(|e| e.into_inner());
        reset();
        ASKED.store(true, Ordering::SeqCst);
        clear();
        assert!(!asked());
    }
}
