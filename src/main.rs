use std::fmt;
use std::io::{self, BufRead, Write};

use serde::{Deserialize, Serialize};

const API_KEY: &str = "S6677k5w355Nw9ErxCZWYCMiW4ItldmzXBLUElpnLsdE8gBj5A";
const BASE_URL: &str = "http://localhost:8080";
const MODEL: &str = "RentedNoodle/Qwen3.8-27B-OrcaRouter-GSQ-RCO-IQ3_XXS-Uncensored:QATFA";

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

        let system = format!(
            "You are an agent running in a terminal. Your current working directory is: {}",
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
        self.history.push(("assistant".into(), reply.clone()));
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
