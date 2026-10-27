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
    match tools.run_command_file_line(&invocation) {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::runner::WorkspaceTools;
    use std::fs;

    #[test]
    fn unreadable_command_file_is_reported_and_yields_none() {
        let cwd = std::env::temp_dir().join(format!("vise-file-commands-{}", std::process::id()));
        fs::create_dir_all(cwd.join("shutdown.txt")).unwrap();
        let tools = WorkspaceTools::new(cwd.clone());
        let mut errors = Vec::<u8>::new();
        let result = run_file(&cwd, "shutdown.txt", "shutdown", &tools, &mut Vec::<u8>::new(), &mut errors);
        fs::remove_dir_all(&cwd).unwrap();
        assert!(matches!(result, Ok(None)));
        assert!(String::from_utf8(errors).unwrap().contains("error: cannot read shutdown.txt"));
    }
}
