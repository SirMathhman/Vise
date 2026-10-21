mod session;
mod strata;
mod web;

use std::io::{self, BufRead, Write};

use session::Session;
use strata::{Chunk, Role};

/// Reads the working directory once at startup, for both the REPL and the web server.
fn startup_config() -> strata::Config {
    let working_dir = match std::env::current_dir() {
        Ok(dir) => Some(dir.display().to_string()),
        Err(err) => {
            eprintln!("warning: could not read the working directory: {err}");
            None
        }
    };
    strata::Config {
        working_dir,
        ..strata::Config::default()
    }
}

fn main() -> io::Result<()> {
    let config = startup_config();
    if std::env::args().nth(1).as_deref() == Some("web") {
        return web::serve(web::DEFAULT_PORT, config);
    }

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
        let mut in_reasoning = None;
        let result = strata::send_message(session.messages(), &config, &mut |chunk| {
            let reasoning = matches!(chunk, Chunk::Reasoning(_));
            if in_reasoning != Some(reasoning) {
                if in_reasoning.is_some() {
                    println!();
                }
                print!("{}", if reasoning { "[thinking] " } else { "" });
                in_reasoning = Some(reasoning);
            }
            let text = match chunk {
                Chunk::Reasoning(text) | Chunk::Content(text) => text,
            };
            print!("{text}");
            let _ = io::stdout().flush();
        });
        println!();
        match result {
            Ok(reply) => session.push(Role::Assistant, reply),
            Err(err) => {
                session.pop();
                eprintln!("{err}");
            }
        }
    }

    println!("bye");
    Ok(())
}
