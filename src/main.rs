mod session;
mod strata;

use std::io::{self, BufRead, Write};

use session::Session;
use strata::Role;

fn main() -> io::Result<()> {
    let config = strata::Config::default();
    let mut session = Session::new();
    let mut input = io::stdin().lock();

    println!("Strata REPL ready. Type 'exit' or press Ctrl+C to quit. Type '/new' to start over.");

    loop {
        print!("> ");
        io::stdout().flush()?;

        let mut line = String::new();
        if input.read_line(&mut line)? == 0 {
            break;
        }

        let trimmed = line.trim();
        if trimmed == "exit" || trimmed == "quit" {
            break;
        }
        if trimmed.is_empty() {
            continue;
        }
        if trimmed == "/new" {
            session.reset();
            println!("Started a new conversation.");
            continue;
        }

        session.push(Role::User, trimmed.to_owned());
        match strata::send_message(session.messages(), &config) {
            Ok(reply) => {
                println!("{reply}");
                session.push(Role::Assistant, reply);
            }
            Err(err) => {
                session.pop();
                eprintln!("{err}");
            }
        }
    }

    println!("bye");
    Ok(())
}
