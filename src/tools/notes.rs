//! The model's note tools. Each one binds its arguments to an invocation; the runner carries it out through
//! the `run_*` functions at the end of this file.

use super::types::{Arguments, Invocation, Param, ParamType, ToolError, ToolSpec};
use crate::notes::{self, Note};

const NAME: Param = Param {
    name: "name",
    kind: ParamType::String,
    description: "The note's name: letters, digits, '-' and '_' only.",
};
const SUMMARY: Param = Param { name: "summary", kind: ParamType::String, description: "A one-line summary." };
const CATEGORY: Param = Param {
    name: "category",
    kind: ParamType::String,
    description: "A free-text category, such as 'skill' or 'memory'.",
};
const CONTENT: Param = Param { name: "content", kind: ParamType::String, description: "The note's full content." };

pub const LIST: ToolSpec = ToolSpec {
    name: "list_notes",
    description: "List the notes: each one's name, category and summary. An empty category lists every note.",
    params: &[Param {
        name: "category",
        kind: ParamType::String,
        description: "Only notes in this category, or an empty string for all notes.",
    }],
    bind: bind_list,
};

pub const READ: ToolSpec = ToolSpec {
    name: "read_note",
    description: "Read one note: its summary, category and content.",
    params: &[NAME],
    bind: bind_read,
};

pub const CREATE: ToolSpec = ToolSpec {
    name: "create_note",
    description: "Create a note. The user approves it. It fails if a note with that name exists.",
    params: &[NAME, SUMMARY, CATEGORY, CONTENT],
    bind: bind_create,
};

pub const UPDATE: ToolSpec = ToolSpec {
    name: "update_note",
    description: "Replace a note's summary, category and content. The user approves it. It fails if no such note exists.",
    params: &[NAME, SUMMARY, CATEGORY, CONTENT],
    bind: bind_update,
};

pub const DELETE: ToolSpec = ToolSpec {
    name: "delete_note",
    description: "Delete a note. The user approves it.",
    params: &[NAME],
    bind: bind_delete,
};

fn bind_list(args: &Arguments) -> Result<Invocation, ToolError> {
    Ok(Invocation::ListNotes { category: args.text("category")?.to_string() })
}

fn bind_read(args: &Arguments) -> Result<Invocation, ToolError> {
    Ok(Invocation::ReadNote { name: args.text("name")?.to_string() })
}

fn bind_create(args: &Arguments) -> Result<Invocation, ToolError> {
    Ok(Invocation::CreateNote {
        name: args.text("name")?.to_string(),
        summary: args.text("summary")?.to_string(),
        category: args.text("category")?.to_string(),
        content: args.text("content")?.to_string(),
    })
}

fn bind_update(args: &Arguments) -> Result<Invocation, ToolError> {
    Ok(Invocation::UpdateNote {
        name: args.text("name")?.to_string(),
        summary: args.text("summary")?.to_string(),
        category: args.text("category")?.to_string(),
        content: args.text("content")?.to_string(),
    })
}

fn bind_delete(args: &Arguments) -> Result<Invocation, ToolError> {
    Ok(Invocation::DeleteNote { name: args.text("name")?.to_string() })
}

pub fn run_list(category: &str) -> Result<String, ToolError> {
    let listed = notes::list(category).map_err(ToolError::Failed)?;
    Ok(if listed.is_empty() { "no notes".to_string() } else { notes::describe_list(&listed) })
}

pub fn run_read(name: &str) -> Result<String, ToolError> {
    notes::read(name).map(|note| notes::show(&note)).map_err(ToolError::Failed)
}

pub fn run_create(name: &str, summary: &str, category: &str, content: &str) -> Result<String, ToolError> {
    notes::create(name, &note(summary, category, content)).map_err(ToolError::Failed)?;
    Ok(format!("created note '{name}'"))
}

pub fn run_update(name: &str, summary: &str, category: &str, content: &str) -> Result<String, ToolError> {
    notes::update(name, &note(summary, category, content)).map_err(ToolError::Failed)?;
    Ok(format!("updated note '{name}'"))
}

pub fn run_delete(name: &str) -> Result<String, ToolError> {
    notes::delete(name).map_err(ToolError::Failed)?;
    Ok(format!("deleted note '{name}'"))
}

fn note(summary: &str, category: &str, content: &str) -> Note {
    Note { summary: summary.to_string(), category: category.to_string(), content: content.to_string() }
}
