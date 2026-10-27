use crate::error::{MAX_TOOL_ROUNDS, ProviderError};
use crate::provider::types::Provider;
use crate::session::{Message, Role, Turn};
use crate::tools::types::{ParamType, ToolCall, ToolRunner, ToolSpec};
use crate::tools;
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

impl From<&Message> for WireMessage {
    fn from(message: &Message) -> Self {
        let tool_calls = (!message.tool_calls.is_empty())
            .then(|| message.tool_calls.iter().map(WireToolCall::from).collect());
        WireMessage {
            role: message.role.as_str(),
            content: Some(message.content.clone()),
            tool_calls,
            tool_call_id: message.tool_call_id.clone(),
        }
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

impl From<&ToolCall> for WireToolCall {
    fn from(call: &ToolCall) -> Self {
        WireToolCall {
            id: call.id.clone(),
            kind: function_kind(),
            function: WireCallFunction { name: call.name.clone(), arguments: call.arguments.clone() },
        }
    }
}

impl From<WireToolCall> for ToolCall {
    fn from(call: WireToolCall) -> Self {
        ToolCall { id: call.id, name: call.function.name, arguments: call.function.arguments }
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
        let mut new = vec![Message::new(Role::User, input)];
        for _ in 0..MAX_TOOL_ROUNDS {
            let wire: Vec<WireMessage> = history.iter().chain(&new).map(WireMessage::from).collect();
            let reply = send(&self.api_key, &wire, &wire_tools)?;
            let content = reply.content.unwrap_or_default();
            if reply.tool_calls.is_empty() {
                new.push(Message::new(Role::Assistant, content));
                return Ok(Turn { messages: new });
            }
            let calls: Vec<ToolCall> = reply.tool_calls.into_iter().map(ToolCall::from).collect();
            let results: Vec<Message> = calls
                .iter()
                .map(|call| Message {
                    role: Role::Tool,
                    content: runner.run(call).unwrap_or_else(|err| format!("error: {err}")),
                    tool_calls: Vec::new(),
                    tool_call_id: Some(call.id.clone()),
                })
                .collect();
            new.push(Message { role: Role::Assistant, content, tool_calls: calls, tool_call_id: None });
            new.extend(results);
        }
        Err(ProviderError::TooManyToolRounds)
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
