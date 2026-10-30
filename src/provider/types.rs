use crate::error::ProviderError;
use crate::session::{Message, RequestRecord, Turn};
use crate::tools::types::{ToolError, ToolRunner};

/// Progress reported while a reply is generated.
#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    /// Prompt processing has reached `processed` of the prompt's `total` tokens.
    Prompt { processed: u64, total: u64 },
    /// Thinking has produced this many tokens so far. The thinking text itself is not reported.
    Thinking(usize),
    /// The next piece of the answer text.
    Answer(String),
    /// The reply asked for a tool run: its name, and what it acts on, when the arguments name one.
    Tool { name: String, target: Option<String> },
    /// The tool call just reported could not run, with why. Shown so a call that did not happen does not read like one
    /// that did.
    ToolFailed(String),
    /// The reply has been fully received.
    Finished,
}

/// Runs a subagent: its profile name, its task, and the approval function to use for its writes. The reply is the
/// subagent's final text. The session supplies it, because a subagent needs the session's turn logic.
pub type SubagentRunner<'a> = dyn FnMut(&str, &str, &mut dyn FnMut(&str) -> bool) -> Result<String, ToolError> + 'a;

pub trait Provider {
    /// Runs one exchange. `approve` is passed to the tools so the user can confirm each change, and `subagent`
    /// runs the subagents the model starts.
    fn complete(
        &self,
        history: &[Message],
        input: String,
        runner: &dyn ToolRunner,
        approve: &mut dyn FnMut(&str) -> bool,
        subagent: &mut SubagentRunner,
    ) -> Result<Turn, ProviderError>;

    /// Like `complete`, but reports progress through `on_event` as the reply arrives. The default reports
    /// nothing.
    fn complete_streaming(
        &self,
        history: &[Message],
        input: String,
        runner: &dyn ToolRunner,
        approve: &mut dyn FnMut(&str) -> bool,
        subagent: &mut SubagentRunner,
        _on_event: &mut dyn FnMut(Event),
    ) -> Result<Turn, ProviderError> {
        self.complete(history, input, runner, approve, subagent)
    }

    /// The number of tokens the model can hold in one context.
    fn context_size(&self) -> Result<u64, ProviderError>;

    /// Asks the model to summarize `history`, returning the summary text and the timing of the request it made.
    fn summarize(&self, history: &[Message]) -> Result<(String, RequestRecord), ProviderError>;
    /// The model the requests name. A provider with no model choice names none.
    fn model(&self) -> String {
        String::new()
    }

    /// The ids of the models the server lists.
    fn models(&self) -> Result<Vec<String>, ProviderError> {
        Err(ProviderError::Unsupported("list models".into()))
    }

    /// Makes `name` the model the requests name, if the server lists it.
    fn set_model(&self, _name: &str) -> Result<(), ProviderError> {
        Err(ProviderError::Unsupported("change the model".into()))
    }
}
