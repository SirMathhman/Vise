//! Shutdown commands: each line of `shutdown.txt` in the working directory is a PowerShell command, run once after the
//! session ends, at `/exit` or the end of input. They run without approval, like the startup commands. Nothing is sent
//! to the model, since the session has ended.

use crate::file_commands::run_file;
use crate::tools::runner::SHUTDOWN_FILE;
use crate::tools::types::ToolRunner;
use std::io::{self, Write};
use std::path::Path;

pub fn run(cwd: &Path, tools: &dyn ToolRunner, output: &mut impl Write, errors: &mut impl Write) -> io::Result<()> {
    run_file(cwd, SHUTDOWN_FILE, "shutdown", tools, output, errors)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::runner::WorkspaceTools;
    use std::fs;

    #[test]
    fn lines_run_in_order_even_when_run_powershell_is_disabled() {
        let cwd = std::env::temp_dir().join(format!("vise-shutdown-{}", std::process::id()));
        fs::create_dir_all(&cwd).unwrap();
        fs::write(cwd.join(SHUTDOWN_FILE), "Write-Output one\nWrite-Output two\n").unwrap();
        let tools = WorkspaceTools::new(cwd.clone());
        tools.set_enabled("run_powershell", false).unwrap();
        let mut shown = Vec::<u8>::new();
        let result = run(&cwd, &tools, &mut shown, &mut Vec::<u8>::new());
        fs::remove_dir_all(&cwd).unwrap();
        assert!(result.is_ok());
        let shown = String::from_utf8(shown).unwrap();
        let first = shown.find("shutdown: Write-Output one").expect("the first line ran");
        let second = shown.find("shutdown: Write-Output two").expect("the second line ran");
        assert!(first < second && shown.matches("exit code: 0").count() == 2);
    }

    #[test]
    fn missing_shutdown_file_is_not_an_error() {
        let cwd = std::env::temp_dir().join(format!("vise-shutdown-missing-{}", std::process::id()));
        fs::create_dir_all(&cwd).unwrap();
        let tools = WorkspaceTools::new(cwd.clone());
        let result = run(&cwd, &tools, &mut Vec::<u8>::new(), &mut Vec::<u8>::new());
        fs::remove_dir_all(&cwd).unwrap();
        assert!(result.is_ok());
    }
}
