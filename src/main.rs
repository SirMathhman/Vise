mod after_turn;
mod before_turn;
mod commands;
mod default_model;
mod engine;
mod environment;
mod error;
mod file_commands;
mod frontend;
mod interrupt;
mod notes;
mod profile;
mod provider;
mod render;
mod repl;
mod saved_sessions;
mod session;
mod subagent;
mod shutdown;
mod startup;
mod style;
mod terminal;
mod tools;
mod turn;

use engine::Engine;
use provider::llama_cpp::LlamaCpp;
use session::Conversation;
use std::io::{self, IsTerminal, Write};
use terminal::TerminalFrontend;
use tools::runner::WorkspaceTools;

/// Writes a fatal message to stderr and exits with status 1. If stderr is closed the message is lost,
/// but the exit status still reports the failure.
fn exit_with(message: &str) -> ! {
    let _ = writeln!(io::stderr(), "{message}");
    std::process::exit(1)
}

fn main() {
    dotenvy::dotenv().ok();
    style::enable_stdout(io::stdout().is_terminal());
    // Installed first, so Ctrl+C during a slow start stops the process as it always did.
    if let Err(err) = interrupt::install() {
        exit_with(&format!("error: cannot handle Ctrl+C: {err}"));
    }
    let api_key = std::env::var("LLAMA_API_KEY")
        .unwrap_or_else(|_| exit_with("LLAMA_API_KEY is not set; add it to .env"));

    let env = environment::gather()
        .unwrap_or_else(|err| exit_with(&format!("error: cannot read current directory: {err}")));
    if let Err(err) = environment::instructions(&env.cwd) {
        exit_with(&format!("error: {err}"));
    }
    let provider = LlamaCpp::new(api_key);
    let tools = WorkspaceTools::new(env.cwd.clone());
    let mut conversation = Conversation::new(&env);
    let sessions = std::path::PathBuf::from(saved_sessions::FOLDER);
    conversation.enable_autosave();

    let stdout = io::stdout();
    let mut output = stdout.lock();
    let mut errors = style::Errors::new(io::stderr(), style::allowed(io::stderr().is_terminal()));
    let mut input = io::stdin().lock();
    // `--new` starts an empty conversation instead of resuming the last session.
    let resume = !std::env::args().skip(1).any(|arg| arg == "--new");
    let mut engine = Engine::new(&provider, &tools, &mut conversation, &sessions);
    {
        let mut ui = TerminalFrontend::new(&mut input, &mut output, &mut errors);
        engine.start(&env.cwd, resume, &mut ui);
    }
    if let Err(err) = repl::run_engine(&mut engine, &mut input, &mut output, &mut errors) {
        let _ = writeln!(errors, "error: {err}");
    }
    let mut ui = TerminalFrontend::new(&mut input, &mut output, &mut errors);
    engine.shutdown(&env.cwd, &mut ui);
}
