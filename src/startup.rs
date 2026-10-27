//! Startup commands: each line of `startup.txt` in the working directory is a PowerShell command, run once before the
//! first prompt. Their output goes into the conversation with the first message the user sends.

use crate::file_commands::run_file;
use crate::tools::runner::STARTUP_FILE;
use crate::tools::types::ToolRunner;
use std::io::{self, Write};
use std::path::Path;

/// Runs the startup commands in order and returns the text to send with the first message: each command with its
/// result. Returns `None` when there is no startup file or it has no commands.
pub fn run(
    cwd: &Path,
    tools: &dyn ToolRunner,
    output: &mut impl Write,
    errors: &mut impl Write,
) -> io::Result<Option<String>> {
    let results = run_file(cwd, STARTUP_FILE, "startup", tools, output, errors)?.unwrap_or_default();
    let blocks: Vec<String> =
        results.iter().map(|(command, result)| format!("Startup command: {command}\n{result}")).collect();
    Ok((!blocks.is_empty()).then(|| blocks.join("\n\n")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::types::{Invocation, ToolError};
    use std::fs;

    /// Answers each command with its own text, so the test can see which commands ran.
    struct Echo;

    impl ToolRunner for Echo {
        fn run(&self, invocation: &Invocation, _approve: &mut dyn FnMut(&str) -> bool) -> Result<String, ToolError> {
            match invocation {
                Invocation::RunPowerShell { command, .. } => Ok(format!("ran {command}")),
                _ => Err(ToolError::UnknownTool("none".into())),
            }
        }
    }

    #[test]
    fn each_line_runs_in_order_and_blank_lines_are_skipped() {
        let cwd = std::env::temp_dir().join(format!("vise-startup-{}", std::process::id()));
        fs::create_dir_all(&cwd).unwrap();
        fs::write(cwd.join(STARTUP_FILE), "first\n\n  second  \n").unwrap();
        let mut shown = Vec::<u8>::new();
        let text = run(&cwd, &Echo, &mut shown, &mut Vec::<u8>::new());
        fs::remove_dir_all(&cwd).unwrap();
        assert_eq!(
            text.unwrap(),
            Some("Startup command: first\nran first\n\nStartup command: second\nran second".to_string())
        );
        assert_eq!(String::from_utf8(shown).unwrap(), "startup: first\n  ran first\nstartup: second\n  ran second\n");
    }
}
