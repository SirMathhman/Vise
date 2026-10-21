use std::fmt;

use serde_json::{Value, json};

pub struct Config {
    pub url: String,
    pub model: String,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            url: "http://127.0.0.1:8080/v1/chat/completions".to_owned(),
            model: "qwen3.8-flash-next-iq2_xs".to_owned(),
        }
    }
}

#[derive(Debug)]
pub enum StrataError {
    Network { url: String, cause: String },
    Http { url: String, status: u16, body: String },
    Malformed { url: String, reason: String },
}

impl fmt::Display for StrataError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            StrataError::Network { url, cause } => write!(
                f,
                "Strata not reachable at {url} ({cause}). Start the Strata server and try again."
            ),
            StrataError::Http { url, status, body } => {
                write!(f, "Strata at {url} returned HTTP {status}: {body}")
            }
            StrataError::Malformed { url, reason } => {
                write!(f, "Strata at {url} returned an unexpected response ({reason}).")
            }
        }
    }
}

pub fn send_message(content: &str, config: &Config) -> Result<String, StrataError> {
    let body = json!({
        "model": config.model,
        "messages": [{ "role": "user", "content": content }],
    });

    let response = match ureq::post(&config.url).send_json(body) {
        Ok(response) => response,
        Err(ureq::Error::Status(status, response)) => {
            return Err(StrataError::Http {
                url: config.url.clone(),
                status,
                body: response.into_string().unwrap_or_default(),
            });
        }
        Err(ureq::Error::Transport(transport)) => {
            return Err(StrataError::Network {
                url: config.url.clone(),
                cause: transport.to_string(),
            });
        }
    };

    let data: Value = response.into_json().map_err(|err| StrataError::Malformed {
        url: config.url.clone(),
        reason: err.to_string(),
    })?;

    extract_reply(&data).ok_or_else(|| StrataError::Malformed {
        url: config.url.clone(),
        reason: "no choices[0].message.content string".to_owned(),
    })
}

fn extract_reply(data: &Value) -> Option<String> {
    data.get("choices")?
        .get(0)?
        .get("message")?
        .get("content")?
        .as_str()
        .map(str::to_owned)
}
