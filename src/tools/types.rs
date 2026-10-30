use std::collections::HashMap;
use std::fmt;
use std::path::PathBuf;

/// The first line of `text`, trimmed, so a multi-line command reads as one line in the display, with a note of how many
/// lines the rest holds. An empty command gives `None`, so the call reads as its name alone rather than as a trailing
/// space.
fn first_line(text: &str) -> Option<String> {
    let first = text.lines().next().unwrap_or_default().trim();
    if first.is_empty() {
        return None;
    }
    let rest = text.lines().count().saturating_sub(1);
    Some(if rest > 0 { format!("{first} (+{rest} more lines)") } else { first.to_string() })
}

#[derive(Debug)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: HashMap<String, Value>,
}

pub enum ParamType {
    String,
    Integer { min: Option<u32>, max: Option<u32> },
    Boolean,
}

pub struct Param {
    pub name: &'static str,
    pub kind: ParamType,
    pub description: &'static str,
}

pub struct ToolSpec {
    pub name: &'static str,
    pub description: &'static str,
    pub params: &'static [Param],
    pub bind: fn(&Arguments) -> Result<Invocation, ToolError>,
}

#[derive(Debug)]
pub enum ToolError {
    UnknownTool(String),
    Disabled(String),
    InvalidArguments(String),
    Failed(String),
}

impl fmt::Display for ToolError {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        match self {
            Self::UnknownTool(name) => write!(f, "unknown tool '{name}'"),
            Self::Disabled(name) => write!(f, "tool '{name}' is disabled"),
            Self::InvalidArguments(msg) => write!(f, "invalid arguments: {msg}"),
            Self::Failed(msg) => write!(f, "{msg}"),
        }
    }
}

impl std::error::Error for ToolError {}

#[derive(Clone, Debug)]
pub enum Value {
    Text(String),
    Integer(i64),
    Bool(bool),
    Unsupported,
}

/// Named argument values that have been checked against a `ToolSpec`'s parameters.
pub struct Arguments {
    values: HashMap<String, Value>,
}

impl Arguments {
    pub(super) fn validated(spec: &ToolSpec, values: HashMap<String, Value>) -> Result<Self, ToolError> {
        for param in spec.params {
            let value = values
                .get(param.name)
                .ok_or_else(|| ToolError::InvalidArguments(format!("missing '{}'", param.name)))?;
            match (&param.kind, value) {
                (ParamType::String, Value::Text(_)) => {}
                (ParamType::Boolean, Value::Bool(_)) => {}
                (ParamType::Integer { min, max }, Value::Integer(n)) => {
                    if min.is_some_and(|min| *n < i64::from(min)) || max.is_some_and(|max| *n > i64::from(max)) {
                        return Err(ToolError::InvalidArguments(format!("'{}' is out of range", param.name)));
                    }
                }
                _ => return Err(ToolError::InvalidArguments(format!("'{}' has the wrong type", param.name))),
            }
        }
        for name in values.keys() {
            if !spec.params.iter().any(|param| param.name == name) {
                return Err(ToolError::InvalidArguments(format!("unknown field '{name}'")));
            }
        }
        Ok(Self { values })
    }

    pub(super) fn text(&self, name: &str) -> Result<&str, ToolError> {
        match self.values.get(name) {
            Some(Value::Text(text)) => Ok(text),
            _ => Err(ToolError::InvalidArguments(format!("'{name}' must be text"))),
        }
    }

    pub(super) fn integer(&self, name: &str) -> Result<i64, ToolError> {
        match self.values.get(name) {
            Some(Value::Integer(n)) => Ok(*n),
            _ => Err(ToolError::InvalidArguments(format!("'{name}' must be an integer"))),
        }
    }

    pub(super) fn boolean(&self, name: &str) -> Result<bool, ToolError> {
        match self.values.get(name) {
            Some(Value::Bool(flag)) => Ok(*flag),
            _ => Err(ToolError::InvalidArguments(format!("'{name}' must be true or false"))),
        }
    }
}

pub enum Invocation {
    ListDirectory { path: String, depth: u8 },
    ReadFile { path: String, start: usize, end: usize },
    CreateFile { path: String, content: String },
    CreateDirectory { path: String },
    EditFile { path: String, previous: String, new: String },
    RunPowerShell { command: String, timeout_secs: u64, background: bool },
    ReadBackground { id: usize },
    KillBackground { id: usize },
    ListNotes { category: String },
    ReadNote { name: String },
    CreateNote { name: String, summary: String, category: String, content: String },
    UpdateNote { name: String, summary: String, category: String, content: String },
    DeleteNote { name: String },
    /// Starts a subagent. The provider runs it, because the subagent needs the session's turn logic.
    RunSubagent { profile: String, task: String },
}

impl Invocation {
    /// The name of the tool this invocation came from.
    pub fn tool_name(&self) -> &'static str {
        match self {
            Self::ListDirectory { .. } => "list_directory",
            Self::ReadFile { .. } => "read_file",
            Self::CreateFile { .. } => "create_file",
            Self::CreateDirectory { .. } => "create_directory",
            Self::EditFile { .. } => "edit_file",
            Self::RunPowerShell { .. } => "run_powershell",
            Self::ReadBackground { .. } => "read_background",
            Self::KillBackground { .. } => "kill_background",
            Self::ListNotes { .. } => "list_notes",
            Self::ReadNote { .. } => "read_note",
            Self::CreateNote { .. } => "create_note",
            Self::UpdateNote { .. } => "update_note",
            Self::DeleteNote { .. } => "delete_note",
            Self::RunSubagent { .. } => "run_subagent",
        }
    }

    /// The note this invocation names, if it names one.
    pub fn note_name(&self) -> Option<&str> {
        match self {
            Self::ReadNote { name }
            | Self::CreateNote { name, .. }
            | Self::UpdateNote { name, .. }
            | Self::DeleteNote { name } => Some(name),
            _ => None,
        }
    }

    /// What this invocation acts on, as one short line: the path, the command's first line, or the note's name. `None`
    /// when the arguments name nothing the user would recognize, such as listing notes of every category.
    pub fn target(&self) -> Option<String> {
        match self {
            Self::ListDirectory { path, .. }
            | Self::ReadFile { path, .. }
            | Self::CreateFile { path, .. }
            | Self::CreateDirectory { path }
            | Self::EditFile { path, .. } => Some(path.clone()),
            Self::RunPowerShell { command, .. } => first_line(command),
            Self::ReadBackground { id } | Self::KillBackground { id } => Some(format!("task {id}")),
            Self::ListNotes { category } => Some(category.clone()).filter(|name| !name.is_empty()),
            Self::ReadNote { name }
            | Self::CreateNote { name, .. }
            | Self::UpdateNote { name, .. }
            | Self::DeleteNote { name } => Some(name.clone()),
            Self::RunSubagent { profile, .. } => Some(profile.clone()),
        }
    }

    /// Whether running this changes the filesystem or runs a program, so it needs approval and is never
    /// replayed. Reading a background task's output or a note changes nothing.
    pub fn writes(&self) -> bool {
        match self {
            Self::ListDirectory { .. }
            | Self::ReadFile { .. }
            | Self::ReadBackground { .. }
            | Self::ListNotes { .. }
            | Self::ReadNote { .. }
            // Starting a subagent is not itself a write: each write the subagent makes is approved on its own.
            | Self::RunSubagent { .. } => false,
            Self::CreateFile { .. }
            | Self::CreateDirectory { .. }
            | Self::EditFile { .. }
            | Self::RunPowerShell { .. }
            | Self::KillBackground { .. }
            | Self::CreateNote { .. }
            | Self::UpdateNote { .. }
            | Self::DeleteNote { .. } => true,
        }
    }
}

pub trait ToolRunner {
    /// Runs an invocation. `approve` shows a proposed change and returns whether the user accepted it;
    /// it is called only for invocations that write.
    fn run(&self, invocation: &Invocation, approve: &mut dyn FnMut(&str) -> bool) -> Result<String, ToolError>;

    /// Runs one line of a command file (startup or shutdown). The user wrote the file, so the line runs whatever
    /// tools the model may call. A runner without tool state runs it through `run`.
    fn run_command_file_line(&self, invocation: &Invocation) -> Result<String, ToolError> {
        self.run(invocation, &mut |_: &str| true)
    }

    /// The names of the tools the model may call. Every tool is enabled unless the runner says otherwise.
    fn enabled(&self) -> Vec<&'static str> {
        super::specs().iter().map(|spec| spec.name).collect()
    }

    /// Enables or disables one tool. A runner without tool state refuses the change.
    fn set_enabled(&self, _name: &str, _on: bool) -> Result<(), ToolError> {
        Err(ToolError::Failed("tools cannot be changed here".into()))
    }

    /// The folder the notes are kept in. A runner with no working directory uses the notes folder of the process.
    fn notes_folder(&self) -> PathBuf {
        PathBuf::from(crate::notes::FOLDER)
    }

    /// The notes the model may use, or `None` for all of them.
    fn allowed_notes(&self) -> Option<Vec<String>> {
        None
    }

    /// Sets the notes the model may use, or `None` for all of them. A runner without that state ignores it.
    fn set_allowed_notes(&self, _names: Option<Vec<String>>) {}

    /// Whether the model wrote the profile `name` through the file tools, and the user has not selected it since. A
    /// subagent runs such a profile without its hook lines, which would otherwise run with no prompt.
    fn profile_written(&self, _name: &str) -> bool {
        false
    }

    /// Records that the user selected the profile `name`, so its hook lines may run again.
    fn confirm_profile(&self, _name: &str) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_write_variant_writes() {
        assert!(Invocation::CreateFile { path: "a".into(), content: String::new() }.writes());
        assert!(Invocation::CreateDirectory { path: "a".into() }.writes());
        assert!(Invocation::EditFile { path: "a".into(), previous: "x".into(), new: "y".into() }.writes());
        assert!(!Invocation::ListDirectory { path: ".".into(), depth: 1 }.writes());
        assert!(!Invocation::ReadFile { path: "a".into(), start: 1, end: 1 }.writes());
    }

    #[test]
    fn target_names_what_each_call_acts_on() {
        let cases = [
            (Invocation::ListDirectory { path: "src".into(), depth: 1 }, Some("src")),
            (Invocation::ReadFile { path: "a.rs".into(), start: 1, end: 2 }, Some("a.rs")),
            (Invocation::CreateFile { path: "b.rs".into(), content: "x".into() }, Some("b.rs")),
            (Invocation::CreateDirectory { path: "c".into() }, Some("c")),
            (Invocation::EditFile { path: "d.rs".into(), previous: "x".into(), new: "y".into() }, Some("d.rs")),
            (Invocation::ReadBackground { id: 3 }, Some("task 3")),
            (Invocation::KillBackground { id: 4 }, Some("task 4")),
            (Invocation::ListNotes { category: "work".into() }, Some("work")),
            (Invocation::ListNotes { category: String::new() }, None),
            (Invocation::ReadNote { name: "n".into() }, Some("n")),
            (Invocation::DeleteNote { name: "m".into() }, Some("m")),
            (Invocation::RunSubagent { profile: "p".into(), task: "t".into() }, Some("p")),
            (
                Invocation::RunPowerShell { command: "Get-ChildItem".into(), timeout_secs: 5, background: false },
                Some("Get-ChildItem"),
            ),
        ];
        for (invocation, expected) in cases {
            assert_eq!(invocation.target().as_deref(), expected, "for {}", invocation.tool_name());
        }
    }

    #[test]
    fn a_command_reports_its_first_line_and_how_many_more() {
        let invocation = Invocation::RunPowerShell {
            command: "cd C:\\repo\nRemove-Item -Recurse .".into(),
            timeout_secs: 5,
            background: false,
        };
        assert_eq!(invocation.target().as_deref(), Some("cd C:\\repo (+1 more lines)"));
    }

    #[test]
    fn an_empty_command_names_nothing() {
        let invocation =
            Invocation::RunPowerShell { command: "   \n  ".into(), timeout_secs: 5, background: false };
        assert_eq!(invocation.target(), None, "the line reads as the tool's name alone");
    }
}
