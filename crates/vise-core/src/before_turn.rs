//! Before-turn commands: each line of `before-turn.txt` in the working directory is a PowerShell command, run before
//! every turn. The file is read once at launch, so a change to it takes effect at the next launch. Their output goes to
//! the model with that turn's message.

use crate::file_commands::{read_lines, run_lines};
use crate::frontend::Frontend;
use crate::tools::runner::BEFORE_TURN_FILE;
use crate::tools::types::ToolRunner;
use std::path::Path;

/// Reads the before-turn lines at launch. Returns `None` when there is no before-turn file.
pub fn load(cwd: &Path, ui: &mut dyn Frontend) -> Option<Vec<String>> {
    read_lines(cwd, BEFORE_TURN_FILE, ui)
}

/// Runs the before-turn lines in order and returns the text to send with the turn's message: each command with its
/// result. Returns `None` when there are no lines.
pub fn run(commands: &[String], tools: &dyn ToolRunner, ui: &mut dyn Frontend) -> Option<String> {
    let results = run_lines(commands, "before-turn", tools, ui);
    let blocks: Vec<String> =
        results.iter().map(|(command, result)| format!("Before-turn command: {command}\n{result}")).collect();
    (!blocks.is_empty()).then(|| blocks.join("\n\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::file_commands::test_support::Echo;
    use crate::frontend::Sink;

    #[test]
    fn output_of_each_line_is_returned_in_order() {
        let commands = ["a".to_string(), "b".to_string()];
        let text = run(&commands, &Echo, &mut Sink);
        assert_eq!(
            text,
            Some("Before-turn command: a\nran a\n\nBefore-turn command: b\nran b".to_string())
        );
    }
}
