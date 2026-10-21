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

#[derive(Clone, Copy)]
pub enum Role {
    User,
    Assistant,
}

impl Role {
    fn as_str(self) -> &'static str {
        match self {
            Role::User => "user",
            Role::Assistant => "assistant",
        }
    }
}

pub struct Message {
    pub role: Role,
    pub content: String,
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

pub fn send_message(messages: &[Message], config: &Config) -> Result<String, StrataError> {
    let response = match ureq::post(&config.url).send_json(build_body(messages, config)) {
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

    parse_reply(&config.url, &data)
}

/// Builds the chat-completions request body for a single user message.
fn build_request(content: &str, config: &Config) -> Value {
    let message = Message {
        role: Role::User,
        content: content.to_owned(),
    };
    build_body(&[message], config)
}

/// Builds the chat-completions request body from the full conversation.
fn build_body(messages: &[Message], config: &Config) -> Value {
    let messages: Vec<Value> = messages
        .iter()
        .map(|message| json!({ "role": message.role.as_str(), "content": message.content }))
        .collect();
    json!({
        "model": config.model,
        "messages": messages,
    })
}

/// Extracts `choices[0].message.content` from a chat-completions response.
fn parse_reply(url: &str, data: &Value) -> Result<String, StrataError> {
    data.get("choices")
        .and_then(|choices| choices.get(0))
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| StrataError::Malformed {
            url: url.to_owned(),
            reason: "no choices[0].message.content string".to_owned(),
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_request_wraps_content_as_single_user_message() {
        let config = Config::default();
        let body = build_request("hi", &config);

        assert_eq!(body["model"], config.model);
        assert_eq!(body["messages"], json!([{ "role": "user", "content": "hi" }]));
    }

    #[test]
    fn parse_reply_returns_first_choice_content() {
        let data = json!({ "choices": [{ "message": { "content": "hello" } }] });

        assert_eq!(parse_reply("url", &data).unwrap(), "hello");
    }

    #[test]
    fn parse_reply_is_malformed_when_content_missing() {
        let data = json!({ "choices": [] });

        assert!(matches!(
            parse_reply("url", &data),
            Err(StrataError::Malformed { .. })
        ));
    }
}
