use std::io::{self, BufRead, Write};

#[derive(Debug)]
enum EvalError {
    // Real variants (ParseError, TypeError, etc.) land here as eval grows.
    #[allow(dead_code)]
    Placeholder,
}

fn main() {
    let stdin = io::stdin();
    let mut stdout = io::stdout();
    let mut line = String::new();

    loop {
        print!("> ");
        stdout.flush().expect("failed to flush stdout");

        match stdin.lock().read_line(&mut line) {
            Ok(0) => break, // EOF
            Ok(_) => {
                let input = line.trim();
                if input == "/exit" {
                    break;
                }
                match eval(input) {
                    Ok(result) => println!("{result}"),
                    Err(e) => eprintln!("error: {e:?}"),
                }
                line.clear();
            }
            Err(_) => break,
        }
    }
}

/// Stub evaluator: echoes the input back.
fn eval(input: &str) -> Result<String, EvalError> {
    Ok(input.to_string())
}
