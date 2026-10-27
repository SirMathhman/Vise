use std::fmt;

pub const MAX_TOOL_ROUNDS: usize = 10;

#[derive(Debug)]
pub enum SessionError {
    MalformedTurn,
}

impl fmt::Display for SessionError {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        match self {
            Self::MalformedTurn => write!(f, "a turn must end with the assistant's reply and no tool calls"),
        }
    }
}

impl std::error::Error for SessionError {}

#[derive(Debug)]
pub enum ProviderError {
    Transport(Box<dyn std::error::Error>),
    EmptyResponse,
    TooManyToolRounds,
    Session(SessionError),
}

impl fmt::Display for ProviderError {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        match self {
            Self::Transport(err) => write!(f, "request to the model failed ({err}); check that the server is running"),
            Self::EmptyResponse => write!(f, "the model returned no choices; try the message again"),
            Self::TooManyToolRounds => write!(f, "the model kept calling tools after {MAX_TOOL_ROUNDS} rounds; try a simpler request"),
            Self::Session(err) => write!(f, "{err}"),
        }
    }
}

impl std::error::Error for ProviderError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Transport(err) => Some(err.as_ref()),
            Self::Session(err) => Some(err),
            Self::EmptyResponse | Self::TooManyToolRounds => None,
        }
    }
}
