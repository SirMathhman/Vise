use crate::session::Message;
use crate::tools::{self, ParamType, ToolCall, ToolSpec};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fmt;
use std::path::Path;

const URL: &str = "http://127.0.0.1:9931/v1/chat/completions";
const MODEL: &str = "ayozhee/Qwen3.8-27B-Abliterated-GSQ-Orca-GGUF:MTP";
const MAX_TOOL_ROUNDS: usize = 10;

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

#[derive(Clone, Serialize, Deserialize)]
struct WireToolCall {
    id: String,
    #[serde(rename = "type", default = "function_kind")]
    kind: String,
    function: WireCallFunction,
}

fn function_kind() -> String {
    "function".into()
}

#[derive(Clone, Serialize, Deserialize)]
struct WireCallFunction {
    name: String,
    arguments: String,
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
    minimum: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    maximum: Option<u8>,
}

impl From<&ToolSpec> for WireTool {
    fn from(spec: &ToolSpec) -> Self {
        let properties = spec
            .params
            .iter()
            .map(|param| {
                let (kind, minimum, maximum) = match param.kind {
                    ParamType::String => ("string", None, None),
                    ParamType::Integer { min, max } => ("integer", Some(min), Some(max)),
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

#[derive(Debug)]
pub enum ChatError {
    Request(ureq::Error),
    EmptyResponse,
    TooManyToolRounds,
}

impl fmt::Display for ChatError {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        match self {
            Self::Request(err) => write!(
                f,
                "request to {URL} failed ({err}); check that llama.cpp is running and that LLAMA_API_KEY in .env is correct"
            ),
            Self::EmptyResponse => write!(f, "llama.cpp returned no choices; try the message again"),
            Self::TooManyToolRounds => write!(f, "llama.cpp kept calling tools after {MAX_TOOL_ROUNDS} rounds; try a simpler request"),
        }
    }
}

impl std::error::Error for ChatError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Request(err) => Some(err),
            Self::EmptyResponse | Self::TooManyToolRounds => None,
        }
    }
}

pub fn complete(api_key: &str, messages: &[Message], cwd: &Path) -> Result<String, ChatError> {
    let mut wire: Vec<WireMessage> = messages
        .iter()
        .map(|m| WireMessage {
            role: m.role.as_str(),
            content: Some(m.content.clone()),
            tool_calls: None,
            tool_call_id: None,
        })
        .collect();
    let tools: Vec<WireTool> = tools::specs().iter().map(WireTool::from).collect();
    for _ in 0..MAX_TOOL_ROUNDS {
        let reply = send(api_key, &wire, &tools)?;
        if reply.tool_calls.is_empty() {
            return Ok(reply.content.unwrap_or_default());
        }
        wire.push(WireMessage {
            role: "assistant",
            content: reply.content,
            tool_calls: Some(reply.tool_calls.clone()),
            tool_call_id: None,
        });
        for call in &reply.tool_calls {
            let tool_call = ToolCall {
                id: call.id.clone(),
                name: call.function.name.clone(),
                arguments: call.function.arguments.clone(),
            };
            let content = tools::execute(&tool_call, cwd).unwrap_or_else(|err| format!("error: {err}"));
            wire.push(WireMessage {
                role: "tool",
                content: Some(content),
                tool_calls: None,
                tool_call_id: Some(call.id.clone()),
            });
        }
    }
    Err(ChatError::TooManyToolRounds)
}

fn send(api_key: &str, wire: &[WireMessage], tools: &[WireTool]) -> Result<ReplyMessage, ChatError> {
    let request = Request { model: MODEL, messages: wire, tools };
    let mut response = ureq::post(URL)
        .header("Authorization", &format!("Bearer {api_key}"))
        .send_json(request)
        .map_err(ChatError::Request)?;
    let body: Response = response.body_mut().read_json().map_err(ChatError::Request)?;
    Ok(body.choices.into_iter().next().ok_or(ChatError::EmptyResponse)?.message)
}
