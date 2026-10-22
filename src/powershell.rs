//! The PowerShell tool: runs a command in the working directory and returns its output and exit code.
//! Commands run without asking. They are stopped after `TIMEOUT`, and their output is cut short by the
//! caller the same way as any other tool result.

use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

pub const NAME: &str = "run_powershell";
const TIMEOUT: Duration = Duration::from_secs(30);
/// Most output read from each stream. The caller cuts the final result shorter still.
const MAX_STREAM_BYTES: u64 = 64 * 1024;

pub fn definition() -> Value {
    json!({
        "type": "function",
        "function": {
            "name": NAME,
            "description": "Run a PowerShell command in the working directory and return its exit code and output. Commands run without asking, and a command that runs longer than 30 seconds is stopped.",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": { "type": "string", "description": "The PowerShell command to run" }
                },
                "required": ["command"]
            }
        }
    })
}

pub fn run(arguments: &str, root: Option<&Path>) -> Result<String, String> {
    let args: Value = serde_json::from_str(arguments).map_err(|err| format!("invalid arguments: {err}"))?;
    let command = args
        .get("command")
        .and_then(Value::as_str)
        .ok_or("command must be a string")?;
    let dir = root.ok_or("no working directory is set, so the PowerShell tool is unavailable")?;

    let mut child = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", command])
        .current_dir(dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| format!("could not start PowerShell: {err}"))?;
    // Both streams are read while the command runs, so a full pipe never stops it.
    let stdout = read_in_background(child.stdout.take());
    let stderr = read_in_background(child.stderr.take());

    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|err| format!("PowerShell failed: {err}"))? {
            break status;
        }
        if started.elapsed() >= TIMEOUT {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("the command timed out after {} seconds", TIMEOUT.as_secs()));
        }
        thread::sleep(Duration::from_millis(50));
    };
    let out = stdout.join().unwrap_or_default();
    let err = stderr.join().unwrap_or_default();
    Ok(format!("exit code {}\n{out}{err}", status.code().unwrap_or(-1)))
}

fn read_in_background<R: Read + Send + 'static>(pipe: Option<R>) -> thread::JoinHandle<String> {
    thread::spawn(move || {
        let mut bytes = Vec::new();
        if let Some(pipe) = pipe {
            let _ = pipe.take(MAX_STREAM_BYTES).read_to_end(&mut bytes);
        }
        String::from_utf8_lossy(&bytes).into_owned()
    })
}
