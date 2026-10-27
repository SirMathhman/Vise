//! After-turn commands: each line of `after-turn.txt` in the working directory is a PowerShell command, run after every
//! chat turn. The file is read once at launch. A line that exits with a non-zero code makes the turn incomplete: its
//! result is sent to the model as the next message, up to `FOLLOW_UPS` times.

use crate::file_commands::{read_lines, run_lines};
use crate::tools::runner::AFTER_TURN_FILE;
use crate::tools::types::ToolRunner;
use std::io::{self, Write};
use std::path::Path;

/// How many follow-up turns a failing after-turn command may cause in a row.
pub const FOLLOW_UPS: usize = 5;

/// Reads the after-turn lines at launch. Returns `None` when there is no after-turn file.
pub fn load(cwd: &Path, errors: &mut impl Write) -> io::Result<Option<Vec<String>>> {
    read_lines(cwd, AFTER_TURN_FILE, errors)
}

/// Runs the after-turn lines in order. Returns the text of the failing ones, to send to the model, or `None` when
/// every line exits with code 0.
pub fn run(
    commands: &[String],
    tools: &dyn ToolRunner,
    output: &mut impl Write,
    errors: &mut impl Write,
) -> io::Result<Option<String>> {
    let results = run_lines(commands, "after-turn", tools, output, errors)?;
    let failures: Vec<String> = results
        .iter()
        .filter(|(_, result)| failed(result))
        .map(|(command, result)| format!("After-turn command failed: {command}\n{result}"))
        .collect();
    Ok((!failures.is_empty()).then(|| failures.join("\n\n")))
}

/// Whether a result reports a non-zero exit code. The first line of a result is its status. A command still running
/// in the background has no exit code yet, so it does not count as failed.
fn failed(result: &str) -> bool {
    result.lines().next().is_some_and(|status| status.starts_with("exit code: ") && status != "exit code: 0")
}

#[cfg(test)]
mod tests {
    use super::failed;

    #[test]
    fn only_a_non_zero_exit_code_is_a_failure() {
        assert!(failed("exit code: 1\nboom"));
        assert!(!failed("exit code: 0\nfine"));
        assert!(!failed("background task 3 is still running.\n"));
    }
}
