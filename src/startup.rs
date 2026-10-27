//! Startup commands: each line of `startup.txt` in the working directory is a PowerShell command, run once before the
//! first prompt. Their output goes into the conversation with the first message the user sends.

use crate::tools::types::{Invocation, ToolRunner};
use std::fs;
use std::io::{self, ErrorKind, Write};
use std::path::Path;

const FILE: &str = "startup.txt";
/// How long each command may run in the foreground. A command still running after this becomes a background task.
const TIMEOUT_SECS: u64 = 30;

/// Runs the startup commands in order and returns the text to send with the first message: each command with its
/// output or error. Returns `None` when there is no startup file or it has no commands.
pub fn run(
    cwd: &Path,
    tools: &dyn ToolRunner,
    output: &mut impl Write,
    errors: &mut impl Write,
) -> io::Result<Option<String>> {
    let text = match fs::read_to_string(cwd.join(FILE)) {
        Ok(text) => text,
        Err(err) if err.kind() == ErrorKind::NotFound => return Ok(None),
        Err(err) => {
            writeln!(errors, "error: cannot read {FILE}: {err}")?;
            return Ok(None);
        }
    };
    let mut blocks = Vec::new();
    for command in text.lines().map(str::trim).filter(|line| !line.is_empty()) {
        blocks.push(run_command(command, tools, output, errors)?);
    }
    Ok((!blocks.is_empty()).then(|| blocks.join("\n\n")))
}

/// Runs one command and returns its block for the conversation.
fn run_command(
    command: &str,
    tools: &dyn ToolRunner,
    output: &mut impl Write,
    errors: &mut impl Write,
) -> io::Result<String> {
    writeln!(output, "startup: {command}")?;
    let invocation = Invocation::RunPowerShell {
        command: command.to_string(),
        timeout_secs: TIMEOUT_SECS,
        background: false,
    };
    // The user wrote this file, so the approval the runner asks for is answered yes here.
    let result = match tools.run(&invocation, &mut |_: &str| true) {
        Ok(result) => result,
        Err(err) => {
            writeln!(errors, "error: startup command failed: {err}")?;
            err.to_string()
        }
    };
    Ok(format!("Startup command: {command}\n{result}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::types::ToolError;
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
        fs::write(cwd.join(FILE), "first\n\n  second  \n").unwrap();
        let text = run(&cwd, &Echo, &mut Vec::<u8>::new(), &mut Vec::<u8>::new());
        fs::remove_dir_all(&cwd).unwrap();
        assert_eq!(
            text.unwrap(),
            Some("Startup command: first\nran first\n\nStartup command: second\nran second".to_string())
        );
    }
}
