use crate::error::ProviderError;
use crate::session::{Message, Turn};
use crate::tools::types::ToolRunner;

/// Progress reported while a reply is generated.
pub enum Event {
    /// Thinking has produced this many tokens so far. The thinking text itself is not reported.
    Thinking(usize),
    /// The next piece of the answer text.
    Answer(String),
    /// The reply has been fully received.
    Finished,
}

pub trait Provider {
    /// Runs one exchange. `approve` is passed to the tools so the user can confirm each change.
    fn complete(
        &self,
        history: &[Message],
        input: String,
        runner: &dyn ToolRunner,
        approve: &mut dyn FnMut(&str) -> bool,
    ) -> Result<Turn, ProviderError>;

    /// Like `complete`, but reports progress through `on_event` as the reply arrives. The default reports
    /// nothing.
    fn complete_streaming(
        &self,
        history: &[Message],
        input: String,
        runner: &dyn ToolRunner,
        approve: &mut dyn FnMut(&str) -> bool,
        _on_event: &mut dyn FnMut(Event),
    ) -> Result<Turn, ProviderError> {
        self.complete(history, input, runner, approve)
    }

    /// The number of tokens the model can hold in one context.
    fn context_size(&self) -> Result<u64, ProviderError>;

    /// Asks the model to summarize `history`, returning the summary text.
    fn summarize(&self, history: &[Message]) -> Result<String, ProviderError>;
}
