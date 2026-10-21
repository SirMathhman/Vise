mod strata;

use std::io::{self, BufRead, Write};

fn main() -> io::Result<()> {
    let config = strata::Config::default();
    let mut input = io::stdin().lock();

    println!("Strata REPL ready. Type 'exit' or press Ctrl+C to quit.");

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

        match strata::send_message(trimmed, &config) {
            Ok(reply) => println!("{reply}"),
            Err(err) => eprintln!("{err}"),
        }
    }

    println!("bye");
    Ok(())
}
