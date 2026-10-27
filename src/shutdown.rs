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
