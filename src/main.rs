use std::io::{self, BufRead};

fn main() {
    for line in io::stdin().lock().lines() {
        let line = line.expect("failed to read from stdin");
        match line.trim() {
            "exit" | "quit" => break,
            _ => println!("{line}"),
        }
    }
}
