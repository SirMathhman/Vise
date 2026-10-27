use std::collections::HashMap;
use std::fmt;

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

#[derive(Clone)]
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
        }
    }

    /// Whether running this changes the filesystem or runs a program, so it needs approval and is never
    /// replayed. Reading a background task's output changes nothing.
    pub fn writes(&self) -> bool {
        match self {
            Self::ListDirectory { .. } | Self::ReadFile { .. } | Self::ReadBackground { .. } => false,
            Self::CreateFile { .. }
            | Self::CreateDirectory { .. }
            | Self::EditFile { .. }
            | Self::RunPowerShell { .. }
            | Self::KillBackground { .. } => true,
        }
    }
}

pub trait ToolRunner {
    /// Runs an invocation. `approve` shows a proposed change and returns whether the user accepted it;
    /// it is called only for invocations that write.
    fn run(&self, invocation: &Invocation, approve: &mut dyn FnMut(&str) -> bool) -> Result<String, ToolError>;

    /// The names of the tools the model may call. Every tool is enabled unless the runner says otherwise.
    fn enabled(&self) -> Vec<&'static str> {
        super::specs().iter().map(|spec| spec.name).collect()
    }

    /// Enables or disables one tool. A runner without tool state refuses the change.
    fn set_enabled(&self, _name: &str, _on: bool) -> Result<(), ToolError> {
        Err(ToolError::Failed("tools cannot be changed here".into()))
    }
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
}
