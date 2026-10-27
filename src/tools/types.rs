use std::fmt;

pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: String,
}

pub enum ParamType {
    String,
    Integer { min: u8, max: u8 },
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

pub trait ToolRunner {
    fn run(&self, call: &ToolCall) -> Result<String, ToolError>;
}
