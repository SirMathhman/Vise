use crate::session::Message;
use crate::tools;
use serde::Deserialize;
use serde_json::{Value, json};
use std::fmt;
use std::path::Path;

const URL: &str = "http://127.0.0.1:9931/v1/chat/completions";
const MODEL: &str = "ayozhee/Qwen3.8-27B-Abliterated-GSQ-Orca-GGUF:MTP";
const MAX_TOOL_ROUNDS: usize = 10;

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
    tool_calls: Vec<Value>,
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
    let mut wire: Vec<Value> = messages
        .iter()
        .map(|m| json!({"role": m.role.as_str(), "content": m.content}))
        .collect();
    for _ in 0..MAX_TOOL_ROUNDS {
        let reply = send(api_key, &wire)?;
        if reply.tool_calls.is_empty() {
            return Ok(reply.content.unwrap_or_default());
        }
        wire.push(json!({"role": "assistant", "content": reply.content, "tool_calls": reply.tool_calls.clone()}));
        for call in &reply.tool_calls {
            let id = call["id"].as_str().unwrap_or_default();
            let name = call["function"]["name"].as_str().unwrap_or_default();
            let arguments = call["function"]["arguments"].as_str().unwrap_or_default();
            let result = tools::execute(name, arguments, cwd);
            wire.push(json!({"role": "tool", "tool_call_id": id, "content": result}));
        }
    }
    Err(ChatError::TooManyToolRounds)
}

fn send(api_key: &str, wire: &[Value]) -> Result<ReplyMessage, ChatError> {
    let mut response = ureq::post(URL)
        .header("Authorization", &format!("Bearer {api_key}"))
        .send_json(json!({"model": MODEL, "messages": wire, "tools": tools::definitions()}))
        .map_err(ChatError::Request)?;
    let body: Response = response.body_mut().read_json().map_err(ChatError::Request)?;
    Ok(body.choices.into_iter().next().ok_or(ChatError::EmptyResponse)?.message)
}
