use serde::{Deserialize, Serialize};
use std::fmt;

const URL: &str = "http://127.0.0.1:9931/v1/chat/completions";
const MODEL: &str = "ayozhee/Qwen3.8-27B-Abliterated-GSQ-Orca-GGUF:MTP";

#[derive(Serialize, Deserialize, Clone)]
pub struct Message {
    pub role: String,
    pub content: String,
}

#[derive(Serialize)]
struct Request<'a> {
    model: &'static str,
    messages: &'a [Message],
}

#[derive(Deserialize)]
struct Response {
    choices: Vec<Choice>,
}

#[derive(Deserialize)]
struct Choice {
    message: Message,
}

#[derive(Debug)]
pub enum ChatError {
    Request(ureq::Error),
    EmptyResponse,
}

impl fmt::Display for ChatError {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        match self {
            Self::Request(err) => write!(
                f,
                "request to {URL} failed ({err}); check that llama.cpp is running and that LLAMA_API_KEY in .env is correct"
            ),
            Self::EmptyResponse => write!(f, "llama.cpp returned no choices; try the message again"),
        }
    }
}

impl std::error::Error for ChatError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Request(err) => Some(err),
            Self::EmptyResponse => None,
        }
    }
}

pub fn complete(api_key: &str, messages: &[Message]) -> Result<String, ChatError> {
    let mut response = ureq::post(URL)
        .header("Authorization", &format!("Bearer {api_key}"))
        .send_json(Request { model: MODEL, messages })
        .map_err(ChatError::Request)?;
    let body: Response = response.body_mut().read_json().map_err(ChatError::Request)?;
    let choice = body.choices.into_iter().next().ok_or(ChatError::EmptyResponse)?;
    Ok(choice.message.content)
}
