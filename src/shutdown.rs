//! Shutdown commands: each line of `shutdown.txt` in the working directory is a PowerShell command, run once after the
//! session ends, at `/exit` or the end of input. They run without approval, like the startup commands. Nothing is sent
//! to the model, since the session has ended.

use crate::file_commands::{run_file, run_lines};
use crate::frontend::Frontend;
use crate::tools::runner::SHUTDOWN_FILE;
use crate::tools::types::ToolRunner;
use std::path::Path;

/// Runs the shutdown file, then the shutdown lines of the selected profile, which are `profile`.
pub fn run_with_profile(cwd: &Path, profile: &[String], tools: &dyn ToolRunner, ui: &mut dyn Frontend) {
    run_file(cwd, SHUTDOWN_FILE, "shutdown", tools, ui);
    run_lines(profile, "shutdown", tools, ui);
}

/// The shutdown file alone, with no profile.
#[cfg(test)]
pub fn run(cwd: &Path, tools: &dyn ToolRunner, ui: &mut dyn Frontend) {
    run_with_profile(cwd, &[], tools, ui)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frontend::test_support::TextUi;
    use crate::tools::runner::WorkspaceTools;
    use std::fs;

    #[test]
    fn lines_run_in_order_even_when_run_powershell_is_disabled() {
        let cwd = std::env::temp_dir().join(format!("vise-shutdown-{}", std::process::id()));
        fs::create_dir_all(&cwd).unwrap();
        fs::write(cwd.join(SHUTDOWN_FILE), "Write-Output one\nWrite-Output two\n").unwrap();
        let tools = WorkspaceTools::new(cwd.clone());
        tools.set_enabled("run_powershell", false).unwrap();
        let mut ui = TextUi::new();
        run(&cwd, &tools, &mut ui);
        fs::remove_dir_all(&cwd).unwrap();
        let shown = ui.output;
        let first = shown.find("shutdown: Write-Output one").expect("the first line ran");
        let second = shown.find("shutdown: Write-Output two").expect("the second line ran");
        assert!(first < second && shown.matches("exit code: 0").count() == 2);
    }

    #[test]
    fn profile_shutdown_lines_run_after_the_shutdown_file() {
        let cwd = std::env::temp_dir().join(format!("vise-shutdown-profile-{}", std::process::id()));
        fs::create_dir_all(&cwd).unwrap();
        fs::write(cwd.join(SHUTDOWN_FILE), "Write-Output global\n").unwrap();
        let tools = WorkspaceTools::new(cwd.clone());
        let mut ui = TextUi::new();
        let profile = ["Write-Output profile".to_string()];
        run_with_profile(&cwd, &profile, &tools, &mut ui);
        fs::remove_dir_all(&cwd).unwrap();
        let shown = ui.output;
        let global = shown.find("shutdown: Write-Output global").expect("the global line ran");
        let profile = shown.find("shutdown: Write-Output profile").expect("the profile line ran");
        assert!(global < profile);
    }

    #[test]
    fn missing_shutdown_file_is_not_an_error() {
        let cwd = std::env::temp_dir().join(format!("vise-shutdown-missing-{}", std::process::id()));
        fs::create_dir_all(&cwd).unwrap();
        let tools = WorkspaceTools::new(cwd.clone());
        let mut ui = TextUi::new();
        run(&cwd, &tools, &mut ui);
        fs::remove_dir_all(&cwd).unwrap();
        assert!(ui.errors.is_empty(), "a missing shutdown file is not reported");
    }
}
