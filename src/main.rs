mod after_turn;
mod before_turn;
mod commands;
mod environment;
mod error;
mod file_commands;
mod notes;
mod profile;
mod provider;
mod render;
mod repl;
mod saved_sessions;
mod session;
mod shutdown;
mod startup;
mod tools;

use provider::llama_cpp::LlamaCpp;
use session::Conversation;
use std::io::{self, Write};
use tools::runner::WorkspaceTools;

/// Writes a fatal message to stderr and exits with status 1. If stderr is closed the message is lost,
/// but the exit status still reports the failure.
fn exit_with(message: &str) -> ! {
    let _ = writeln!(io::stderr(), "{message}");
    std::process::exit(1)
}

fn main() {
    dotenvy::dotenv().ok();
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
    conversation.enable_autosave(std::path::PathBuf::from(saved_sessions::FOLDER));

    let stdout = io::stdout();
    let mut output = stdout.lock();
    let mut errors = io::stderr();
    let mut input = io::stdin().lock();
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
    match startup::run(&env.cwd, &tools, &mut output, &mut errors) {
        Ok(Some(text)) => conversation.set_startup(text),
        Ok(None) => {}
        Err(err) => {
            let _ = writeln!(errors, "error: {err}");
        }
    }
    if let Err(err) = repl::run(
        &mut input,
        &mut output,
        &mut errors,
        &provider,
        &tools,
        &mut conversation,
    ) {
        let _ = writeln!(errors, "error: {err}");
    }
    let profile_shutdown = conversation.profile_hooks().shutdown.clone();
    if let Err(err) = shutdown::run_with_profile(&env.cwd, &profile_shutdown, &tools, &mut output, &mut errors) {
        let _ = writeln!(errors, "error: {err}");
    }
}
