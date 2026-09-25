use crate::client::{ChatRequest, ChatResponse, MODEL, API_KEY, BASE_URL, Msg};
use crate::error::EvalError;
use crate::tools;

const CHARS_PER_TOKEN: f64 = 4.0;
/// Fraction of the context window at which compaction fires automatically.
const COMPACTION_THRESHOLD: f64 = 0.8;
/// Number of trailing messages kept verbatim after compaction.
const KEEP_RECENT: usize = 4;

enum ToolCall {
    ReadDir(String),
    ReadFile(String),
    CreateDir(String),
}

fn extract_tool(reply: &str) -> Option<ToolCall> {
    // Find the earliest-occurring tool marker in the reply. Markers are
    // distinct (none is a substring of another), so this is unambiguous.
    let markers: [&str; 3] = ["read_dir(", "read_file(", "create_dir("];
    let mut best: Option<(usize, &str)> = None;
    for marker in markers {
        if let Some(pos) = reply.find(marker)
            && best.as_ref().map(|(p, _)| pos < *p).unwrap_or(true)
        {
            best = Some((pos, marker));
        }
    }
    let (start, marker) = best?;
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
        "read_file(" => Some(ToolCall::ReadFile(path)),
        _ => Some(ToolCall::CreateDir(path)),
    }
}

pub struct Evaluator {
    history: Vec<(String, String)>, // (role, content)
    cwd: String,
    summary: String, // running summary of compacted (older) context; empty when none
}

impl Evaluator {
    pub fn new(cwd: String) -> Self {
        Self {
            history: vec![],
            cwd,
            summary: String::new(),
        }
    }

    pub fn context_used(&self) -> usize {
        let mut chars = self.system_prompt().chars().count();
        for (_, content) in &self.history {
            chars += content.chars().count();
        }
        (chars as f64 / CHARS_PER_TOKEN) as usize
    }

    /// Returns `true` once context usage has crossed the compaction threshold.
    pub fn should_compact(&self) -> bool {
        (self.context_used() as f64)
            >= (crate::client::CONTEXT_WINDOW as f64) * COMPACTION_THRESHOLD
    }

    /// Compresses the older portion of the history into a running summary,
    /// keeping the trailing `KEEP_RECENT` messages verbatim.
    pub fn compact(&mut self, client: &reqwest::blocking::Client) -> Result<(), EvalError> {
        if self.history.len() <= KEEP_RECENT {
            return Ok(());
        }
        let split = self.history.len() - KEEP_RECENT;
        let older: Vec<Msg> = self.history[..split]
            .iter()
            .map(|(role, content)| Msg {
                role: role.as_str(),
                content: content.as_str(),
            })
            .collect();
        let system_content = if self.summary.is_empty() {
            "You are a conversation summarizer. Produce a single concise summary of the \
             conversation below that preserves the key facts, decisions, file paths, \
             code, and current state so the conversation can continue without the \
             original messages."
                .to_string()
        } else {
            format!(
                "You are a conversation summarizer. An earlier summary of this \
                 conversation is provided below, followed by newer messages. Produce a \
                 single updated summary that incorporates the existing summary and the \
                 new messages, preserving the key facts, decisions, file paths, code, \
                 and current state so the conversation can continue without the original \
                 messages.\n\nExisting summary:\n{}",
                self.summary
            )
        };
        let mut messages: Vec<Msg> = vec![Msg {
            role: "system",
            content: &system_content,
        }];
        messages.extend(older);
        messages.push(Msg {
            role: "user",
            content: "Summarize this conversation.",
        });
        let body = ChatRequest { model: MODEL, messages };
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
        let summary = resp
            .choices
            .first()
            .map(|c| c.message.content.clone())
            .unwrap_or_default();
        if summary.trim().is_empty() {
            return Err(EvalError::Response {
                status: 200,
                body: "empty summary".into(),
            });
        }
        self.summary = summary;
        self.history = self.history[split..].to_vec();
        Ok(())
    }

    fn system_prompt(&self) -> String {
        let base = format!(
            "You are an agent running in a terminal. Your current working directory is: {}. \
             If you need to read a directory's contents, respond with a line containing \
             read_dir(\"<path>\"). If you need to read a file's contents, respond with a \
             line containing read_file(\"<path>\"). If you need to create a directory, \
             respond with a line containing create_dir(\"<path>\"). In all cases <path> \
             is relative to the working directory.",
            self.cwd
        );
        if self.summary.is_empty() {
            base
        } else {
            format!(
                "{}\n\nEarlier in this conversation, here is a summary of what happened:\n{}",
                base, self.summary
            )
        }
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
                Some(ToolCall::CreateDir(path)) => {
                    let result = tools::create_dir(&path, std::path::Path::new(&self.cwd));
                    let text = tools::format_create_dir(&path, &result);
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
