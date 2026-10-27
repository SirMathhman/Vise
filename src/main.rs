mod environment;
mod error;
mod provider;
mod repl;
mod session;
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
    let provider = LlamaCpp::new(api_key);
    let tools = WorkspaceTools::new(env.cwd.clone());
    let mut conversation = Conversation::new(&env);

    let stdout = io::stdout();
    let mut output = stdout.lock();
    let mut errors = io::stderr();
    let mut input = io::stdin().lock();
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
}
