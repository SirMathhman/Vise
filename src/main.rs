mod chat;

use chat::{Message, complete};
use std::io::{self, BufRead};

fn main() {
    dotenvy::dotenv().ok();
    let api_key = std::env::var("LLAMA_API_KEY").unwrap_or_else(|_| {
        eprintln!("LLAMA_API_KEY is not set; add it to .env");
        std::process::exit(1);
    });

    let cwd = std::env::current_dir().unwrap_or_else(|err| {
        eprintln!("error: cannot read current directory: {err}");
        std::process::exit(1);
    });
    let mut history = vec![Message {
        role: "system".into(),
        content: format!("Current working directory: {}", cwd.display()),
    }];
    for line in io::stdin().lock().lines() {
        let Ok(line) = line else {
            eprintln!("error: failed to read from stdin");
            break;
        };
        if matches!(line.trim(), "exit" | "quit") {
            break;
        }
        history.push(Message { role: "user".into(), content: line });
        match complete(&api_key, &history) {
            Ok(reply) => {
                println!("{reply}");
                history.push(Message { role: "assistant".into(), content: reply });
            }
            Err(err) => {
                eprintln!("error: {err}");
                history.pop();
            }
        }
    }
}
