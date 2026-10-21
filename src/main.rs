mod agent;
mod commands;
mod session;
mod strata;
mod tools;
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

#[derive(PartialEq, Clone, Copy)]
enum Section {
    Thinking,
    Answer,
}

/// Prints streamed reasoning and answer text, labeling each section as it starts.
fn print_chunk(chunk: Chunk, section: &mut Option<Section>) {
    let (next, text) = match chunk {
        Chunk::Reasoning(text) => (Section::Thinking, text),
        Chunk::Content(text) => (Section::Answer, text),
        Chunk::Tool(text) => {
            if section.is_some() {
                println!();
            }
            println!("[tool] {text}");
            *section = None;
            return;
        }
    };
    if *section != Some(next) {
        if section.is_some() {
            println!();
        }
        if next == Section::Thinking {
            print!("[thinking] ");
        }
        *section = Some(next);
    }
    print!("{text}");
    let _ = io::stdout().flush();
}

fn main() -> io::Result<()> {
    let config = startup_config();
    let switches = tools::Switches::default();
    if std::env::args().nth(1).as_deref() == Some("web") {
        return web::serve(web::DEFAULT_PORT, config, switches);
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
        if let Some(output) = commands::handle(trimmed, &switches) {
            println!("{output}");
            continue;
        }

        session.push(Role::User, trimmed.to_owned());
        let mut section = None;
        let result = agent::run_turn(session.messages(), &config, &switches, &mut |chunk| {
            print_chunk(chunk, &mut section)
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
