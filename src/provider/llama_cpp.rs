use crate::error::{MAX_TOOL_ROUNDS, ProviderError};
use crate::provider::grammar;
use crate::provider::prompt;
use crate::provider::types::Provider;
use crate::session::{Message, Turn, over_budget};
use crate::tools::types::{ToolCall, ToolError, ToolRunner, Value};
use crate::tools;
use serde::{Deserialize, Serialize};
use std::cell::OnceCell;
use std::collections::HashMap;

const URL: &str = "http://127.0.0.1:9931/v1/chat/completions";
const MODELS_URL: &str = "http://127.0.0.1:9931/v1/models";
const MODEL: &str = "ayozhee/Qwen3.8-27B-Abliterated-GSQ-Orca-GGUF:MTP";
const TOOL_OPEN: &str = "<tool_call>";
const TOOL_CLOSE: &str = "</tool_call>";

/// Caps one reply, so a reply that never closes its thinking block cannot run on indefinitely.
const MAX_REPLY_TOKENS: u32 = 8192;

/// No `tools` field is sent: the grammar, built from the enabled tools, is what limits the calls.
#[derive(Serialize)]
struct Request<'a> {
    model: &'static str,
    messages: &'a [WireMessage],
    max_tokens: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    grammar: Option<&'a str>,
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

#[derive(Deserialize)]
struct Response {
    choices: Vec<Choice>,
    usage: Option<Usage>,
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

#[derive(Deserialize)]
struct Choice {
    message: ReplyMessage,
}

#[derive(Deserialize)]
struct ReplyMessage {
    content: Option<String>,
}

pub struct LlamaCpp {
    api_key: String,
    context: OnceCell<u64>,
}

impl LlamaCpp {
    pub fn new(api_key: String) -> Self {
        Self { api_key, context: OnceCell::new() }
    }

    fn fetch_context_size(&self) -> Result<u64, ProviderError> {
        let mut response = ureq::get(MODELS_URL)
            .header("Authorization", &format!("Bearer {}", self.api_key))
            .call()
            .map_err(|err| ProviderError::Transport(Box::new(err)))?;
        let models: Models = response
            .body_mut()
            .read_json()
            .map_err(|err| ProviderError::Transport(Box::new(err)))?;
        models
            .data
            .into_iter()
            .find(|model| model.id == MODEL)
            .and_then(|model| model.meta)
            .map(|meta| meta.n_ctx)
            .ok_or(ProviderError::ModelNotFound)
    }

    /// Asks the model to summarize the messages it is given, without offering any tools.
    fn summarize_messages<'a>(&self, messages: impl Iterator<Item = &'a Message>) -> Result<String, ProviderError> {
        let mut wire: Vec<WireMessage> = messages.map(WireMessage::try_from).collect::<Result<_, _>>()?;
        wire.push(WireMessage::try_from(&Message::User(SUMMARY_REQUEST.into()))?);
        let (reply, prompt_tokens) = send(&self.api_key, &wire, None)?;
        if over_budget(prompt_tokens, self.context_size()?) {
            return Err(ProviderError::ContextFull);
        }
        let summary = reply.content.unwrap_or_default();
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
    ) -> Result<Turn, ProviderError> {
        let enabled = runner.enabled();
        let grammar = grammar::build(&enabled);
        let catalogue = prompt::catalogue();
        let mut new = vec![Message::User(input)];
        // Set once a write is attempted. A turn that has written is never replayed, so overflow is an error.
        let mut wrote = false;
        for _ in 0..MAX_TOOL_ROUNDS {
            let wire = wire_messages(&catalogue, history.iter().chain(&new))?;
            let (reply, prompt_tokens) = match send(&self.api_key, &wire, Some(&grammar)) {
                Err(ProviderError::ContextFull) if wrote => return Err(ProviderError::ContextFullAfterChange),
                sent => sent?,
            };
            let content = reply.content.unwrap_or_default();
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
            let result = run_call(&call, runner, approve, &mut wrote);
            let call_id = call.id.clone();
            new.push(Message::Assistant { content: String::new(), tool_calls: vec![call] });
            new.push(Message::Tool { call_id, content: result.unwrap_or_else(|err| format!("error: {err}")) });
        }
        Err(ProviderError::TooManyToolRounds)
    }

    fn context_size(&self) -> Result<u64, ProviderError> {
        if let Some(size) = self.context.get() {
            return Ok(*size);
        }
        let size = self.fetch_context_size()?;
        let _ = self.context.set(size);
        Ok(size)
    }

    fn summarize(&self, history: &[Message]) -> Result<String, ProviderError> {
        self.summarize_messages(history.iter())
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

/// Runs one call the model made. The runner refuses a tool that is not enabled.
fn run_call(
    call: &ToolCall,
    runner: &dyn ToolRunner,
    approve: &mut dyn FnMut(&str) -> bool,
    wrote: &mut bool,
) -> Result<String, ToolError> {
    let invocation = tools::call(&call.name, call.arguments.clone())?;
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

fn send(api_key: &str, wire: &[WireMessage], grammar: Option<&str>) -> Result<(ReplyMessage, u64), ProviderError> {
    let request = Request { model: MODEL, messages: wire, max_tokens: MAX_REPLY_TOKENS, grammar };
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
    let body: Response = response
        .body_mut()
        .read_json()
        .map_err(|err| ProviderError::Transport(Box::new(err)))?;
    let prompt_tokens = body.usage.map_or(0, |usage| usage.prompt_tokens);
    let message = body.choices.into_iter().next().ok_or(ProviderError::EmptyResponse)?.message;
    Ok((message, prompt_tokens))
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
}
