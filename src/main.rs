mod agent;
mod commands;
mod compaction;
mod grammar;
mod notes;
mod session;
mod strata;
mod tools;
mod web;
mod workspace;

use std::io::{self, BufRead, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

/// Set while a turn runs, so Ctrl+C stops the turn instead of quitting.
static TURN_ACTIVE: AtomicBool = AtomicBool::new(false);
/// Set by Ctrl+C during a turn; the turn checks it and stops.
static STOP: AtomicBool = AtomicBool::new(false);

use session::Session;
use agent::TurnError;
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
    let config = strata::Config {
        working_dir,
        ..strata::Config::default()
    };
    // Lazy grammars keep prose unconstrained while a tool is off; older Strata builds get the full grammar.
    let lazy_grammar = strata::supports_lazy_grammar(&config);
    strata::Config { lazy_grammar, ..config }
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
    if std::env::args().nth(1).as_deref() == Some("web") {
        return web::serve(web::DEFAULT_PORT, config);   // each browser tab has its own switches (web::Sessions)
    }
    let switches = tools::Switches::default();   // the REPL is one session: its own process and switches
    // Ctrl+C stops a running turn; at the prompt, or on a second Ctrl+C, it quits as before.
    if let Err(err) = ctrlc::set_handler(|| {
        if TURN_ACTIVE.load(Ordering::SeqCst) && !STOP.swap(true, Ordering::SeqCst) {
            return;
        }
        std::process::exit(0);
    }) {
        eprintln!("warning: Ctrl+C cannot stop a turn: {err}");
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
        let root = config.working_dir.as_deref().map(Path::new);
        if let Some(output) = commands::handle(trimmed, &switches).or_else(|| notes::command(trimmed, root)) {
            println!("{output}");
            continue;
        }

        let now = switches.snapshot();
        let text = if session.messages().is_empty() {
            notes::with_index(trimmed, root)
        } else {
            trimmed.to_owned()
        };
        session.push(Role::User, tools::note_changes(&text, session.told(), &now));
        let mut section = None;
        STOP.store(false, Ordering::SeqCst);
        TURN_ACTIVE.store(true, Ordering::SeqCst);
        let result = agent::run_turn(session.messages(), &config, &switches, &STOP, &mut |chunk| {
            print_chunk(chunk, &mut section)
        });
        TURN_ACTIVE.store(false, Ordering::SeqCst);
        println!();
        match result {
            Err(err) => {
                session.pop();   // a turn that did not finish is not kept
                match &err {
                    TurnError::Stopped { .. } => println!("[stopped]"),
                    TurnError::Failed { .. } => eprintln!("{err}"),
                }
                let ran = err.ran();
                if !ran.is_empty() {
                    println!("{} tool call(s) ran before this, and their effects remain: {}", ran.len(), ran.join("; "));
                }
            }
            Ok(reply) => {
                session.push(Role::Assistant, reply);
                session.set_told(now);
                if let Some(entry) = compaction::after_turn(session.messages(), &config) {
                    if matches!(entry.role, Role::SummaryFailed) {
                        eprintln!("warning: could not summarize the conversation: {}", entry.content);
                    }
                    session.push(entry.role, entry.content);
                }
            }
        }
    }

    println!("bye");
    Ok(())
}
