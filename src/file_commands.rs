//! Command files: a file in the working directory with one PowerShell command per line. Startup and shutdown run such
//! files. Their commands run without approval, because the user wrote the file.

use crate::tools::types::{Invocation, ToolRunner};
use std::fs;
use std::io::{self, ErrorKind, Write};
use std::path::Path;

/// How long each command may run in the foreground. A command still running after this becomes a background task.
const TIMEOUT_SECS: u64 = 30;

/// Runs the lines of `file` in `cwd` in order, and returns each command with its result text. Returns `None` when
/// there is no such file. `label` names the run on screen, such as "startup".
pub fn run_file(
    cwd: &Path,
    file: &str,
    label: &str,
    tools: &dyn ToolRunner,
    output: &mut impl Write,
    errors: &mut impl Write,
) -> io::Result<Option<Vec<(String, String)>>> {
    let text = match fs::read_to_string(cwd.join(file)) {
        Ok(text) => text,
        Err(err) if err.kind() == ErrorKind::NotFound => return Ok(None),
        Err(err) => {
            writeln!(errors, "error: cannot read {file}: {err}")?;
            return Ok(None);
        }
    };
    let mut results = Vec::new();
    for command in text.lines().map(str::trim).filter(|line| !line.is_empty()) {
        let result = run_command(command, label, tools, output, errors)?;
        results.push((command.to_string(), result));
    }
    Ok(Some(results))
}

/// Runs one command and returns its result text.
fn run_command(
    command: &str,
    label: &str,
    tools: &dyn ToolRunner,
    output: &mut impl Write,
    errors: &mut impl Write,
) -> io::Result<String> {
    writeln!(output, "{label}: {command}")?;
    let invocation = Invocation::RunPowerShell {
        command: command.to_string(),
        timeout_secs: TIMEOUT_SECS,
        background: false,
    };
    // The user wrote the file, so the approval the runner asks for is answered yes here.
    match tools.run(&invocation, &mut |_: &str| true) {
        Ok(result) => {
            // The first line of a result is its status, such as the exit code. The output itself goes to the model.
            writeln!(output, "  {}", result.lines().next().unwrap_or_default())?;
            Ok(result)
        }
        Err(err) => {
            writeln!(errors, "error: {label} command failed: {err}")?;
            Ok(err.to_string())
        }
    }
}
