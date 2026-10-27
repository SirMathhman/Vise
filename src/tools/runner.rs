use super::fs::{create_directory, create_file, edit_file, list_directory, read_file};
use super::jobs::Jobs;
use super::types::{Invocation, ToolError, ToolRunner};
use super::{kill_background, read_background, run_powershell, specs};
use std::cell::RefCell;
use std::collections::HashSet;
use std::path::PathBuf;

pub struct WorkspaceTools {
    cwd: PathBuf,
    jobs: RefCell<Jobs>,
    enabled: RefCell<HashSet<&'static str>>,
}

impl WorkspaceTools {
    pub fn new(cwd: PathBuf) -> Self {
        let enabled = specs().iter().map(|spec| spec.name).collect();
        Self { cwd, jobs: RefCell::new(Jobs::default()), enabled: RefCell::new(enabled) }
    }
}

impl Drop for WorkspaceTools {
    /// Background tasks do not outlive the session.
    fn drop(&mut self) {
        self.jobs.get_mut().stop_all();
    }
}

impl ToolRunner for WorkspaceTools {
    fn enabled(&self) -> Vec<&'static str> {
        let enabled = self.enabled.borrow();
        specs().iter().map(|spec| spec.name).filter(|name| enabled.contains(name)).collect()
    }

    fn set_enabled(&self, name: &str, on: bool) -> Result<(), ToolError> {
        let spec = specs().iter().find(|spec| spec.name == name).ok_or_else(|| ToolError::UnknownTool(name.into()))?;
        let mut enabled = self.enabled.borrow_mut();
        if on {
            enabled.insert(spec.name);
        } else {
            enabled.remove(spec.name);
        }
        Ok(())
    }

    fn run(&self, invocation: &Invocation, approve: &mut dyn FnMut(&str) -> bool) -> Result<String, ToolError> {
        if invocation.writes() && !approve(&describe(invocation)) {
            return Err(ToolError::Failed("the user declined this change".into()));
        }
        match invocation {
            Invocation::ListDirectory { path, depth } => list_directory::run(path, *depth, &self.cwd),
            Invocation::ReadFile { path, start, end } => read_file::run(path, *start, *end, &self.cwd),
            Invocation::CreateFile { path, content } => create_file::run(path, content, &self.cwd),
            Invocation::CreateDirectory { path } => create_directory::run(path, &self.cwd),
            Invocation::EditFile { path, previous, new } => edit_file::run(path, previous, new, &self.cwd),
            Invocation::RunPowerShell { command, timeout_secs, background } => run_powershell::run(
                command,
                *timeout_secs,
                *background,
                &self.cwd,
                &mut self.jobs.borrow_mut(),
            ),
            Invocation::ReadBackground { id } => read_background::run(*id, &mut self.jobs.borrow_mut()),
            Invocation::KillBackground { id } => kill_background::run(*id, &mut self.jobs.borrow_mut()),
        }
    }
}

/// Describes a write so the user can decide whether to allow it.
fn describe(invocation: &Invocation) -> String {
    match invocation {
        Invocation::CreateFile { path, content } => format!("create file '{path}' with:\n{content}"),
        Invocation::CreateDirectory { path } => format!("create directory '{path}'"),
        Invocation::EditFile { path, previous, new } => format!("edit '{path}':\n- {previous}\n+ {new}"),
        Invocation::RunPowerShell { command, timeout_secs, background } => {
            if *background {
                format!("start this PowerShell command as a background task:\n{command}")
            } else {
                format!(
                    "run this PowerShell command, moving it to the background if it runs past {timeout_secs} seconds:\n{command}"
                )
            }
        }
        Invocation::KillBackground { id } => format!("stop background task {id}"),
        Invocation::ListDirectory { .. } | Invocation::ReadFile { .. } | Invocation::ReadBackground { .. } => {
            String::new()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn declined_create_file_changes_nothing() {
        let cwd = std::env::temp_dir().join(format!("vise-declined-{}", std::process::id()));
        fs::create_dir_all(&cwd).unwrap();
        let tools = WorkspaceTools::new(cwd.clone());
        let invocation = Invocation::CreateFile { path: "declined.txt".into(), content: "nope".into() };
        let mut asked = Vec::new();
        let result = tools.run(&invocation, &mut |change: &str| {
            asked.push(change.to_string());
            false
        });
        assert!(result.is_err());
        assert!(asked[0].contains("declined.txt"));
        assert!(!cwd.join("declined.txt").exists());
        fs::remove_dir_all(&cwd).unwrap();
    }
}
