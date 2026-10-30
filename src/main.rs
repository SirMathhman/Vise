mod after_turn;
mod before_turn;
mod commands;
mod default_model;
mod environment;
mod error;
mod file_commands;
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
mod tools;
mod turn;

use provider::llama_cpp::LlamaCpp;
use provider::types::Provider;
use session::Conversation;
use std::io::{self, IsTerminal, Write};
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
    conversation.enable_autosave(sessions.clone());

    let stdout = io::stdout();
    let mut output = stdout.lock();
    let mut errors = style::Errors::new(io::stderr(), style::allowed(io::stderr().is_terminal()));
    match saved_sessions::import(&sessions) {
        Ok(0) => {}
        Ok(imported) => {
            let _ = writeln!(errors, "imported {imported} session files into {}", sessions.join(saved_sessions::DATABASE).display());
        }
        Err(err) => {
            let _ = writeln!(errors, "error: cannot import the session files: {err}");
        }
    }
    // `--new` starts an empty conversation instead of resuming the last session.
    let resuming = !std::env::args().skip(1).any(|arg| arg == "--new");
    match resuming.then(|| saved_sessions::latest(&sessions)).unwrap_or(Ok(None)).and_then(|name| match name {
        Some(name) => saved_sessions::resume(&sessions, &name).map(|(history, requests)| Some((name, history, requests))),
        None => Ok(None),
    }) {
        Ok(Some((name, history, requests))) => {
            conversation.resume(name.clone(), history, requests);
            let _ = writeln!(errors, "resumed session {name}");
        }
        Ok(None) => {}
        Err(err) => {
            let _ = writeln!(errors, "error: the last session is not resumed: {err}");
        }
    }
    let mut input = io::stdin().lock();
    match default_model::load() {
        Ok(Some(name)) => {
            if let Err(err) = provider.set_model(&name) {
                let _ = writeln!(errors, "error: the saved default model is not used: {err}");
            }
        }
        Ok(None) => {}
        Err(err) => {
            let _ = writeln!(errors, "error: cannot read model.txt: {err}");
        }
    }
    match before_turn::load(&env.cwd, &mut errors) {
        Ok(Some(commands)) => conversation.set_before_turn(commands),
        Ok(None) => {}
        Err(err) => {
            let _ = writeln!(errors, "error: {err}");
        }
    }
    match after_turn::load(&env.cwd, &mut errors) {
        Ok(Some(commands)) => conversation.set_after_turn(commands),
        Ok(None) => {}
        Err(err) => {
            let _ = writeln!(errors, "error: {err}");
        }
    }
    match interrupt::work(|| startup::run(&env.cwd, &tools, &mut output, &mut errors)) {
        Ok(Ok(Some(text))) => conversation.set_startup(text),
        Ok(Ok(None)) => {}
        Ok(Err(err)) => {
            let _ = writeln!(errors, "error: {err}");
        }
        Err(_) => {
            let _ = writeln!(errors, "the startup commands were stopped");
        }
    }
    if let Err(err) = repl::run(
        &mut input,
        &mut output,
        &mut errors,
        &provider,
        &tools,
        &mut conversation,
        &sessions,
    ) {
        let _ = writeln!(errors, "error: {err}");
    }
    let profile_shutdown = conversation.profile_hooks().shutdown.clone();
    // The shutdown lines run outside `work`, so a Ctrl+C during them quits at once rather than waiting them out.
    if let Err(err) = shutdown::run_with_profile(&env.cwd, &profile_shutdown, &tools, &mut output, &mut errors) {
        let _ = writeln!(errors, "error: {err}");
    }
}
