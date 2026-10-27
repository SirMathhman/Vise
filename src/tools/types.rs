use std::collections::HashMap;
use std::fmt;

pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: String,
}

pub enum ParamType {
    String,
    Integer { min: Option<u32>, max: Option<u32> },
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
}

#[derive(Debug)]
pub enum ToolError {
    UnknownTool(String),
    InvalidArguments(String),
    Failed(String),
}

impl fmt::Display for ToolError {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        match self {
            Self::UnknownTool(name) => write!(f, "unknown tool '{name}'"),
            Self::InvalidArguments(msg) => write!(f, "invalid arguments: {msg}"),
            Self::Failed(msg) => write!(f, "{msg}"),
        }
    }
}

impl std::error::Error for ToolError {}

pub enum Value {
    Text(String),
    Integer(i64),
}

/// Named argument values that have been checked against a `ToolSpec`'s parameters.
pub struct Arguments {
    values: HashMap<String, Value>,
}

impl Arguments {
    pub fn validated(spec: &ToolSpec, values: HashMap<String, Value>) -> Result<Self, ToolError> {
        for param in spec.params {
            let value = values
                .get(param.name)
                .ok_or_else(|| ToolError::InvalidArguments(format!("missing '{}'", param.name)))?;
            match (&param.kind, value) {
                (ParamType::String, Value::Text(_)) => {}
                (ParamType::Integer { min, max }, Value::Integer(n)) => {
                    if min.is_some_and(|min| *n < i64::from(min)) || max.is_some_and(|max| *n > i64::from(max)) {
                        return Err(ToolError::InvalidArguments(format!("'{}' is out of range", param.name)));
                    }
                }
                _ => return Err(ToolError::InvalidArguments(format!("'{}' has the wrong type", param.name))),
            }
        }
        Ok(Self { values })
    }

    pub fn text(&self, name: &str) -> Result<&str, ToolError> {
        match self.values.get(name) {
            Some(Value::Text(text)) => Ok(text),
            _ => Err(ToolError::InvalidArguments(format!("'{name}' must be text"))),
        }
    }

    pub fn integer(&self, name: &str) -> Result<i64, ToolError> {
        match self.values.get(name) {
            Some(Value::Integer(n)) => Ok(*n),
            _ => Err(ToolError::InvalidArguments(format!("'{name}' must be an integer"))),
        }
    }
}

pub enum Invocation {
    ListDirectory { path: String, depth: u8 },
    ReadFile { path: String, start: usize, end: usize },
}

pub trait ToolRunner {
    fn run(&self, invocation: &Invocation) -> Result<String, ToolError>;
}
