use serde::{Deserialize, Serialize};

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

pub fn complete(api_key: &str, messages: &[Message]) -> Result<String, Box<dyn std::error::Error>> {
    let mut response = ureq::post(URL)
        .header("Authorization", &format!("Bearer {api_key}"))
        .send_json(Request { model: MODEL, messages })?;
    let body: Response = response.body_mut().read_json()?;
    let choice = body.choices.into_iter().next().ok_or("response had no choices")?;
    Ok(choice.message.content)
}
