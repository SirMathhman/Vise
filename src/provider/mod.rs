pub mod llama_cpp;

use crate::session::{Message, Turn};
use crate::tools::ToolRunner;
use std::fmt;

pub const MAX_TOOL_ROUNDS: usize = 10;

#[derive(Debug)]
pub enum ProviderError {
    Transport(Box<dyn std::error::Error>),
    EmptyResponse,
    TooManyToolRounds,
}

impl fmt::Display for ProviderError {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        match self {
            Self::Transport(err) => write!(f, "request to the model failed ({err}); check that the server is running"),
            Self::EmptyResponse => write!(f, "the model returned no choices; try the message again"),
            Self::TooManyToolRounds => write!(f, "the model kept calling tools after {MAX_TOOL_ROUNDS} rounds; try a simpler request"),
        }
    }
}

impl std::error::Error for ProviderError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Transport(err) => Some(err.as_ref()),
            Self::EmptyResponse | Self::TooManyToolRounds => None,
        }
    }
}

pub trait Provider {
    fn complete(&self, history: &[Message], input: String, runner: &dyn ToolRunner) -> Result<Turn, ProviderError>;
}
