//! Command files: a file in the working directory with one PowerShell command per line. Startup and shutdown run such
//! files. Their commands run without approval, because the user wrote the file.

use crate::frontend::Frontend;
use crate::tools::types::{Invocation, ToolRunner};
use std::fs;
use std::io::ErrorKind;
use std::path::Path;

/// How long each command may run in the foreground. A command still running after this becomes a background task.
const TIMEOUT_SECS: u64 = 30;

/// The command lines of `file` in `cwd`: trimmed, without blank ones. Returns `None` when there is no such file. A
/// file that cannot be read is reported on `errors`, and also gives `None`.
pub fn read_lines(cwd: &Path, file: &str, ui: &mut dyn Frontend) -> Option<Vec<String>> {
    let text = match fs::read_to_string(cwd.join(file)) {
        Ok(text) => text,
        Err(err) if err.kind() == ErrorKind::NotFound => return None,
        Err(err) => {
            ui.error(format!("cannot read {file}: {err}"));
            return None;
        }
    };
    Some(text.lines().map(str::trim).filter(|line| !line.is_empty()).map(str::to_string).collect())
}

/// Runs each command in order and returns each with its result text. `label` names the run on screen, such as
/// "startup".
pub fn run_lines(commands: &[String], label: &str, tools: &dyn ToolRunner, ui: &mut dyn Frontend) -> Vec<(String, String)> {
    commands.iter().map(|command| (command.clone(), run_command(command, label, tools, ui))).collect()
}

/// Reads the lines of `file` in `cwd` and runs them in order. Returns `None` when there is no such file.
pub fn run_file(
    cwd: &Path,
    file: &str,
    label: &str,
    tools: &dyn ToolRunner,
    ui: &mut dyn Frontend,
) -> Option<Vec<(String, String)>> {
    let commands = read_lines(cwd, file, ui)?;
    Some(run_lines(&commands, label, tools, ui))
}

/// Runs one command and returns its result text.
fn run_command(command: &str, label: &str, tools: &dyn ToolRunner, ui: &mut dyn Frontend) -> String {
    ui.notice(format!("{label}: {command}"));
    let invocation = Invocation::RunPowerShell {
        command: command.to_string(),
        timeout_secs: TIMEOUT_SECS,
        background: false,
    };
    match tools.run_command_file_line(&invocation) {
        Ok(result) => {
            // The first line of a result is its status, such as the exit code. The output itself goes to the model.
            ui.notice(format!("  {}", result.lines().next().unwrap_or_default()));
            result
        }
        Err(err) => {
            ui.error(format!("{label} command failed: {err}"));
            err.to_string()
        }
    }
}

/// Test helpers shared by the command-file modules.
#[cfg(test)]
pub mod test_support {
    use crate::tools::types::{Invocation, ToolError, ToolRunner};

    /// Answers each shell command with its own text, so a test can see which commands ran.
    pub struct Echo;

    impl ToolRunner for Echo {
        fn run(&self, invocation: &Invocation, _approve: &mut dyn FnMut(&str) -> bool) -> Result<String, ToolError> {
            match invocation {
                Invocation::RunPowerShell { command, .. } => Ok(format!("ran {command}")),
                _ => Err(ToolError::UnknownTool("none".into())),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frontend::test_support::TextUi;
    use crate::tools::runner::WorkspaceTools;
    use std::fs;

    #[test]
    fn unreadable_command_file_is_reported_and_yields_none() {
        let cwd = std::env::temp_dir().join(format!("vise-file-commands-{}", std::process::id()));
        fs::create_dir_all(cwd.join("shutdown.txt")).unwrap();
        let tools = WorkspaceTools::new(cwd.clone());
        let mut ui = TextUi::new();
        let result = run_file(&cwd, "shutdown.txt", "shutdown", &tools, &mut ui);
        fs::remove_dir_all(&cwd).unwrap();
        assert!(result.is_none());
        assert!(ui.errors.contains("error: cannot read shutdown.txt"));
    }
}
