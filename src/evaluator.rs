use std::io::Read;

use serde::Deserialize;

use crate::client::{ChatRequest, ChatResponse, MODEL, API_KEY, BASE_URL, Msg};
use crate::error::EvalError;

const MAX_LISTING_ENTRIES: usize = 500;
const MAX_FILE_BYTES: usize = 32 * 1024; // 32 KiB

#[derive(Deserialize)]
struct DirListing {
    entries: Vec<DirEntry>,
    found: bool,
    truncated: bool,
}

#[derive(Deserialize)]
struct DirEntry {
    name: String,
    size: u64,
    kind: EntryKind,
}

#[derive(Deserialize)]
enum EntryKind {
    File,
    Dir,
}

#[derive(Deserialize)]
struct FileContent {
    content: String,
    truncated: bool,
    error: Option<String>,
}

fn read_dir(path: &str, base: &std::path::Path) -> DirListing {
    let dir_path = base.join(path);
    let mut entries: Vec<DirEntry> = Vec::new();
    let mut found = false;
    let mut truncated = false;

    if let Ok(dir) = std::fs::read_dir(&dir_path) {
        found = true;
        for entry in dir {
            match entry {
                Ok(entry) => {
                    let name = entry.file_name().to_string_lossy().into_owned();
                    let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                    let kind = match entry.file_type() {
                        Ok(t) if t.is_dir() => EntryKind::Dir,
                        _ => EntryKind::File,
                    };
                    entries.push(DirEntry { name, size, kind });
                }
                Err(_) => continue,
            }
            if entries.len() >= MAX_LISTING_ENTRIES {
                truncated = true;
                break;
            }
        }
    }

    DirListing { entries, found, truncated }
}

fn read_file(path: &str, base: &std::path::Path) -> FileContent {
    let file_path = base.join(path);
    let mut content = String::new();
    let mut truncated = false;
    let mut error: Option<String> = None;

    match std::fs::metadata(&file_path) {
        Ok(meta) => {
            if !meta.is_file() {
                error = Some("not a file".to_string());
            } else {
                let size = meta.len();
                match std::fs::File::open(&file_path) {
                    Ok(mut f) => {
                        let mut buf = vec![0u8; MAX_FILE_BYTES + 1];
                        match f.read(&mut buf) {
                            Ok(n) => {
                                truncated = size > MAX_FILE_BYTES as u64;
                                let head = &buf[..n.min(MAX_FILE_BYTES)];
                                content = String::from_utf8_lossy(head).into_owned();
                            }
                            Err(_) => error = Some("could not read".to_string()),
                        }
                    }
                    Err(_) => error = Some("could not open".to_string()),
                }
            }
        }
        Err(_) => error = Some("not found".to_string()),
    }

    FileContent { content, truncated, error }
}

fn format_listing(dir: &str, listing: &DirListing) -> String {
    let mut out = String::new();
    if !listing.found {
        out.push_str(&format!("Listing of \"{}\": not found\n", dir));
        return out;
    }
    let count = listing.entries.len();
    let note = if listing.truncated { " (truncated)" } else { "" };
    out.push_str(&format!(
        "Listing of \"{}\" ({} entries{})\n",
        dir, count, note
    ));
    for e in &listing.entries {
        match e.kind {
            EntryKind::Dir => out.push_str(&format!("- {}\n", e.name)),
            EntryKind::File => out.push_str(&format!("- {} ({} bytes)\n", e.name, e.size)),
        }
    }
    out
}

fn format_file(path: &str, file: &FileContent) -> String {
    match &file.error {
        Some(e) => return format!("File \"{}\": {}\n", path, e),
        None => {}
    }
    let note = if file.truncated { " (truncated)" } else { "" };
    format!(
        "Contents of \"{}\" ({} bytes{})\n{}\n",
        path,
        file.content.len(),
        note,
        file.content
    )
}

enum ToolCall {
    ReadDir(String),
    ReadFile(String),
}

fn extract_tool(reply: &str) -> Option<ToolCall> {
    let dir_pos = reply.find("read_dir(");
    let file_pos = reply.find("read_file(");
    let marker = match (dir_pos, file_pos) {
        (Some(d), Some(f)) => {
            if f < d {
                "read_file("
            } else {
                "read_dir("
            }
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
                    let listing = read_dir(&path, std::path::Path::new(&self.cwd));
                    let text = format_listing(&path, &listing);
                    self.history.push(("assistant".into(), reply));
                    self.history.push(("user".into(), text));
                }
                Some(ToolCall::ReadFile(path)) => {
                    let file = read_file(&path, std::path::Path::new(&self.cwd));
                    let text = format_file(&path, &file);
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
        let system = format!(
            "You are an agent running in a terminal. Your current working directory is: {}. \
             If you need to read a directory's contents, respond with a line containing \
             read_dir(\"<path>\"). If you need to read a file's contents, respond with a \
             line containing read_file(\"<path>\"). In both cases <path> is relative to the \
             working directory.",
            self.cwd
        );
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
