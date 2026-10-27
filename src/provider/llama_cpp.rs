use crate::error::{MAX_TOOL_ROUNDS, ProviderError};
use crate::provider::types::Provider;
use crate::session::{Message, Turn};
use crate::tools::types::{ParamType, ToolCall, ToolRunner, ToolSpec, Value};
use crate::tools;
use std::collections::HashMap;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

const URL: &str = "http://127.0.0.1:9931/v1/chat/completions";
const MODEL: &str = "ayozhee/Qwen3.8-27B-Abliterated-GSQ-Orca-GGUF:MTP";

#[derive(Serialize)]
struct Request<'a> {
    model: &'static str,
    messages: &'a [WireMessage],
    tools: &'a [WireTool],
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

#[derive(Serialize, Deserialize)]
struct WireToolCall {
    id: String,
    #[serde(rename = "type", default = "function_kind")]
    kind: String,
    function: WireCallFunction,
}

fn function_kind() -> String {
    "function".into()
}

#[derive(Serialize, Deserialize)]
struct WireCallFunction {
    name: String,
    arguments: String,
}

impl TryFrom<&ToolCall> for WireToolCall {
    type Error = ProviderError;

    fn try_from(call: &ToolCall) -> Result<Self, ProviderError> {
        Ok(WireToolCall {
            id: call.id.clone(),
            kind: function_kind(),
            function: WireCallFunction { name: call.name.clone(), arguments: encode(&call.arguments)? },
        })
    }
}

impl From<WireToolCall> for ToolCall {
    fn from(call: WireToolCall) -> Self {
        ToolCall { id: call.id, name: call.function.name, arguments: decode(&call.function.arguments) }
    }
}

/// Decodes the model's JSON argument object into plain values. Invalid JSON gives no arguments, so the
/// tool reports the missing fields. A value that is not a string or an integer becomes `Unsupported`.
fn decode(arguments: &str) -> HashMap<String, Value> {
    serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(arguments)
        .map(|map| map.into_iter().map(|(name, value)| (name, to_value(value))).collect())
        .unwrap_or_default()
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
        Value::Unsupported => serde_json::Value::Null,
    }
}

#[derive(Serialize)]
struct WireTool {
    #[serde(rename = "type")]
    kind: &'static str,
    function: WireFunction,
}

#[derive(Serialize)]
struct WireFunction {
    name: &'static str,
    description: &'static str,
    parameters: WireParameters,
}

#[derive(Serialize)]
struct WireParameters {
    #[serde(rename = "type")]
    kind: &'static str,
    properties: BTreeMap<&'static str, WireProperty>,
    required: Vec<&'static str>,
}

#[derive(Serialize)]
struct WireProperty {
    #[serde(rename = "type")]
    kind: &'static str,
    description: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    minimum: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    maximum: Option<u32>,
}

impl From<&ToolSpec> for WireTool {
    fn from(spec: &ToolSpec) -> Self {
        let properties = spec
            .params
            .iter()
            .map(|param| {
                let (kind, minimum, maximum) = match param.kind {
                    ParamType::String => ("string", None, None),
                    ParamType::Integer { min, max } => ("integer", min, max),
                };
                (param.name, WireProperty { kind, description: param.description, minimum, maximum })
            })
            .collect();
        WireTool {
            kind: "function",
            function: WireFunction {
                name: spec.name,
                description: spec.description,
                parameters: WireParameters {
                    kind: "object",
                    properties,
                    required: spec.params.iter().map(|param| param.name).collect(),
                },
            },
        }
    }
}

#[derive(Deserialize)]
struct Response {
    choices: Vec<Choice>,
}

#[derive(Deserialize)]
struct Choice {
    message: ReplyMessage,
}

#[derive(Deserialize)]
struct ReplyMessage {
    content: Option<String>,
    #[serde(default)]
    tool_calls: Vec<WireToolCall>,
}

pub struct LlamaCpp {
    api_key: String,
}

impl LlamaCpp {
    pub fn new(api_key: String) -> Self {
        Self { api_key }
    }
}

impl Provider for LlamaCpp {
    /// Runs one exchange: sends the history and `input`, executes any tool calls the model makes through
    /// `runner`, and returns the new messages. Nothing is returned on failure, so the caller's history
    /// stays unchanged.
    fn complete(&self, history: &[Message], input: String, runner: &dyn ToolRunner) -> Result<Turn, ProviderError> {
        let wire_tools: Vec<WireTool> = tools::specs().iter().map(WireTool::from).collect();
        let mut new = vec![Message::User(input)];
        for _ in 0..MAX_TOOL_ROUNDS {
            let wire: Vec<WireMessage> =
                history.iter().chain(&new).map(WireMessage::try_from).collect::<Result<_, _>>()?;
            let reply = send(&self.api_key, &wire, &wire_tools)?;
            let content = reply.content.unwrap_or_default();
            if reply.tool_calls.is_empty() {
                new.push(Message::Assistant { content, tool_calls: Vec::new() });
                return Turn::new(new).map_err(ProviderError::Session);
            }
            let calls: Vec<ToolCall> = reply.tool_calls.into_iter().map(ToolCall::from).collect();
            let results: Vec<Message> = calls
                .iter()
                .map(|call| Message::Tool {
                    call_id: call.id.clone(),
                    content: tools::call(&call.name, call.arguments.clone())
                        .and_then(|invocation| runner.run(&invocation))
                        .unwrap_or_else(|err| format!("error: {err}")),
                })
                .collect();
            new.push(Message::Assistant { content, tool_calls: calls });
            new.extend(results);
        }
        Err(ProviderError::TooManyToolRounds)
    }
}

fn to_value(value: serde_json::Value) -> Value {
    match value {
        serde_json::Value::String(text) => Value::Text(text),
        serde_json::Value::Number(number) => number.as_i64().map_or(Value::Unsupported, Value::Integer),
        _ => Value::Unsupported,
    }
}

fn send(api_key: &str, wire: &[WireMessage], tools: &[WireTool]) -> Result<ReplyMessage, ProviderError> {
    let request = Request { model: MODEL, messages: wire, tools };
    let mut response = ureq::post(URL)
        .header("Authorization", &format!("Bearer {api_key}"))
        .send_json(request)
        .map_err(|err| ProviderError::Transport(Box::new(err)))?;
    let body: Response = response
        .body_mut()
        .read_json()
        .map_err(|err| ProviderError::Transport(Box::new(err)))?;
    Ok(body.choices.into_iter().next().ok_or(ProviderError::EmptyResponse)?.message)
}
