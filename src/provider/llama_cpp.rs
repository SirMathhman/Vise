use crate::error::{MAX_TOOL_ROUNDS, ProviderError};
use crate::provider::grammar;
use crate::provider::prompt;
use crate::provider::types::{Event, Provider, SubagentRunner};
use crate::session::{Message, Turn, over_budget};
use crate::tools::types::{Invocation, ToolCall, ToolError, ToolRunner, Value};
use crate::tools;
use serde::{Deserialize, Serialize};
use std::cell::RefCell;
use std::collections::HashMap;
use std::io::{BufRead, BufReader};

const URL: &str = "http://127.0.0.1:9931/v1/chat/completions";
const MODELS_URL: &str = "http://127.0.0.1:9931/v1/models";
const MODEL: &str = "ayozhee/Qwen3.8-27B-Abliterated-GSQ-Orca-GGUF:MTP";
const TOOL_OPEN: &str = "<tool_call>";
const TOOL_CLOSE: &str = "</tool_call>";

/// Caps one reply, so a reply that never closes its thinking block cannot run on indefinitely.
const MAX_REPLY_TOKENS: u32 = 8192;

/// No `tools` field is sent: the grammar, built from the enabled tools, is what limits the calls. The reply
/// is streamed, and the last chunk carries the usage.
#[derive(Serialize)]
struct Request<'a> {
    model: &'a str,
    messages: &'a [WireMessage],
    max_tokens: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    grammar: Option<&'a str>,
    stream: bool,
    stream_options: StreamOptions,
    return_progress: bool,
}

#[derive(Serialize)]
struct StreamOptions {
    include_usage: bool,
}

#[derive(Serialize)]
struct WireMessage {
    role: &'static str,
    content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_calls: Option<Vec<WireToolCall>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_call_id: Option<String>,
}

impl TryFrom<&Message> for WireMessage {
    type Error = ProviderError;

    fn try_from(message: &Message) -> Result<Self, ProviderError> {
        let tool_calls = if message.tool_calls().is_empty() {
            None
        } else {
            Some(message.tool_calls().iter().map(WireToolCall::try_from).collect::<Result<_, _>>()?)
        };
        Ok(WireMessage {
            role: message.role(),
            content: Some(message.content().to_string()),
            tool_calls,
            tool_call_id: message.tool_call_id().map(str::to_string),
        })
    }
}

#[derive(Serialize)]
struct WireToolCall {
    id: String,
    #[serde(rename = "type")]
    kind: &'static str,
    function: WireCallFunction,
}

#[derive(Serialize)]
struct WireCallFunction {
    name: String,
    arguments: String,
}

impl TryFrom<&ToolCall> for WireToolCall {
    type Error = ProviderError;

    fn try_from(call: &ToolCall) -> Result<Self, ProviderError> {
        Ok(WireToolCall {
            id: call.id.clone(),
            kind: "function",
            function: WireCallFunction { name: call.name.clone(), arguments: encode(&call.arguments)? },
        })
    }
}

/// The body of a tool call as the model writes it: `{"name": ..., "arguments": {...}}`.
#[derive(Deserialize)]
struct CallBody {
    name: String,
    arguments: serde_json::Map<String, serde_json::Value>,
}

/// Reads the reply as a tool call, or returns `None` if it is plain text. The grammar guarantees the
/// shape of a call, so a body that does not parse is treated as text too.
fn parse_call(content: &str, id: String) -> Option<ToolCall> {
    let body = content.trim().strip_prefix(TOOL_OPEN)?.strip_suffix(TOOL_CLOSE)?;
    let call: CallBody = serde_json::from_str(body.trim()).ok()?;
    let arguments = call.arguments.into_iter().map(|(name, value)| (name, to_value(value))).collect();
    Some(ToolCall { id, name: call.name, arguments })
}

/// Encodes plain values back into the JSON argument object for a request. `Unsupported` is encoded as
/// `null`, because the model's original value is not kept.
fn encode(arguments: &HashMap<String, Value>) -> Result<String, ProviderError> {
    let object: serde_json::Map<String, serde_json::Value> =
        arguments.iter().map(|(name, value)| (name.clone(), to_json(value))).collect();
    serde_json::to_string(&object).map_err(|err| ProviderError::Encode(Box::new(err)))
}

fn to_json(value: &Value) -> serde_json::Value {
    match value {
        Value::Text(text) => serde_json::Value::String(text.clone()),
        Value::Integer(n) => serde_json::Value::from(*n),
        Value::Bool(flag) => serde_json::Value::Bool(*flag),
        Value::Unsupported => serde_json::Value::Null,
    }
}

/// One `data:` line of the streamed reply. The last chunk has no choices and carries the usage.
#[derive(Deserialize)]
struct Chunk {
    #[serde(default)]
    choices: Vec<ChunkChoice>,
    usage: Option<Usage>,
    prompt_progress: Option<PromptProgress>,
}

/// Prompt processing progress, sent before the reply while the server reads the prompt.
#[derive(Deserialize)]
struct PromptProgress {
    total: u64,
    processed: u64,
}

#[derive(Deserialize)]
struct ChunkChoice {
    delta: Delta,
}

#[derive(Deserialize)]
struct Delta {
    content: Option<String>,
    reasoning_content: Option<String>,
}

#[derive(Deserialize)]
struct Usage {
    prompt_tokens: u64,
}

#[derive(Deserialize)]
struct ErrorBody {
    error: ErrorInfo,
}

#[derive(Deserialize)]
struct ErrorInfo {
    message: Option<String>,
    #[serde(rename = "type")]
    kind: Option<String>,
}

/// llama.cpp's error type for a request that does not fit in the context window.
const CONTEXT_OVERFLOW: &str = "exceed_context_size_error";

/// Maps the body of a 400 response: only an exact context overflow becomes `ContextFull`. Any other
/// body is a rejected request, carrying the server's message, or the raw body if it has none.
fn bad_request(body: &str) -> ProviderError {
    match serde_json::from_str::<ErrorBody>(body) {
        Ok(ErrorBody { error: ErrorInfo { kind: Some(kind), .. } }) if kind == CONTEXT_OVERFLOW => {
            ProviderError::ContextFull
        }
        Ok(ErrorBody { error: ErrorInfo { message: Some(message), .. } }) => ProviderError::Rejected(message),
        _ => ProviderError::Rejected(body.to_string()),
    }
}

#[derive(Deserialize)]
struct Models {
    data: Vec<ModelInfo>,
}

#[derive(Deserialize)]
struct ModelInfo {
    id: String,
    meta: Option<ModelMeta>,
}

#[derive(Deserialize)]
struct ModelMeta {
    n_ctx: u64,
}

/// The server's model list.
fn fetch_models(api_key: &str) -> Result<Models, ProviderError> {
    let mut response = ureq::get(MODELS_URL)
        .header("Authorization", &format!("Bearer {api_key}"))
        .call()
        .map_err(|err| ProviderError::Transport(Box::new(err)))?;
    response.body_mut().read_json().map_err(|err| ProviderError::Transport(Box::new(err)))
}

/// The context size of the configured model, from the server's list. A missing model and a model with no context
/// size are different errors, and each names what the user can check.
fn context_size_of(models: Models, expected: &str) -> Result<u64, ProviderError> {
    let offered: Vec<String> = models.data.iter().map(|model| model.id.clone()).collect();
    match models.data.into_iter().find(|model| model.id == expected) {
        None => Err(ProviderError::ModelMissing { expected: expected.to_string(), offered }),
        Some(model) => model
            .meta
            .map(|meta| meta.n_ctx)
            .ok_or_else(|| ProviderError::ContextSizeUnknown { expected: expected.to_string() }),
    }
}

pub struct LlamaCpp {
    api_key: String,
    /// The model the requests name. It starts as `MODEL` and changes with `set_model`.
    model: RefCell<String>,
    context: RefCell<Option<u64>>,
}

impl LlamaCpp {
    /// Switches to `name` as the server lists it in `listed`. A refused switch changes neither the name nor the size.
    fn switch_to(&self, listed: Models, name: &str) -> Result<(), ProviderError> {
        let context = context_size_of(listed, name)?;
        *self.model.borrow_mut() = name.to_string();
        *self.context.borrow_mut() = Some(context);
        Ok(())
    }

    pub fn new(api_key: String) -> Self {
        Self { api_key, model: RefCell::new(MODEL.to_string()), context: RefCell::new(None) }
    }

    fn fetch_context_size(&self) -> Result<u64, ProviderError> {
        context_size_of(fetch_models(&self.api_key)?, &self.model.borrow())
    }

    /// Asks the model to summarize the messages it is given, without offering any tools.
    fn summarize_messages<'a>(&self, messages: impl Iterator<Item = &'a Message>) -> Result<String, ProviderError> {
        let mut wire: Vec<WireMessage> = messages.map(WireMessage::try_from).collect::<Result<_, _>>()?;
        wire.push(WireMessage::try_from(&Message::User(SUMMARY_REQUEST.into()))?);
        let (summary, prompt_tokens) = send(&self.api_key, &self.model.borrow(), &wire, None, &mut |_| {})?;
        if over_budget(prompt_tokens, self.context_size()?) {
            return Err(ProviderError::ContextFull);
        }
        if summary.trim().is_empty() {
            return Err(ProviderError::EmptySummary);
        }
        Ok(summary)
    }
}

impl Provider for LlamaCpp {
    /// Runs one exchange: sends the history and `input`, executes any tool calls the model makes through
    /// `runner`, and returns the new messages. Nothing is returned on failure, so the caller's history
    /// stays unchanged.
    fn complete(
        &self,
        history: &[Message],
        input: String,
        runner: &dyn ToolRunner,
        approve: &mut dyn FnMut(&str) -> bool,
        subagent: &mut SubagentRunner,
    ) -> Result<Turn, ProviderError> {
        self.complete_streaming(history, input, runner, approve, subagent, &mut |_| {})
    }

    /// The exchange of `complete`, reporting the reply as it streams through `on_event`.
    fn complete_streaming(
        &self,
        history: &[Message],
        input: String,
        runner: &dyn ToolRunner,
        approve: &mut dyn FnMut(&str) -> bool,
        subagent: &mut SubagentRunner,
        on_event: &mut dyn FnMut(Event),
    ) -> Result<Turn, ProviderError> {
        let enabled = runner.enabled();
        let grammar = grammar::build(&enabled);
        let catalogue = prompt::catalogue();
        // The note goes in front of the message only when the history does not state the enabled set.
        let input = if prompt::is_announced(history, &enabled) {
            input
        } else {
            format!("{}\n\n{input}", prompt::tool_note(&enabled))
        };
        let mut new = vec![Message::User(input)];
        // Set once a write is attempted. A turn that has written is never replayed, so overflow is an error.
        let mut wrote = false;
        for _ in 0..MAX_TOOL_ROUNDS {
            let wire = wire_messages(&catalogue, history.iter().chain(&new))?;
            let (content, prompt_tokens) = match send(&self.api_key, &self.model.borrow(), &wire, Some(&grammar), &mut *on_event) {
                Err(ProviderError::ContextFull) if wrote => return Err(ProviderError::ContextFullAfterChange),
                sent => sent?,
            };
            let Some(call) = parse_call(&content, format!("call-{}", new.len())) else {
                new.push(Message::Assistant { content, tool_calls: Vec::new() });
                return Turn::new(new)
                    .map(|turn| turn.with_prompt_tokens(prompt_tokens))
                    .map_err(ProviderError::Session);
            };
            // Another round would not fit, so stop before running its tool. The caller compacts and retries.
            if over_budget(prompt_tokens, self.context_size()?) {
                return Err(if wrote { ProviderError::ContextFullAfterChange } else { ProviderError::ContextFull });
            }
            let result = run_call(&call, runner, approve, subagent, &mut wrote);
            let call_id = call.id.clone();
            new.push(Message::Assistant { content: String::new(), tool_calls: vec![call] });
            new.push(Message::Tool { call_id, content: result.unwrap_or_else(|err| format!("error: {err}")) });
        }
        Err(ProviderError::TooManyToolRounds)
    }

    fn context_size(&self) -> Result<u64, ProviderError> {
        if let Some(size) = *self.context.borrow() {
            return Ok(size);
        }
        let size = self.fetch_context_size()?;
        *self.context.borrow_mut() = Some(size);
        Ok(size)
    }

    fn summarize(&self, history: &[Message]) -> Result<String, ProviderError> {
        self.summarize_messages(history.iter())
    }

    fn model(&self) -> String {
        self.model.borrow().clone()
    }

    fn models(&self) -> Result<Vec<String>, ProviderError> {
        Ok(fetch_models(&self.api_key)?.data.into_iter().map(|model| model.id).collect())
    }

    /// Makes `name` the model the requests name. Its context size comes from the same list that shows it is listed, so
    /// a model without one is refused, and a refused switch changes neither the name nor the cached size.
    fn set_model(&self, name: &str) -> Result<(), ProviderError> {
        self.switch_to(fetch_models(&self.api_key)?, name)
    }
}

/// Converts the messages for a request. The chat template accepts only one system message, at the start, so
/// the catalogue is joined to the first one. The conversation itself is not changed.
fn wire_messages<'a>(
    catalogue: &str,
    messages: impl Iterator<Item = &'a Message>,
) -> Result<Vec<WireMessage>, ProviderError> {
    let mut wire: Vec<WireMessage> = messages.map(WireMessage::try_from).collect::<Result<_, _>>()?;
    if let Some(first) = wire.first_mut().filter(|first| first.role == "system") {
        let context = first.content.take().unwrap_or_default();
        first.content = Some(format!("{catalogue}\n\n{context}"));
    } else {
        wire.insert(0, WireMessage::try_from(&Message::System(catalogue.to_string()))?);
    }
    Ok(wire)
}

/// Runs one call the model made. The runner refuses a tool that is not enabled. A subagent is run by `subagent`
/// rather than the runner, and it counts as a write, since it may make writes of its own.
fn run_call(
    call: &ToolCall,
    runner: &dyn ToolRunner,
    approve: &mut dyn FnMut(&str) -> bool,
    subagent: &mut SubagentRunner,
    wrote: &mut bool,
) -> Result<String, ToolError> {
    let invocation = tools::call(&call.name, call.arguments.clone())?;
    if let Invocation::RunSubagent { profile, task } = &invocation {
        if !runner.enabled().contains(&"run_subagent") {
            return Err(ToolError::Disabled("run_subagent".into()));
        }
        *wrote = true;
        return subagent(profile, task, approve);
    }
    *wrote |= invocation.writes();
    runner.run(&invocation, approve)
}

fn to_value(value: serde_json::Value) -> Value {
    match value {
        serde_json::Value::String(text) => Value::Text(text),
        serde_json::Value::Number(number) => number.as_i64().map_or(Value::Unsupported, Value::Integer),
        serde_json::Value::Bool(flag) => Value::Bool(flag),
        _ => Value::Unsupported,
    }
}

/// Sends one request and returns the reply with the prompt tokens llama.cpp counted for it (0 if it
/// reported none).
const SUMMARY_REQUEST: &str = "Summarize your conversation with the user";

/// Sends one streamed request. Returns the whole reply text and the prompt tokens llama.cpp counted (0 if it
/// reported none). `on_event` receives prompt progress, thinking counts, and answer text as they arrive, and a
/// final `Finished`.
/// Tool calls are never reported as answer text, because a reply that starts with `<tool_call>` is a call.
fn send(
    api_key: &str,
    model: &str,
    wire: &[WireMessage],
    grammar: Option<&str>,
    on_event: &mut dyn FnMut(Event),
) -> Result<(String, u64), ProviderError> {
    let request = Request {
        model,
        messages: wire,
        max_tokens: MAX_REPLY_TOKENS,
        grammar,
        stream: true,
        stream_options: StreamOptions { include_usage: true },
        return_progress: true,
    };
    let mut response = ureq::post(URL)
        .config()
        .http_status_as_error(false)
        .build()
        .header("Authorization", &format!("Bearer {api_key}"))
        .send_json(request)
        .map_err(|err| ProviderError::Transport(Box::new(err)))?;
    let status = response.status().as_u16();
    if status == 400 {
        let body = response
            .body_mut()
            .read_to_string()
            .map_err(|err| ProviderError::Transport(Box::new(err)))?;
        return Err(bad_request(&body));
    }
    if !(200..300).contains(&status) {
        return Err(ProviderError::Transport(format!("the server returned status {status}").into()));
    }
    let mut stream = Stream::default();
    let mut prompt_tokens = 0;
    for line in BufReader::new(response.body_mut().as_reader()).lines() {
        let line = line.map_err(|err| ProviderError::Transport(Box::new(err)))?;
        let Some(data) = line.strip_prefix("data: ") else { continue };
        if data == "[DONE]" {
            break;
        }
        let chunk: Chunk = serde_json::from_str(data).map_err(|err| ProviderError::Transport(Box::new(err)))?;
        prompt_tokens += chunk.usage.map_or(0, |usage| usage.prompt_tokens);
        if let Some(progress) = chunk.prompt_progress {
            on_event(Event::Prompt { processed: progress.processed, total: progress.total });
        }
        for choice in chunk.choices {
            if choice.delta.reasoning_content.is_some_and(|text| !text.is_empty()) {
                stream.thinking_tokens += 1;
                on_event(Event::Thinking(stream.thinking_tokens));
            }
            if let Some(text) = choice.delta.content {
                stream.push(&text, on_event);
            }
        }
    }
    stream.finish(on_event);
    on_event(Event::Finished);
    Ok((stream.content, prompt_tokens))
}

/// The reply as it arrives. Text is held back until it is known not to be a tool call, so a call is never
/// shown.
#[derive(Default)]
struct Stream {
    content: String,
    thinking_tokens: usize,
    /// `None` until the start of the reply decides it, then whether it is a tool call.
    is_call: Option<bool>,
    /// Bytes of `content` already reported as answer text.
    shown: usize,
}

impl Stream {
    fn push(&mut self, text: &str, on_event: &mut dyn FnMut(Event)) {
        self.content.push_str(text);
        if self.is_call.is_none() {
            self.is_call = reply_kind(&self.content);
        }
        if self.is_call == Some(false) {
            self.show(on_event);
        }
    }

    /// At the end, an undecided reply can only be text, because a call's start decides it.
    fn finish(&mut self, on_event: &mut dyn FnMut(Event)) {
        if self.is_call.is_none() {
            self.is_call = Some(false);
            self.show(on_event);
        }
    }

    fn show(&mut self, on_event: &mut dyn FnMut(Event)) {
        let text = self.content[self.shown..].to_string();
        self.shown = self.content.len();
        if !text.is_empty() {
            on_event(Event::Answer(text));
        }
    }
}

/// Decides from the start of a reply whether it is a tool call: `Some(true)` for a call, `Some(false)` for
/// text, and `None` while its start could still become either.
fn reply_kind(content: &str) -> Option<bool> {
    let start = content.trim_start();
    if start.starts_with(TOOL_OPEN) {
        Some(true)
    } else if TOOL_OPEN.starts_with(start) {
        None
    } else {
        Some(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reply_that_is_a_call_is_parsed() {
        let content = "<tool_call>\n{\"name\": \"read_file\", \"arguments\": {\"path\": \"a.txt\", \"start\": 1}}\n</tool_call>";
        let call = parse_call(content, "call-1".into()).expect("expected a tool call");
        assert_eq!(call.name, "read_file");
        assert!(matches!(call.arguments.get("start"), Some(Value::Integer(1))));
    }

    #[test]
    fn plain_text_is_not_a_call() {
        assert!(parse_call("just an answer", "call-1".into()).is_none());
    }

    #[test]
    fn recorded_overflow_body_is_context_full() {
        let body = r#"{"error":{"code":400,"message":"request (400040 tokens) exceeds the available context size (262144 tokens), try increasing it","type":"exceed_context_size_error","n_prompt_tokens":400040,"n_ctx":262144}}"#;
        assert!(matches!(bad_request(body), ProviderError::ContextFull));
    }

    #[test]
    fn other_bad_request_is_rejected_with_the_server_message() {
        let body = r#"{"error":{"code":400,"message":"model name is missing from the request","type":"invalid_request_error"}}"#;
        let error = bad_request(body);
        assert!(matches!(error, ProviderError::Rejected(_)));
        assert!(error.to_string().contains("model name is missing from the request"));
    }

    #[test]
    fn non_json_body_mentioning_overflow_is_not_context_full() {
        let body = "exceed_context_size_error: request too large";
        let error = bad_request(body);
        assert!(matches!(error, ProviderError::Rejected(ref text) if text == body));
    }

    #[test]
    fn message_without_type_is_rejected_with_the_message() {
        let body = r#"{"error":{"message":"bad temperature"}}"#;
        assert!(matches!(bad_request(body), ProviderError::Rejected(ref text) if text == "bad temperature"));
    }

    #[test]
    fn bad_request_without_a_message_keeps_the_raw_body() {
        let body = r#"{"error":{}}"#;
        assert!(matches!(bad_request(body), ProviderError::Rejected(ref text) if text == body));
    }

    /// A run_subagent call with a profile and a task.
    fn subagent_call() -> ToolCall {
        ToolCall {
            id: "call-1".into(),
            name: "run_subagent".into(),
            arguments: HashMap::from([
                ("profile".to_string(), Value::Text("coder".into())),
                ("task".to_string(), Value::Text("look".into())),
            ]),
        }
    }

    #[test]
    fn run_subagent_call_marks_the_turn_as_written() {
        let tools = crate::tools::runner::WorkspaceTools::new(std::env::temp_dir());
        let mut wrote = false;
        let result = run_call(
            &subagent_call(),
            &tools,
            &mut |_: &str| true,
            &mut |profile: &str, task: &str, _: &mut dyn FnMut(&str) -> bool| -> Result<String, ToolError> {
                Ok(format!("{profile} {task}"))
            },
            &mut wrote,
        );
        assert_eq!(result.unwrap(), "coder look");
        assert!(wrote);
    }

    #[test]
    fn disabled_run_subagent_call_is_refused_before_the_subagent_runs() {
        let tools = crate::tools::runner::WorkspaceTools::new(std::env::temp_dir());
        tools.set_enabled("run_subagent", false).unwrap();
        let started = std::cell::Cell::new(false);
        let mut wrote = false;
        let result = run_call(
            &subagent_call(),
            &tools,
            &mut |_: &str| true,
            &mut |_: &str, _: &str, _: &mut dyn FnMut(&str) -> bool| -> Result<String, ToolError> {
                started.set(true);
                Ok(String::new())
            },
            &mut wrote,
        );
        assert!(matches!(result, Err(ToolError::Disabled(ref name)) if name == "run_subagent"));
        assert!(!started.get());
    }

    #[test]
    fn server_list_without_the_model_is_model_missing() {
        let models = Models { data: vec![ModelInfo { id: "other".into(), meta: None }] };
        match context_size_of(models, MODEL) {
            Err(ProviderError::ModelMissing { expected, offered }) => {
                assert_eq!(expected, MODEL);
                assert_eq!(offered, vec!["other".to_string()]);
            }
            other => panic!("expected ModelMissing, got {other:?}"),
        }
    }

    #[test]
    fn listed_model_without_metadata_is_context_size_unknown() {
        let models = Models { data: vec![ModelInfo { id: MODEL.into(), meta: None }] };
        assert!(matches!(context_size_of(models, MODEL), Err(ProviderError::ContextSizeUnknown { .. })));
    }

    #[test]
    fn listed_model_with_metadata_gives_its_context_size() {
        let models = Models { data: vec![ModelInfo { id: MODEL.into(), meta: Some(ModelMeta { n_ctx: 4096 }) }] };
        assert_eq!(context_size_of(models, MODEL).unwrap(), 4096);
    }

    #[test]
    fn switch_to_a_listed_model_without_a_size_is_refused_and_keeps_the_old_model_and_size() {
        let provider = LlamaCpp::new("key".into());
        *provider.context.borrow_mut() = Some(1000);
        let listed = Models { data: vec![ModelInfo { id: "new".into(), meta: None }] };
        assert!(matches!(provider.switch_to(listed, "new"), Err(ProviderError::ContextSizeUnknown { .. })));
        assert_eq!(provider.model(), MODEL);
        assert_eq!(*provider.context.borrow(), Some(1000));
    }

    #[test]
    fn switch_to_a_name_the_server_does_not_list_keeps_the_old_model_and_size() {
        let provider = LlamaCpp::new("key".into());
        *provider.context.borrow_mut() = Some(1000);
        let listed = Models { data: vec![ModelInfo { id: "other".into(), meta: Some(ModelMeta { n_ctx: 8 }) }] };
        assert!(matches!(provider.switch_to(listed, "new"), Err(ProviderError::ModelMissing { .. })));
        assert_eq!(provider.model(), MODEL);
        assert_eq!(*provider.context.borrow(), Some(1000));
    }

    #[test]
    fn a_successful_switch_replaces_the_name_and_the_cached_size() {
        let provider = LlamaCpp::new("key".into());
        *provider.context.borrow_mut() = Some(1000);
        let listed = Models { data: vec![ModelInfo { id: "new".into(), meta: Some(ModelMeta { n_ctx: 4096 }) }] };
        provider.switch_to(listed, "new").unwrap();
        assert_eq!(provider.model(), "new");
        assert_eq!(*provider.context.borrow(), Some(4096));
    }
}
