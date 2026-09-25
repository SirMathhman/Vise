use crate::client::{ChatRequest, ChatResponse, MODEL, API_KEY, BASE_URL, Msg};
use crate::error::EvalError;
use crate::tools;

const CHARS_PER_TOKEN: f64 = 4.0;

enum ToolCall {
    ReadDir(String),
    ReadFile(String),
}

fn extract_tool(reply: &str) -> Option<ToolCall> {
    let dir_pos = reply.find("read_dir(");
    let file_pos = reply.find("read_file(");
    let marker = match (dir_pos, file_pos) {
        (Some(d), Some(f)) => {
            if f < d { "read_file(" } else { "read_dir(" }
        }
        (Some(_), None) => "read_dir(",
        (None, Some(_)) => "read_file(",
        (None, None) => return None,
    };
    let start = reply.find(marker).unwrap();
    let after_open = &reply[start + marker.len()..];
    let quote = after_open.find('"')?;
    let after_quote = &after_open[quote + 1..];
    let end = after_quote.find('"')?;
    let path = after_quote[..end].to_string();
    if path.is_empty() {
        return None;
    }
    match marker {
        "read_dir(" => Some(ToolCall::ReadDir(path)),
        _ => Some(ToolCall::ReadFile(path)),
    }
}

pub struct Evaluator {
    history: Vec<(String, String)>, // (role, content)
    cwd: String,
}

impl Evaluator {
    pub fn new(cwd: String) -> Self {
        Self {
            history: vec![],
            cwd,
        }
    }

    pub fn context_used(&self) -> usize {
        let mut chars = self.system_prompt().len();
        for (_, content) in &self.history {
            chars += content.len();
        }
        (chars as f64 / CHARS_PER_TOKEN) as usize
    }

    fn system_prompt(&self) -> String {
        format!(
            "You are an agent running in a terminal. Your current working directory is: {}. \
             If you need to read a directory's contents, respond with a line containing \
             read_dir(\"<path>\"). If you need to read a file's contents, respond with a \
             line containing read_file(\"<path>\"). In both cases <path> is relative to the \
             working directory.",
            self.cwd
        )
    }

    pub fn eval(
        &mut self,
        client: &reqwest::blocking::Client,
        input: &str,
    ) -> Result<String, EvalError> {
        self.history.push(("user".into(), input.into()));

        loop {
            let reply = self.send_turn(client)?;
            match extract_tool(&reply) {
                Some(ToolCall::ReadDir(path)) => {
                    let listing = tools::read_dir(&path, std::path::Path::new(&self.cwd));
                    let text = tools::format_listing(&path, &listing);
                    self.history.push(("assistant".into(), reply));
                    self.history.push(("user".into(), text));
                }
                Some(ToolCall::ReadFile(path)) => {
                    let file = tools::read_file(&path, std::path::Path::new(&self.cwd));
                    let text = tools::format_file(&path, &file);
                    self.history.push(("assistant".into(), reply));
                    self.history.push(("user".into(), text));
                }
                None => {
                    self.history.push(("assistant".into(), reply.clone()));
                    return Ok(reply);
                }
            }
        }
    }

    fn send_turn(&self, client: &reqwest::blocking::Client) -> Result<String, EvalError> {
        let system = self.system_prompt();
        let mut messages: Vec<Msg> = vec![Msg {
            role: "system",
            content: &system,
        }];
        messages.extend(
            self.history
                .iter()
                .map(|(role, content)| Msg { role, content }),
        );
        let body = ChatRequest {
            model: MODEL,
            messages,
        };

        let resp = client
            .post(format!("{BASE_URL}/v1/chat/completions"))
            .header("Authorization", format!("Bearer {API_KEY}"))
            .json(&body)
            .send()
            .map_err(EvalError::Request)?;

        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let body = resp.text().unwrap_or_default();
            return Err(EvalError::Response { status, body });
        }

        let resp: ChatResponse = resp.json().map_err(|_| EvalError::BadJson)?;

        let reply = resp
            .choices
            .first()
            .map(|c| c.message.content.clone())
            .unwrap_or_default();
        Ok(reply)
    }
}
