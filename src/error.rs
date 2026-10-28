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
    ModelMissing { expected: String, offered: Vec<String> },
    /// The server lists the configured model but gives no context size for it.
    ContextSizeUnknown { expected: String },
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
            Self::ModelMissing { expected, offered } => {
                let offered = if offered.is_empty() { "none".to_string() } else { offered.join(", ") };
                write!(
                    f,
                    "the server does not list the configured model '{expected}'; it offers: {offered}. Load that model on the server, or change MODEL in src/provider/llama_cpp.rs"
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
            | Self::ModelMissing { .. }
            | Self::ContextSizeUnknown { .. }
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
    fn context_size_unknown_does_not_claim_the_model_is_missing() {
        let err = ProviderError::ContextSizeUnknown { expected: "a/b".into() };
        let text = err.to_string();
        assert!(text.contains("lists the configured model 'a/b'"));
        assert!(!text.contains("does not list"));
    }

    #[test]
    fn model_missing_names_the_expected_model_and_what_the_server_offers() {
        let err = ProviderError::ModelMissing { expected: "a/b".into(), offered: vec!["x".into(), "y".into()] };
        assert!(err.to_string().starts_with("the server does not list the configured model 'a/b'; it offers: x, y."));
    }
}
