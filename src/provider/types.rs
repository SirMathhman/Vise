use crate::error::ProviderError;
use crate::session::{Message, Turn};
use crate::tools::types::ToolRunner;

pub trait Provider {
    fn complete(&self, history: &[Message], input: String, runner: &dyn ToolRunner) -> Result<Turn, ProviderError>;

    /// The number of tokens the model can hold in one context.
    fn context_size(&self) -> Result<u64, ProviderError>;

    /// Asks the model to summarize `history`, returning the summary text.
    fn summarize(&self, history: &[Message]) -> Result<String, ProviderError>;

    /// Whether a prompt of `prompt_tokens` has reached 80% of the context size. A prompt count of 0
    /// means no request has been made yet, so it is never full.
    fn over_limit(&self, prompt_tokens: u64) -> Result<bool, ProviderError> {
        Ok(prompt_tokens > 0 && prompt_tokens * 10 >= self.context_size()? * 8)
    }
}
