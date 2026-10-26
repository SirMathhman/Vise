mod provider;
mod environment;
mod session;
mod tools;

use session::{Conversation, Role};
use std::io::{self, BufRead};

fn main() {
    dotenvy::dotenv().ok();
    let api_key = std::env::var("LLAMA_API_KEY").unwrap_or_else(|_| {
        eprintln!("LLAMA_API_KEY is not set; add it to .env");
        std::process::exit(1);
    });

    let env = environment::gather().unwrap_or_else(|err| {
        eprintln!("error: cannot read current directory: {err}");
        std::process::exit(1);
    });
    let mut conversation = Conversation::new(&env);

    for line in io::stdin().lock().lines() {
        let Ok(line) = line else {
            eprintln!("error: failed to read from stdin");
            break;
        };
        if matches!(line.trim(), "exit" | "quit") {
            break;
        }
        conversation.push(Role::User, line);
        match provider::llama_cpp::complete(&api_key, conversation.messages(), &env.cwd) {
            Ok(reply) => {
                println!("{reply}");
                conversation.push(Role::Assistant, reply);
            }
            Err(err) => {
                eprintln!("error: {err}");
                conversation.pop_last();
            }
        }
    }
}
