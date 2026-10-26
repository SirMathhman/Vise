use crate::provider::Provider;
use crate::session::Conversation;
use std::io::{self, BufRead, Write};

pub fn run(
    input: impl BufRead,
    output: &mut impl Write,
    errors: &mut impl Write,
    provider: &dyn Provider,
    conversation: &mut Conversation,
) -> io::Result<()> {
    for line in input.lines() {
        let line = match line {
            Ok(line) => line,
            Err(err) => {
                writeln!(errors, "error: failed to read from stdin: {err}")?;
                break;
            }
        };
        if matches!(line.trim(), "exit" | "quit") {
            break;
        }
        match provider.complete(conversation.messages(), line) {
            Ok(turn) => {
                writeln!(output, "{}", turn.reply())?;
                conversation.commit(turn);
            }
            Err(err) => writeln!(errors, "error: {err}")?,
        }
    }
    Ok(())
}
