use super::fs::path::confine_new;
use super::fs::{create_directory, create_file, edit_file, list_directory, read_file};
use super::jobs::Jobs;
use super::types::{Invocation, ToolError, ToolRunner};
use super::{kill_background, notes, read_background, run_powershell, specs};
use std::cell::RefCell;
use std::collections::HashSet;
use std::path::PathBuf;

/// The file in the working directory whose lines run before each session.
pub const STARTUP_FILE: &str = "startup.txt";
/// The file in the working directory whose lines run after each session.
pub const SHUTDOWN_FILE: &str = "shutdown.txt";

pub struct WorkspaceTools {
    cwd: PathBuf,
    jobs: RefCell<Jobs>,
    enabled: RefCell<HashSet<&'static str>>,
    allowed_notes: RefCell<Option<Vec<String>>>,
}

impl WorkspaceTools {
    pub fn new(cwd: PathBuf) -> Self {
        let enabled = specs().iter().map(|spec| spec.name).collect();
        Self {
            cwd,
            jobs: RefCell::new(Jobs::default()),
            enabled: RefCell::new(enabled),
            allowed_notes: RefCell::new(None),
        }
    }

    /// Whether the model may use the note `name`.
    fn note_allowed(&self, name: &str) -> bool {
        self.allowed_notes.borrow().as_ref().is_none_or(|names| names.iter().any(|allowed| allowed == name))
    }

    /// Whether `path` names a command file (startup or shutdown) in the working directory, whatever its spelling.
    fn is_command_file(&self, path: &str) -> bool {
        let (Ok(target), Ok(root)) = (confine_new(&self.cwd, path), self.cwd.canonicalize()) else {
            return false;
        };
        target.parent() == Some(root.as_path())
            && target.file_name().is_some_and(|name| {
                [STARTUP_FILE, SHUTDOWN_FILE].iter().any(|file| name.eq_ignore_ascii_case(*file))
            })
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

    fn allowed_notes(&self) -> Option<Vec<String>> {
        self.allowed_notes.borrow().clone()
    }

    fn set_allowed_notes(&self, names: Option<Vec<String>>) {
        *self.allowed_notes.borrow_mut() = names;
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
        let name = invocation.tool_name();
        if !self.enabled.borrow().contains(name) {
            return Err(ToolError::Disabled(name.into()));
        }
        if let Some(note) = invocation.note_name().filter(|note| !self.note_allowed(note)) {
            return Err(ToolError::Failed(format!("note '{note}' is not allowed by the profile")));
        }
        // The file tools cannot change the startup or shutdown commands. Changing them is left to run_powershell, whose
        // approval text says when a command names one of these files.
        if let Invocation::CreateFile { path, .. } | Invocation::EditFile { path, .. } = invocation
            && self.is_command_file(path)
        {
            return Err(ToolError::Failed(format!(
                "'{path}' lists commands that run without a prompt, so the file tools cannot change it"
            )));
        }
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
            Invocation::ListNotes { category } => notes::run_list(category, self.allowed_notes.borrow().as_deref()),
            Invocation::ReadNote { name } => notes::run_read(name),
            Invocation::CreateNote { name, summary, category, content } => {
                notes::run_create(name, summary, category, content)
            }
            Invocation::UpdateNote { name, summary, category, content } => {
                notes::run_update(name, summary, category, content)
            }
            Invocation::DeleteNote { name } => notes::run_delete(name),
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
            let text = if *background {
                format!("start this PowerShell command as a background task:\n{command}")
            } else {
                format!(
                    "run this PowerShell command, moving it to the background if it runs past {timeout_secs} seconds:\n{command}"
                )
            };
            let lowered = command.to_ascii_lowercase();
            if [STARTUP_FILE, SHUTDOWN_FILE].iter().any(|file| lowered.contains(*file)) {
                format!("{text}\nThis may change a startup or shutdown file, whose lines run without a prompt.")
            } else {
                text
            }
        }
        Invocation::KillBackground { id } => format!("stop background task {id}"),
        Invocation::CreateNote { name, summary, category, content } => {
            format!("create note '{name}' [{category}]: {summary}\n{content}")
        }
        Invocation::UpdateNote { name, summary, category, content } => {
            format!("replace note '{name}' with [{category}]: {summary}\n{content}")
        }
        Invocation::DeleteNote { name } => format!("delete note '{name}'"),
        Invocation::ListDirectory { .. }
        | Invocation::ReadFile { .. }
        | Invocation::ReadBackground { .. }
        | Invocation::ListNotes { .. }
        | Invocation::ReadNote { .. } => String::new(),
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

    #[test]
    fn file_tools_refuse_to_write_the_startup_file() {
        let cwd = std::env::temp_dir().join(format!("vise-startup-guard-{}", std::process::id()));
        fs::create_dir_all(&cwd).unwrap();
        let tools = WorkspaceTools::new(cwd.clone());
        let create = Invocation::CreateFile { path: "STARTUP.txt".into(), content: "x".into() };
        let edit = Invocation::EditFile { path: "./startup.txt".into(), previous: "a".into(), new: "b".into() };
        let created = tools.run(&create, &mut |_: &str| true);
        let edited = tools.run(&edit, &mut |_: &str| true);
        fs::remove_dir_all(&cwd).unwrap();
        assert!(created.is_err_and(|err| err.to_string().contains("cannot change it")));
        assert!(edited.is_err_and(|err| err.to_string().contains("cannot change it")));
    }

    #[test]
    fn disabled_tool_is_refused_by_the_runner() {
        let tools = WorkspaceTools::new(std::env::temp_dir());
        tools.set_enabled("list_directory", false).unwrap();
        let invocation = Invocation::ListDirectory { path: ".".into(), depth: 1 };
        let result = tools.run(&invocation, &mut |_: &str| true);
        assert!(matches!(result, Err(ToolError::Disabled(name)) if name == "list_directory"));
    }
}
