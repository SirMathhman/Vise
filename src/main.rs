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
    Io(std::io::Error),
    Request(reqwest::Error),
}

fn main() {
    let client = reqwest::blocking::Client::new();
    let stdin = io::stdin();
    let mut stdout = io::stdout();
    let mut line = String::new();

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
                match eval(&client, input) {
                    Ok(result) => println!("{result}"),
                    Err(e) => eprintln!("error: {e:?}"),
                }
                line.clear();
            }
            Err(_) => break,
        }
    }
}

fn eval(client: &reqwest::blocking::Client, input: &str) -> Result<String, EvalError> {
    let body = ChatRequest {
        model: MODEL,
        messages: vec![Msg {
            role: "user",
            content: input,
        }],
    };

    let resp: ChatResponse = client
        .post(format!("{BASE_URL}/v1/chat/completions"))
        .header("Authorization", format!("Bearer {API_KEY}"))
        .json(&body)
        .send()
        .map_err(EvalError::Request)?
        .json()
        .map_err(|_| EvalError::Io(io::Error::new(io::ErrorKind::Other, "bad JSON response")))?;

    Ok(resp
        .choices
        .first()
        .map(|c| c.message.content.clone())
        .unwrap_or_default())
}
