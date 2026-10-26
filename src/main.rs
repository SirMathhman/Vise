mod environment;
mod provider;
mod repl;
mod session;
mod tools;

use provider::llama_cpp::LlamaCpp;
use session::Conversation;
use std::io;

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
    let provider = LlamaCpp::new(api_key, env.cwd.clone());
    let mut conversation = Conversation::new(&env);

    let stdout = io::stdout();
    let mut output = stdout.lock();
    let mut errors = io::stderr();
    if let Err(err) = repl::run(io::stdin().lock(), &mut output, &mut errors, &provider, &mut conversation) {
        eprintln!("error: {err}");
    }
}
