use std::fmt;
use std::io::{self, BufRead, Write};

use serde::{Deserialize, Serialize};

const API_KEY: &str = "S6677k5w355Nw9ErxCZWYCMiW4ItldmzXBLUElpnLsdE8gBj5A";
const BASE_URL: &str = "http://localhost:8080";
const MODEL: &str = "RentedNoodle/Qwen3.8-27B-OrcaRouter-GSQ-RCO-IQ3_XXS-Uncensored:QATFA";
const MAX_LISTING_ENTRIES: usize = 500;

#[derive(Serialize)]
struct ChatRequest<'a> {
    model: &'a str,
    messages: Vec<Msg<'a>>,
}

#[derive(Serialize)]
struct Msg<'a> {
    role: &'a str,
    content: &'a str,
}

#[derive(Deserialize)]
struct ChatResponse {
    choices: Vec<Choice>,
}

#[derive(Deserialize)]
struct Choice {
    message: ChatMessage,
}

#[derive(Deserialize)]
struct ChatMessage {
    content: String,
}

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

#[derive(Debug)]
enum EvalError {
    Request(reqwest::Error),
    Response { status: u16, body: String },
    BadJson,
}

impl fmt::Display for EvalError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            EvalError::Request(e) => write!(f, "request failed: {e}"),
            EvalError::Response { status, body } => {
                write!(f, "server returned {status}: {body}")
            }
            EvalError::BadJson => write!(f, "server returned invalid JSON"),
        }
    }
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

fn extract_dir(reply: &str) -> Option<String> {
    let start = reply.find("read_dir(")?;
    let after_open = &reply[start + "read_dir(".len()..];
    let quote = after_open.find('"')?;
    let after_quote = &after_open[quote + 1..];
    let end = after_quote.find('"')?;
    let path = &after_quote[..end];
    if path.is_empty() {
        None
    } else {
        Some(path.to_string())
    }
}

fn format_listing(dir: &str, listing: &DirListing) -> String {
    let mut out = String::new();
    if !listing.found {
        out.push_str(&format!("Listing of \"{}\": not found\n", dir));
        return out;
    }
    let count = listing.entries.len();
    let note = if listing.truncated { " (truncated)" } else { "" };
    out.push_str(&format!("Listing of \"{}\" ({} entries{})\n", dir, count, note));
    for e in &listing.entries {
        match e.kind {
            EntryKind::Dir => out.push_str(&format!("- {}\n", e.name)),
            EntryKind::File => out.push_str(&format!("- {} ({} bytes)\n", e.name, e.size)),
        }
    }
    out
}

struct Evaluator {
    history: Vec<(String, String)>, // (role, content)
    cwd: String,
}

impl Evaluator {
    fn new(cwd: String) -> Self {
        Self { history: vec![], cwd }
    }

    fn eval(&mut self, client: &reqwest::blocking::Client, input: &str) -> Result<String, EvalError> {
        self.history.push(("user".into(), input.into()));

        loop {
            let reply = self.send_turn(client)?;
            match extract_dir(&reply) {
                Some(path) => {
                    let listing = read_dir(&path, std::path::Path::new(&self.cwd));
                    let text = format_listing(&path, &listing);
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
             read_dir(\"<path>\") where <path> is relative to the working directory.",
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

fn main() {
    let client = reqwest::blocking::Client::new();
    let stdin = io::stdin();
    let mut stdout = io::stdout();
    let mut line = String::new();
    let cwd = std::env::current_dir()
        .map(|p| p.display().to_string())
        .unwrap_or_default();
    let mut evaluator = Evaluator::new(cwd);

    loop {
        print!("> ");
        stdout.flush().expect("failed to flush stdout");

        match stdin.lock().read_line(&mut line) {
            Ok(0) => break, // EOF
            Ok(_) => {
                let input = line.trim();
                if input == "/exit" {
                    break;
                }
                if !input.is_empty() {
                    match evaluator.eval(&client, input) {
                        Ok(result) => println!("{result}"),
                        Err(e) => eprintln!("error: {e}"),
                    }
                }
                line.clear();
            }
            Err(_) => break,
        }
    }
}
