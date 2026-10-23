//! The pieces of a streamed turn, as the front ends receive them. A leaf module: it names nothing else in the crate, so the
//! tools and the approval code can use it without depending on the client in `strata`.

/// One piece of a streamed turn: the model's reasoning, its answer text, or a tool it ran. A subagent run is
/// bracketed by `SubagentStart` and `SubagentEnd`, and each step inside it arrives as `Nested`.
#[derive(Clone, Copy)]
pub enum Chunk<'a> {
    Reasoning(&'a str),
    Content(&'a str),
    Tool(&'a str),
    SubagentStart { profile: &'a str, task: &'a str },
    Nested(&'a Chunk<'a>),
    /// `failed` is true when the subagent stopped or errored instead of answering.
    SubagentEnd { failed: bool },
    /// The start of a workflow step, with the text that names it. Only a workflow run sends these.
    Step(&'a str),
    /// An edit that has run and waits for the user to keep or undo it. `id` names the request the answer goes to, and
    /// `result` is what the edit reported.
    Approval { id: u64, name: &'a str, arguments: &'a str, result: &'a str },
}
