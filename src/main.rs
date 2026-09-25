use std::io::{self, BufRead, Write};

mod client;
mod evaluator;
mod error;
mod tools;

use client::CONTEXT_WINDOW;
use evaluator::Evaluator;

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
                if input == "/context" {
                    let used = evaluator.context_used();
                    println!("Context: {used} / {CONTEXT_WINDOW} tokens");
                    line.clear();
                    continue;
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
