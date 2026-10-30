use crate::interrupt::Interrupted;
use crate::session::Message;
use std::fmt;

pub const MAX_TOOL_ROUNDS: usize = 10;

#[derive(Debug)]
pub enum SessionError {
    MalformedTurn { index: usize },
}

impl fmt::Display for SessionError {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        match self {
            Self::MalformedTurn { index } => write!(
                f,
                "message {index} breaks the turn's shape: a user message, then each tool call followed by its result, then a reply with no tool calls"
            ),
        }
    }
}

impl std::error::Error for SessionError {}

#[derive(Debug)]
pub enum ProviderError {
    Transport(Box<dyn std::error::Error>),
    Encode(Box<dyn std::error::Error>),
    Rejected(String),
    EmptyResponse,
    /// The provider has no way to do this, such as listing models. `0` names the action.
    Unsupported(String),
    TooManyToolRounds,
    /// The configured model is not among the models the server lists. `offered` holds the ids the server lists.
    ModelMissing { expected: String, offered: Vec<String> },
    /// The server lists the configured model but gives no context size for it.
    ContextSizeUnknown { expected: String },
    ContextFull,
    ContextFullAfterChange,
    EmptySummary,
    Session(SessionError),
    /// The user pressed Ctrl+C. `reached` holds the turn as far as it got, so the callers can record it: the tool rounds
    /// that finished and the reply's text up to the press.
    Interrupted { reached: Reached },
}

/// A stopped turn as far as it got: the tool rounds that finished, in order, and the reply's text so far. The typed
/// message is not part of it, because the caller already holds it. It is a named type so the error can be debugged
/// without the payload's own `Debug`, which a `Message` does not have.
pub struct Reached {
    pub rounds: Vec<Message>,
    pub reply: String,
}

impl Reached {
    pub fn new(rounds: Vec<Message>, reply: String) -> Self {
        Self { rounds, reply }
    }
}

impl fmt::Debug for Reached {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        write!(f, "{} round(s) and {} reply byte(s) reached", self.rounds.len(), self.reply.len())
    }
}

impl fmt::Display for ProviderError {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        match self {
            Self::Transport(err) => write!(f, "request to the model failed ({err}); check that the server is running"),
            Self::Encode(err) => write!(f, "could not encode the conversation ({err})"),
            Self::Rejected(message) => write!(f, "the server rejected the request: {message}; check the request"),
            Self::EmptyResponse => write!(f, "the model returned no choices; try the message again"),
            Self::TooManyToolRounds => write!(f, "the model kept calling tools after {MAX_TOOL_ROUNDS} rounds; try a simpler request"),
            Self::ModelMissing { expected, offered } => {
                let offered = if offered.is_empty() { "none".to_string() } else { offered.join(", ") };
                write!(
                    f,
                    "the server does not list the model '{expected}'; it offers: {offered}. Load the model on the server, or choose one it offers with /model"
                )
            }
            Self::ContextSizeUnknown { expected } => write!(
                f,
                "the server lists the configured model '{expected}' but gives no context size for it, so the context budget cannot be set; check how the server loaded that model"
            ),
            Self::ContextFull => write!(f, "the conversation no longer fits the model's context"),
            Self::ContextFullAfterChange => write!(
                f,
                "the context filled up after a change was made, so the turn was stopped rather than repeated; check the files that changed"
            ),
            Self::EmptySummary => write!(f, "the model returned an empty summary"),
            Self::Unsupported(action) => write!(f, "this provider cannot {action}"),
            Self::Session(err) => write!(f, "{err}"),
            Self::Interrupted { .. } => write!(f, "{Interrupted}"),
        }
    }
}

impl std::error::Error for ProviderError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Transport(err) | Self::Encode(err) => Some(err.as_ref()),
            Self::Session(err) => Some(err),
            Self::EmptyResponse
            | Self::TooManyToolRounds
            | Self::ModelMissing { .. }
            | Self::ContextSizeUnknown { .. }
            | Self::ContextFull
            | Self::ContextFullAfterChange
            | Self::EmptySummary
            | Self::Unsupported(_)
            | Self::Rejected(_)
            | Self::Interrupted { .. } => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn context_size_unknown_does_not_claim_the_model_is_missing() {
        let err = ProviderError::ContextSizeUnknown { expected: "a/b".into() };
        let text = err.to_string();
        assert!(text.contains("lists the configured model 'a/b'"));
        assert!(!text.contains("does not list"));
    }

    #[test]
    fn model_missing_names_the_expected_model_and_what_the_server_offers() {
        let err = ProviderError::ModelMissing { expected: "a/b".into(), offered: vec!["x".into(), "y".into()] };
        assert!(err.to_string().starts_with("the server does not list the model 'a/b'; it offers: x, y."));
    }
}
