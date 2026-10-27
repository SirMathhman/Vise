use crate::error::ProviderError;
use crate::session::{Message, Turn};
use crate::tools::types::ToolRunner;

pub trait Provider {
    fn complete(&self, history: &[Message], input: String, runner: &dyn ToolRunner) -> Result<Turn, ProviderError>;
}
