//! The error a turn ends with. It is kept apart from `agent`, so `subagent` can name it without depending on `agent`.

use crate::strata::StrataError;


/// A turn that did not finish. Every variant lists the tool calls that ran before it (`name arguments`): their
/// effects on disk remain, even though the turn itself is not kept.
#[derive(Debug)]
pub enum TurnError {
    /// The user stopped the turn.
    Stopped { ran: Vec<String> },
    /// The turn failed for another reason.
    Failed { ran: Vec<String>, cause: StrataError },
    /// A workflow step could not run, for a reason of its own (a switched-off tool, a model that did not make its call).
    Step { ran: Vec<String>, reason: String },
}

impl TurnError {
    pub fn ran(&self) -> &[String] {
        match self {
            TurnError::Stopped { ran } | TurnError::Failed { ran, .. } | TurnError::Step { ran, .. } => ran,
        }
    }
}

impl std::fmt::Display for TurnError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TurnError::Stopped { .. } => write!(f, "Stopped."),
            TurnError::Failed { cause, .. } => write!(f, "{cause}"),
            TurnError::Step { reason, .. } => write!(f, "{reason}"),
        }
    }
}

/// Maps an error from inside a turn, keeping the calls that had run. The stream's own cancel signal is a stop.
pub fn turn_error(err: StrataError, ran: &[String]) -> TurnError {
    match err {
        StrataError::Stopped => TurnError::Stopped { ran: ran.to_vec() },
        cause => TurnError::Failed { ran: ran.to_vec(), cause },
    }
}
