use std::collections::BTreeSet;
use std::error::Error as _;
use std::fmt;
use std::io::{self, BufRead, BufReader, Read};
use std::time::Duration;

use serde_json::{Value, json};

use crate::tools;

#[derive(Clone)]
pub struct Config {
    pub url: String,
    pub model: String,
    /// Longest the client waits for the next bytes from Strata before giving up.
    pub read_timeout: Duration,
    /// Directory the model is told it is working in. Sent as a system message when set.
    pub working_dir: Option<String>,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            url: "http://127.0.0.1:8080/v1/chat/completions".to_owned(),
            model: "qwen3.8-flash-next-iq2_xs".to_owned(),
            read_timeout: Duration::from_secs(60),
            working_dir: None,
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

/// One piece of a streamed turn: the model's reasoning, its answer text, or a tool it ran.
pub enum Chunk<'a> {
    Reasoning(&'a str),
    Content(&'a str),
    Tool(&'a str),
}

/// A tool call the model asked for, assembled from streamed fragments.
#[derive(Default)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: String,
}

/// One streamed model response: its answer text and any tool calls.
pub struct Reply {
    pub content: String,
    pub tool_calls: Vec<ToolCall>,
}

pub type EventReader = BufReader<Box<dyn Read + Send + Sync>>;

#[derive(Debug)]
pub enum StrataError {
    Network { url: String, cause: String },
    Timeout { url: String },
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
            StrataError::Timeout { url } => write!(
                f,
                "Strata at {url} stopped responding. Check that the server is running and not overloaded."
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

/// Streams one model response for the given conversation items, calling `on_chunk` for each delta.
pub fn stream_reply(
    items: &[Value],
    config: &Config,
    disabled: &BTreeSet<String>,
    on_chunk: &mut dyn FnMut(Chunk),
) -> Result<Reply, StrataError> {
    let reader = open_stream(items, config, disabled)?;
    relay(reader, &config.url, on_chunk)
}

/// Converts messages to wire-format items, with the working directory first when set.
pub fn message_items(messages: &[Message], config: &Config) -> Vec<Value> {
    let mut items: Vec<Value> = Vec::new();
    if let Some(dir) = &config.working_dir {
        items.push(json!({
            "role": "system",
            "content": format!("The current working directory is {dir}."),
        }));
    }
    items.extend(messages.iter().map(
        |message| json!({ "role": message.role.as_str(), "content": message.content }),
    ));
    items
}

/// Opens a streaming chat-completions request. Fails before any reply text is read.
fn open_stream(
    items: &[Value],
    config: &Config,
    disabled: &BTreeSet<String>,
) -> Result<EventReader, StrataError> {
    let agent = ureq::AgentBuilder::new()
        .timeout_read(config.read_timeout)
        .build();
    match agent
        .post(&config.url)
        .send_json(request_body(items, config, disabled))
    {
        Ok(response) => Ok(BufReader::new(response.into_reader())),
        Err(ureq::Error::Status(status, response)) => Err(StrataError::Http {
            url: config.url.clone(),
            status,
            body: response.into_string().unwrap_or_default(),
        }),
        Err(ureq::Error::Transport(transport)) if is_timeout(&transport) => Err(StrataError::Timeout {
            url: config.url.clone(),
        }),
        Err(ureq::Error::Transport(transport)) => Err(StrataError::Network {
            url: config.url.clone(),
            cause: transport.to_string(),
        }),
    }
}

/// Reads server-sent events until `[DONE]`, passing each delta to `on_chunk`.
fn relay(
    reader: impl BufRead,
    url: &str,
    on_chunk: &mut dyn FnMut(Chunk),
) -> Result<Reply, StrataError> {
    let mut content = String::new();
    let mut tool_calls: Vec<ToolCall> = Vec::new();
    for line in reader.lines() {
        let line = line.map_err(|err| io_error(url, err))?;
        let Some(data) = line.strip_prefix("data: ") else {
            continue;
        };
        if data == "[DONE]" {
            break;
        }

        let event: Value = serde_json::from_str(data).map_err(|err| StrataError::Malformed {
            url: url.to_owned(),
            reason: err.to_string(),
        })?;
        let delta = event
            .get("choices")
            .and_then(|choices| choices.get(0))
            .and_then(|choice| choice.get("delta"));
        let reasoning = delta
            .and_then(|delta| delta.get("reasoning_content"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let text = delta
            .and_then(|delta| delta.get("content"))
            .and_then(Value::as_str)
            .unwrap_or("");

        if !reasoning.is_empty() {
            on_chunk(Chunk::Reasoning(reasoning));
        }
        if !text.is_empty() {
            content.push_str(text);
            on_chunk(Chunk::Content(text));
        }
        if let Some(fragments) = delta
            .and_then(|delta| delta.get("tool_calls"))
            .and_then(Value::as_array)
        {
            for fragment in fragments {
                add_tool_call_fragment(&mut tool_calls, fragment);
            }
        }
    }
    Ok(Reply {
        content,
        tool_calls,
    })
}

/// Adds one streamed tool-call fragment to the call at its index. Fragments for a new call
/// arrive in order, so an index past the end starts a call only when it is the next one.
fn add_tool_call_fragment(tool_calls: &mut Vec<ToolCall>, fragment: &Value) {
    let index = fragment
        .get("index")
        .and_then(Value::as_u64)
        .and_then(|index| usize::try_from(index).ok());
    let Some(index) = index.filter(|index| *index <= tool_calls.len()) else {
        return;
    };
    if index == tool_calls.len() {
        tool_calls.push(ToolCall::default());
    }
    let call = &mut tool_calls[index];

    if let Some(id) = fragment.get("id").and_then(Value::as_str) {
        call.id.push_str(id);
    }
    let function = fragment.get("function");
    if let Some(name) = function.and_then(|function| function.get("name")).and_then(Value::as_str) {
        call.name.push_str(name);
    }
    if let Some(arguments) = function
        .and_then(|function| function.get("arguments"))
        .and_then(Value::as_str)
    {
        call.arguments.push_str(arguments);
    }
}

fn io_error(url: &str, err: io::Error) -> StrataError {
    if is_timeout_kind(err.kind()) {
        StrataError::Timeout {
            url: url.to_owned(),
        }
    } else {
        StrataError::Network {
            url: url.to_owned(),
            cause: err.to_string(),
        }
    }
}

fn is_timeout(transport: &ureq::Transport) -> bool {
    transport
        .source()
        .and_then(|source| source.downcast_ref::<io::Error>())
        .is_some_and(|err| is_timeout_kind(err.kind()))
}

fn is_timeout_kind(kind: io::ErrorKind) -> bool {
    matches!(kind, io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock)
}

/// Builds the chat-completions request body from wire-format items. Only tools that are not
/// in `disabled` are offered, and the `tools` key is left out when none are left.
fn request_body(items: &[Value], config: &Config, disabled: &BTreeSet<String>) -> Value {
    let offered = tools::definitions(disabled);
    let mut body = json!({
        "model": config.model,
        "messages": items,
        "stream": true,
    });
    if offered.as_array().is_some_and(|tools| !tools.is_empty()) {
        body["tools"] = offered;
    }
    body
}

/// Builds the request body for a single user message.
fn build_request(content: &str, config: &Config) -> Value {
    let message = Message {
        role: Role::User,
        content: content.to_owned(),
    };
    build_body(&[message], config)
}

/// Builds the streaming chat-completions request body from the full conversation.
fn build_body(messages: &[Message], config: &Config) -> Value {
    request_body(&message_items(messages, config), config, &BTreeSet::new())
}

/// Extracts `choices[0].message.content` from a non-streaming chat-completions response.
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
    fn build_body_puts_working_directory_first_as_system_message() {
        let config = Config {
            working_dir: Some("C:\\work".to_owned()),
            ..Config::default()
        };
        let body = build_body(&[], &config);

        assert_eq!(
            body["messages"],
            json!([{ "role": "system", "content": "The current working directory is C:\\work." }])
        );
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
