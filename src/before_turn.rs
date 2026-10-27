//! Before-turn commands: each line of `before-turn.txt` in the working directory is a PowerShell command, run before every
//! turn. Their output goes to the model with that turn's message.

use crate::file_commands::run_file;
use crate::tools::runner::BEFORE_TURN_FILE;
use crate::tools::types::ToolRunner;
use std::io::{self, Write};
use std::path::Path;

/// Runs the before-turn commands in order and returns the text to send with the turn's message: each command with its
/// result. Returns `None` when there is no before-turn file or it has no commands.
pub fn run(
    cwd: &Path,
    tools: &dyn ToolRunner,
    output: &mut impl Write,
    errors: &mut impl Write,
) -> io::Result<Option<String>> {
    let results = run_file(cwd, BEFORE_TURN_FILE, "before-turn", tools, output, errors)?.unwrap_or_default();
    let blocks: Vec<String> =
        results.iter().map(|(command, result)| format!("Before-turn command: {command}\n{result}")).collect();
    Ok((!blocks.is_empty()).then(|| blocks.join("\n\n")))
}
