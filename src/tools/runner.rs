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
/// The file in the working directory whose lines run before each turn.
pub const BEFORE_TURN_FILE: &str = "before-turn.txt";
/// The file in the working directory whose lines run after each chat turn.
pub const AFTER_TURN_FILE: &str = "after-turn.txt";
/// Every file whose lines run without approval. The file tools cannot change any of them.
const COMMAND_FILES: [&str; 4] = [STARTUP_FILE, SHUTDOWN_FILE, BEFORE_TURN_FILE, AFTER_TURN_FILE];

pub struct WorkspaceTools {
    cwd: PathBuf,
    jobs: RefCell<Jobs>,
    enabled: RefCell<HashSet<&'static str>>,
    allowed_notes: RefCell<Option<Vec<String>>>,
    /// Profiles the model wrote through the file tools since the user last selected them.
    written_profiles: RefCell<HashSet<String>>,
}

impl WorkspaceTools {
    pub fn new(cwd: PathBuf) -> Self {
        let enabled = specs().iter().map(|spec| spec.name).collect();
        Self {
            cwd,
            jobs: RefCell::new(Jobs::default()),
            enabled: RefCell::new(enabled),
            allowed_notes: RefCell::new(None),
            written_profiles: RefCell::new(HashSet::new()),
        }
    }

    /// Whether the model may use the note `name`.
    fn note_allowed(&self, name: &str) -> bool {
        self.allowed_notes.borrow().as_ref().is_none_or(|names| names.iter().any(|allowed| allowed == name))
    }

    /// Whether `path` names a file directly in the notes folder, whatever its spelling.
    fn is_notes_file(&self, path: &str) -> bool {
        let (Ok(target), Ok(root)) = (confine_new(&self.cwd, path), self.cwd.canonicalize()) else {
            return false;
        };
        let Some(folder) = target.parent() else {
            return false;
        };
        folder.parent() == Some(root.as_path())
            && folder.file_name().is_some_and(|name| name.eq_ignore_ascii_case(crate::notes::FOLDER))
    }

    /// The profile a create or edit would leave in the notes folder, as its name, its hook lines and the whole file after
    /// the change. None when the call does not write a note, or the note it leaves is not a profile.
    fn profile_left_by(&self, invocation: &Invocation) -> Option<(String, Vec<String>, String)> {
        let (Invocation::CreateFile { path, .. } | Invocation::EditFile { path, .. }) = invocation else {
            return None;
        };
        if !self.is_notes_file(path) {
            return None;
        }
        let after = match invocation {
            Invocation::CreateFile { content, .. } => content.clone(),
            Invocation::EditFile { previous, new, .. } => {
                let current = std::fs::read_to_string(confine_new(&self.cwd, path).ok()?).ok()?;
                current.replacen(previous.as_str(), new, 1)
            }
            _ => return None,
        };
        let note = crate::notes::parse(&after).ok()?;
        if note.category != "profile" {
            return None;
        }
        let file = std::path::Path::new(path).file_name()?.to_string_lossy().into_owned();
        let name = file.strip_suffix(".md").unwrap_or(&file).to_string();
        let hooks = note.extra.into_iter().filter(|line| line.starts_with("hook ")).collect();
        Some((name, hooks, after))
    }

    /// What the user is asked to approve. A write that leaves a profile in the notes folder opens with the warning that
    /// its hook lines run without a prompt, then lists the hook lines the profile would have and shows the whole file as
    /// it would be after the write, because the file tools may write there only with that approval.
    fn approval_text(&self, invocation: &Invocation) -> String {
        let text = describe(invocation);
        let Some((_, hooks, after)) = self.profile_left_by(invocation) else {
            return text;
        };
        let hooks = if hooks.is_empty() { "none".to_string() } else { hooks.join("\n") };
        format!(
            "This changes a profile, whose hook lines run without a prompt.\nHook lines after this change:\n{hooks}\n\n{text}\n\nThe whole file after this change:\n{after}"
        )
    }

    /// Whether `path` names a command file (startup or shutdown) in the working directory, whatever its spelling.
    fn is_command_file(&self, path: &str) -> bool {
        let (Ok(target), Ok(root)) = (confine_new(&self.cwd, path), self.cwd.canonicalize()) else {
            return false;
        };
        target.parent() == Some(root.as_path())
            && target.file_name().is_some_and(|name| {
                // Windows ignores trailing dots and spaces in a name, and `name:stream` writes to the same file's
                // alternate stream, so the base name is compared without them.
                let name = name.to_string_lossy();
                let base = name.split(':').next().unwrap_or_default().trim_end_matches(['.', ' ']);
                COMMAND_FILES.iter().any(|file| base.eq_ignore_ascii_case(file))
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
    fn notes_folder(&self) -> PathBuf {
        self.cwd.join(crate::notes::FOLDER)
    }

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

    fn profile_written(&self, name: &str) -> bool {
        self.written_profiles.borrow().contains(name)
    }

    fn confirm_profile(&self, name: &str) {
        self.written_profiles.borrow_mut().remove(name);
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
        // The file tools cannot change the command files. Changing them is left to run_powershell, whose
        // approval text says when a command names one of these files.
        if let Invocation::CreateFile { path, .. } | Invocation::EditFile { path, .. } = invocation
            && self.is_command_file(path)
        {
            return Err(ToolError::Failed(format!(
                "'{path}' lists commands that run without a prompt, so the file tools cannot change it"
            )));
        }
        if invocation.writes() && !approve(&self.approval_text(invocation)) {
            return Err(ToolError::Failed("the user declined this change".into()));
        }
        if let Some((name, _, _)) = self.profile_left_by(invocation) {
            // Recorded before the write, so a write that fails partway still leaves the profile unconfirmed.
            self.written_profiles.borrow_mut().insert(name);
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
            Invocation::ListNotes { category } => {
                notes::run_list(&self.notes_folder(), category, self.allowed_notes.borrow().as_deref())
            }
            Invocation::ReadNote { name } => notes::run_read(&self.notes_folder(), name),
            Invocation::CreateNote { name, summary, category, content } => {
                notes::run_create(&self.notes_folder(), name, summary, category, content)
            }
            Invocation::UpdateNote { name, summary, category, content } => {
                notes::run_update(&self.notes_folder(), name, summary, category, content)
            }
            Invocation::DeleteNote { name } => notes::run_delete(&self.notes_folder(), name),
            Invocation::RunSubagent { .. } => Err(ToolError::Failed("a subagent is started from a turn".into())),
        }
    }

    fn run_command_file_line(&self, invocation: &Invocation) -> Result<String, ToolError> {
        match invocation {
            Invocation::RunPowerShell { command, timeout_secs, background } => run_powershell::run(
                command,
                *timeout_secs,
                *background,
                &self.cwd,
                &mut self.jobs.borrow_mut(),
            ),
            _ => Err(ToolError::Failed("a command file holds only PowerShell commands".into())),
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
            if COMMAND_FILES.iter().any(|file| lowered.contains(*file)) {
                format!("{text}\nThis may change a startup, shutdown, before-turn or after-turn file, whose lines run without a prompt.")
            } else if lowered.contains(crate::notes::FOLDER) {
                format!("{text}\nThis may change a note that is a profile, whose hook lines run without a prompt.")
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
        | Invocation::ReadNote { .. }
        | Invocation::RunSubagent { .. } => String::new(),
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
    fn file_tools_refuse_command_file_names_with_trailing_dots_or_streams() {
        let cwd = std::env::temp_dir().join(format!("vise-command-names-{}", std::process::id()));
        fs::create_dir_all(&cwd).unwrap();
        let tools = WorkspaceTools::new(cwd.clone());
        let mut refused = Vec::new();
        for path in ["shutdown.txt.", "startup.txt ", "startup.txt:stream"] {
            let create = Invocation::CreateFile { path: path.into(), content: "x".into() };
            let edit = Invocation::EditFile { path: path.into(), previous: "a".into(), new: "b".into() };
            refused.push(tools.run(&create, &mut |_: &str| true).is_err_and(|err| err.to_string().contains("cannot change it")));
            refused.push(tools.run(&edit, &mut |_: &str| true).is_err_and(|err| err.to_string().contains("cannot change it")));
        }
        fs::remove_dir_all(&cwd).unwrap();
        assert!(refused.iter().all(|&refused| refused));
    }

    /// Whether create_file aimed at `path`, in a fresh working directory named after `folder`, is refused by the guard.
    fn create_is_refused(folder: &str, path: &str) -> bool {
        let cwd = std::env::temp_dir().join(format!("vise-{folder}-{}", std::process::id()));
        fs::create_dir_all(&cwd).unwrap();
        let tools = WorkspaceTools::new(cwd.clone());
        let create = Invocation::CreateFile { path: path.into(), content: "x".into() };
        let refused = tools.run(&create, &mut |_: &str| true);
        fs::remove_dir_all(&cwd).unwrap();
        refused.is_err_and(|err| err.to_string().contains("cannot change it"))
    }

    #[test]
    fn file_tools_refuse_to_write_the_before_turn_file() {
        assert!(create_is_refused("before-turn-guard", "before-turn.txt"));
    }

    #[test]
    fn file_tools_write_a_profile_note_only_with_approval_that_names_the_hooks() {
        let cwd = std::env::temp_dir().join(format!("vise-profile-write-{}", std::process::id()));
        fs::create_dir_all(cwd.join("notes")).unwrap();
        let tools = WorkspaceTools::new(cwd.clone());
        let profile = "---\nsummary: s\ncategory: profile\nhook before-turn: Get-Date\n---\nbe brief".to_string();
        let create = Invocation::CreateFile { path: "notes/x.md".into(), content: profile };
        let declined = tools.run(&create, &mut |_: &str| false);
        let mut asked = String::new();
        let approved = tools.run(&create, &mut |change: &str| {
            asked = change.to_string();
            true
        });
        let written = cwd.join("notes/x.md").exists();
        fs::remove_dir_all(&cwd).unwrap();
        assert!(declined.is_err());
        assert!(approved.is_ok() && written);
        assert!(asked.contains("hook lines run without a prompt"));
        assert!(asked.contains("Hook lines after this change:\nhook before-turn: Get-Date"));
        assert!(tools.profile_written("x"), "a subagent runs it without hooks until the user selects it");
        tools.confirm_profile("x");
        assert!(!tools.profile_written("x"));
    }

    #[test]
    fn a_write_to_an_ordinary_note_is_not_treated_as_a_profile() {
        let cwd = std::env::temp_dir().join(format!("vise-note-write-{}", std::process::id()));
        fs::create_dir_all(cwd.join("notes")).unwrap();
        let tools = WorkspaceTools::new(cwd.clone());
        let note = "---\nsummary: s\ncategory: memory\n---\ntext".to_string();
        let create = Invocation::CreateFile { path: "notes/plan.md".into(), content: note };
        let mut asked = String::new();
        let created = tools.run(&create, &mut |change: &str| {
            asked = change.to_string();
            true
        });
        fs::remove_dir_all(&cwd).unwrap();
        assert!(created.is_ok());
        assert!(!asked.contains("hook lines"), "{asked}");
        assert!(!tools.profile_written("plan"));
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
