use crate::error::ProviderError;
use crate::session::{Message, Turn};
use crate::tools::types::ToolRunner;

pub trait Provider {
    fn complete(&self, history: &[Message], input: String, runner: &dyn ToolRunner) -> Result<Turn, ProviderError>;

    /// The number of tokens the model can hold in one context.
    fn context_size(&self) -> Result<u64, ProviderError>;

    /// Asks the model to summarize `history`, returning the summary text.
    fn summarize(&self, history: &[Message]) -> Result<String, ProviderError>;
}
