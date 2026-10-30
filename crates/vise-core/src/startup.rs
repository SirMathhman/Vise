//! Startup commands: each line of `startup.txt` in the working directory is a PowerShell command, run once before the
//! first prompt. Their output goes into the conversation with the first message the user sends.

use crate::file_commands::run_file;
use crate::frontend::Frontend;
use crate::tools::runner::STARTUP_FILE;
use crate::tools::types::ToolRunner;
use std::path::Path;

/// Runs the startup commands in order and returns the text to send with the first message: each command with its
/// result. Returns `None` when there is no startup file or it has no commands.
pub fn run(cwd: &Path, tools: &dyn ToolRunner, ui: &mut dyn Frontend) -> Option<String> {
    let results = run_file(cwd, STARTUP_FILE, "startup", tools, ui).unwrap_or_default();
    let blocks: Vec<String> =
        results.iter().map(|(command, result)| format!("Startup command: {command}\n{result}")).collect();
    (!blocks.is_empty()).then(|| blocks.join("\n\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::file_commands::test_support::Echo;
    use crate::frontend::test_support::TextUi;
    use std::fs;

    #[test]
    fn each_line_runs_in_order_and_blank_lines_are_skipped() {
        let cwd = std::env::temp_dir().join(format!("vise-startup-{}", std::process::id()));
        fs::create_dir_all(&cwd).unwrap();
        fs::write(cwd.join(STARTUP_FILE), "first\n\n  second  \n").unwrap();
        let mut ui = TextUi::new();
        let text = run(&cwd, &Echo, &mut ui);
        fs::remove_dir_all(&cwd).unwrap();
        assert_eq!(
            text,
            Some("Startup command: first\nran first\n\nStartup command: second\nran second".to_string())
        );
        assert_eq!(ui.output, "startup: first\n  ran first\nstartup: second\n  ran second\n");
    }
}
