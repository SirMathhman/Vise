use serde_json::{json, Value};
use std::time::Duration;

use crate::error::AppError;
use super::Tool;

const MAX_OUTPUT_CHARS: usize = 10_000;

pub fn tool() -> Tool {
    Tool {
        name: "run_powershell",
        schema: json!({
            "type": "function",
            "function": {
                "name": "run_powershell",
                "description": "Run a PowerShell command and return its combined output. A timeout in seconds is mandatory; the process is killed if it exceeds it.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "command": {"type": "string", "description": "The PowerShell command to run."},
                        "timeout_seconds": {"type": "integer", "description": "Mandatory timeout in seconds. The process is killed if it exceeds this."}
                    },
                    "required": ["command", "timeout_seconds"]
                }
            }
        }),
        execute: |args| Box::pin(async { run_powershell(args).await }),
    }
}

async fn run_powershell(args: Value) -> Result<String, AppError> {
    let command = args
        .get("command")
        .and_then(|v| v.as_str())
        .ok_or_else(|| AppError::BadRequest("missing 'command'".into()))?;
    let timeout_seconds = args
        .get("timeout_seconds")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| AppError::BadRequest("missing 'timeout_seconds'".into()))?;
    if timeout_seconds <= 0 {
        return Err(AppError::BadRequest("timeout_seconds must be > 0".into()));
    }

    let mut child = tokio::process::Command::new("powershell")
        .args(["-NoProfile", "-NoLogo", "-Command", command])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| AppError::Internal(format!("failed to spawn powershell: {e}")))?;

    let result = tokio::time::timeout(Duration::from_secs(timeout_seconds as u64), child.wait()).await;

    let status = match result {
        Ok(status) => status,
        Err(_) => {
            child.kill().await.ok();
            return Err(AppError::Timeout(format!("powershell timed out after {timeout_seconds}s")));
        }
    }
    .map_err(|e| AppError::Internal(format!("failed to wait for process: {e}")))?;

    let mut output = String::new();
    use tokio::io::AsyncReadExt;
    if let Some(mut stdout) = child.stdout.take() {
        let mut buf = String::new();
        stdout.read_to_string(&mut buf).await.ok();
        output.push_str(&buf);
    }
    if let Some(mut stderr) = child.stderr.take() {
        let mut buf = String::new();
        stderr.read_to_string(&mut buf).await.ok();
        if !buf.is_empty() {
            output.push_str(&buf);
        }
    }

    if output.len() > MAX_OUTPUT_CHARS {
        let mut truncated = String::new();
        for (i, c) in output.chars().enumerate() {
            if i == MAX_OUTPUT_CHARS {
                truncated.push_str("... [truncated]");
                break;
            }
            truncated.push(c);
        }
        output = truncated;
    }

    if !status.success() {
        return Ok(format!(
            "command exited with status {:?}:\n{}",
            status.code(),
            output
        ));
    }

    Ok(output)
}