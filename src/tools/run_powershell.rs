use super::jobs::Jobs;
use super::types::{Arguments, Invocation, Param, ParamType, ToolError, ToolSpec};
use std::path::Path;
use std::thread;
use std::time::{Duration, Instant};

pub const SPEC: ToolSpec = ToolSpec {
    name: "run_powershell",
    description: "Run a Windows PowerShell command in the working directory. The user approves each command before it runs. With background false, the command is waited for up to timeout_seconds (1 to 30), and its output and exit code are returned. If it is still running after that, it becomes a background task and the result gives its id. With background true, it starts as a background task at once. Use read_background and kill_background with the id.",
    params: &[
        Param {
            name: "command",
            kind: ParamType::String,
            description: "The PowerShell command to run.",
        },
        Param {
            name: "timeout_seconds",
            kind: ParamType::Integer { min: Some(1), max: Some(30) },
            description: "How long to wait for the command to finish before it becomes a background task.",
        },
        Param {
            name: "background",
            kind: ParamType::Boolean,
            description: "Start the command as a background task at once instead of waiting for it.",
        },
    ],
    bind,
};

fn bind(args: &Arguments) -> Result<Invocation, ToolError> {
    Ok(Invocation::RunPowerShell {
        command: args.text("command")?.to_string(),
        timeout_secs: u64::try_from(args.integer("timeout_seconds")?)
            .map_err(|_| ToolError::InvalidArguments("'timeout_seconds' is out of range".into()))?,
        background: args.boolean("background")?,
    })
}

pub fn run(
    command: &str,
    timeout_secs: u64,
    background: bool,
    cwd: &Path,
    jobs: &mut Jobs,
) -> Result<String, ToolError> {
    if command.trim().is_empty() {
        return Err(ToolError::InvalidArguments("'command' must not be empty".into()));
    }
    let id = jobs.start(command, cwd)?;
    if background {
        return Ok(background_message(id, "started"));
    }
    let deadline = Instant::now() + Duration::from_secs(timeout_secs);
    while !jobs.has_exited(id)? {
        if Instant::now() >= deadline {
            return Ok(background_message(id, &format!("is still running after {timeout_secs} seconds and")));
        }
        thread::sleep(Duration::from_millis(50));
    }
    jobs.finish(id)
}

fn background_message(id: usize, state: &str) -> String {
    format!(
        "background task {id} {state}. Use read_background({id}) to see its output and kill_background({id}) to stop it."
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn timeout_turns_the_command_into_a_background_task_that_kill_stops() {
        let cwd = std::env::temp_dir();
        let pid_file = cwd.join(format!("vise-child-{}.txt", std::process::id()));
        let command = format!(
            "$p = Start-Process powershell -ArgumentList '-NoProfile','-Command','Start-Sleep 300' -PassThru; \
             Set-Content -LiteralPath '{}' -Value $p.Id; Start-Sleep 300",
            pid_file.display()
        );
        let mut jobs = Jobs::default();
        let started = run(&command, 1, false, &cwd, &mut jobs).unwrap();
        assert!(started.contains("background task 1 is still running"));

        let deadline = Instant::now() + Duration::from_secs(20);
        while !pid_file.exists() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(100));
        }
        let pid = fs::read_to_string(&pid_file).unwrap().trim().to_string();
        fs::remove_file(&pid_file).unwrap();

        jobs.kill(1).unwrap();
        let listing = std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH"])
            .output()
            .unwrap();
        assert!(!String::from_utf8_lossy(&listing.stdout).contains(&pid));
    }
}
