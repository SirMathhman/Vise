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
    TooManyToolRounds,
    /// The configured model is not among the models the server lists. `offered` holds the ids the server lists.
    ModelNotFound { expected: String, offered: Vec<String> },
    ContextFull,
    ContextFullAfterChange,
    EmptySummary,
    Session(SessionError),
}

impl fmt::Display for ProviderError {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        match self {
            Self::Transport(err) => write!(f, "request to the model failed ({err}); check that the server is running"),
            Self::Encode(err) => write!(f, "could not encode the conversation ({err})"),
            Self::Rejected(message) => write!(f, "the server rejected the request: {message}; check the request"),
            Self::EmptyResponse => write!(f, "the model returned no choices; try the message again"),
            Self::TooManyToolRounds => write!(f, "the model kept calling tools after {MAX_TOOL_ROUNDS} rounds; try a simpler request"),
            Self::ModelNotFound { expected, offered } => {
                let offered = if offered.is_empty() { "none".to_string() } else { offered.join(", ") };
                write!(f, "the server does not list the configured model '{expected}'; it offers: {offered}")
            }
            Self::ContextFull => write!(f, "the conversation no longer fits the model's context"),
            Self::ContextFullAfterChange => write!(
                f,
                "the context filled up after a change was made, so the turn was stopped rather than repeated; check the files that changed"
            ),
            Self::EmptySummary => write!(f, "the model returned an empty summary"),
            Self::Session(err) => write!(f, "{err}"),
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
            | Self::ModelNotFound { .. }
            | Self::ContextFull
            | Self::ContextFullAfterChange
            | Self::EmptySummary
            | Self::Rejected(_) => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_not_found_names_the_expected_model_and_what_the_server_offers() {
        let err = ProviderError::ModelNotFound { expected: "a/b".into(), offered: vec!["x".into(), "y".into()] };
        assert_eq!(err.to_string(), "the server does not list the configured model 'a/b'; it offers: x, y");
    }
}
