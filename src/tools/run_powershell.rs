use super::types::{Arguments, Invocation, Param, ParamType, ToolError, ToolSpec};
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const TIMEOUT: Duration = Duration::from_secs(30);
const MAX_OUTPUT: usize = 100 * 1024;

pub const SPEC: ToolSpec = ToolSpec {
    name: "run_powershell",
    description: "Run a Windows PowerShell command in the working directory. The user approves each command before it runs. The command is stopped after 30 seconds. The result has the exit code, then stdout and stderr, capped at 100 KB.",
    params: &[Param {
        name: "command",
        kind: ParamType::String,
        description: "The PowerShell command to run.",
    }],
    bind,
};

fn bind(args: &Arguments) -> Result<Invocation, ToolError> {
    Ok(Invocation::RunPowerShell { command: args.text("command")?.to_string() })
}

pub fn run(command: &str, cwd: &Path) -> Result<String, ToolError> {
    if command.trim().is_empty() {
        return Err(ToolError::InvalidArguments("'command' must not be empty".into()));
    }
    let mut child = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", command])
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| ToolError::Failed(format!("cannot start powershell.exe: {err}")))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| ToolError::Failed("cannot read the command's stdout".into()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| ToolError::Failed("cannot read the command's stderr".into()))?;
    // Read both pipes on their own threads, so a full pipe cannot stall the child.
    let stdout_reader = thread::spawn(move || read_pipe(stdout));
    let stderr_reader = thread::spawn(move || read_pipe(stderr));

    let started = Instant::now();
    let status = loop {
        match child.try_wait().map_err(|err| ToolError::Failed(format!("cannot wait for the command: {err}")))? {
            Some(status) => break status,
            None if started.elapsed() >= TIMEOUT => {
                stop_tree(child.id());
                // Killing may fail if the command has just exited; either way it is no longer running.
                let _ = child.kill();
                let _ = child.wait();
                return Err(ToolError::Failed(format!(
                    "the command ran longer than {} seconds and was stopped",
                    TIMEOUT.as_secs()
                )));
            }
            None => thread::sleep(Duration::from_millis(50)),
        }
    };
    let stdout = stdout_reader.join().unwrap_or_default();
    let stderr = stderr_reader.join().unwrap_or_default();

    let code = status.code().map_or_else(|| "none".to_string(), |code| code.to_string());
    let mut output = format!("exit code: {code}\n{}", String::from_utf8_lossy(&stdout));
    let stderr = String::from_utf8_lossy(&stderr);
    if !stderr.is_empty() {
        output.push_str("\n[stderr]\n");
        output.push_str(&stderr);
    }
    if output.len() > MAX_OUTPUT {
        let mut end = MAX_OUTPUT;
        while !output.is_char_boundary(end) {
            end -= 1;
        }
        output.truncate(end);
        output.push_str("\n[output truncated at 100 KB]");
    }
    Ok(output)
}

/// Stops a process and every process it started. This is the only platform-specific step: Windows'
/// `taskkill /T` walks the process tree. A failure is ignored here, since the caller kills the shell
/// process directly as well.
fn stop_tree(pid: u32) {
    let _ = Command::new("taskkill")
        .args(["/T", "/F", "/PID", &pid.to_string()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

/// Reads a pipe to its end. A read error keeps whatever was read before it.
fn read_pipe(mut pipe: impl Read) -> Vec<u8> {
    let mut buf = Vec::new();
    let _ = pipe.read_to_end(&mut buf);
    buf
}
