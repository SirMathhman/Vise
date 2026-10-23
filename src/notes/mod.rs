//! Notes: Markdown files kept in `.vise/notes/<category>/<name>.md`. Local notes sit in the working directory.
//! Global notes sit in the home directory and are shared by every project. The model and the user can list,
//! read, create, edit and delete both. A note's text reaches the model only when the model reads it; the
//! summaries of notes are listed at the start of a conversation.
//!
//! `store` holds the paths and file operations, and `index` holds the summaries. This module is the surface
//! the tools, the `/notes` command and the web UI call.

mod index;
mod profile;
mod store;
#[cfg(test)]
mod tests;

use std::fs;

use serde_json::{Value, json};

use crate::workspace;

pub use index::with_index;
pub use profile::{Profile, command as profile_command, read as read_profile};
pub use store::Roots;

use index::{note_entries, profile_entries};
use store::{GLOBAL, LOCAL, SCOPES, create, delete, note_files, note_names, note_path, scope_of, show, update};

pub const LIST_NOTES: &str = "list_notes";
pub const READ_NOTE: &str = "read_note";
pub const CREATE_NOTE: &str = "create_note";
pub const EDIT_NOTE: &str = "edit_note";
pub const DELETE_NOTE: &str = "delete_note";

const NO_NOTES: &str = "no notes";

pub fn definitions() -> Vec<Value> {
    vec![
        json!({
            "type": "function",
            "function": {
                "name": LIST_NOTES,
                "description": "List every note as scope category/name. The scope is local (this working directory's .vise/notes) or global (the home directory's .vise/notes, shared by every project).",
                "parameters": { "type": "object", "properties": {} }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": READ_NOTE,
                "description": "Read lines from a note. Lines are 1-based: start is included and end is excluded, like read_file. Each returned line is prefixed with its line number and a tab.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "scope": { "type": "string", "enum": [LOCAL, GLOBAL], "description": "local (the default) or global" },
                        "category": { "type": "string", "description": "Category directory: letters, digits, '-' and '_' only" },
                        "name": { "type": "string", "description": "Note name without .md: letters, digits, '-' and '_' only" },
                        "start": { "type": "integer", "minimum": 1, "description": "First line to return, 1-based and included" },
                        "end": { "type": "integer", "minimum": 1, "description": "Line after the last one to return, 1-based and excluded" }
                    },
                    "required": ["category", "name", "start", "end"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": CREATE_NOTE,
                "description": "Create a note with the given content. The content must start with frontmatter between --- lines that gives name and summary. Fails if the note already exists. The category directory is created when needed.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "scope": { "type": "string", "enum": [LOCAL, GLOBAL], "description": "local (the default) or global" },
                        "category": { "type": "string", "description": "Category directory: letters, digits, '-' and '_' only" },
                        "name": { "type": "string", "description": "Note name without .md: letters, digits, '-' and '_' only" },
                        "content": { "type": "string", "description": "Full text of the new note" }
                    },
                    "required": ["category", "name", "content"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": EDIT_NOTE,
                "description": "Replace one passage of a note. old must match the note's text exactly and occur exactly once, so include enough surrounding text to make it unique. It is replaced by new.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "scope": { "type": "string", "enum": [LOCAL, GLOBAL], "description": "local (the default) or global" },
                        "category": { "type": "string", "description": "Category directory: letters, digits, '-' and '_' only" },
                        "name": { "type": "string", "description": "Note name without .md: letters, digits, '-' and '_' only" },
                        "old": { "type": "string", "description": "Exact text to replace; must occur exactly once in the note" },
                        "new": { "type": "string", "description": "Text to put in its place" }
                    },
                    "required": ["category", "name", "old", "new"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": DELETE_NOTE,
                "description": "Delete a note. Fails if the note does not exist.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "scope": { "type": "string", "enum": [LOCAL, GLOBAL], "description": "local (the default) or global" },
                        "category": { "type": "string", "description": "Category directory: letters, digits, '-' and '_' only" },
                        "name": { "type": "string", "description": "Note name without .md: letters, digits, '-' and '_' only" }
                    },
                    "required": ["category", "name"]
                }
            }
        }),
    ]
}

/// Runs a note tool. The caller has already matched `name` to one of the tools above.
pub fn run(name: &str, arguments: &str, roots: Roots) -> Result<String, String> {
    let args: Value = serde_json::from_str(arguments).map_err(|err| format!("invalid arguments: {err}"))?;
    match name {
        LIST_NOTES => list(roots),
        READ_NOTE => read(&args, roots),
        CREATE_NOTE => create(&args, roots),
        EDIT_NOTE => edit(&args, roots),
        DELETE_NOTE => delete(&args, roots),
        _ => Err(format!("unknown tool {name}")),
    }
}

/// Handles a `/notes` line typed by the user: `/notes` lists every note, and `/notes <scope>/<category>/<name>`
/// shows one. Returns the text to show, or `None` if the line is not this command.
pub fn command(line: &str, roots: Roots) -> Option<String> {
    let mut words = line.split_whitespace();
    if words.next()? != "/notes" {
        return None;
    }
    Some(match words.next() {
        None => text(list(roots)),
        Some(note) => text(show_path(note, roots)),
    })
}

/// The web UI's notes requests. `action` is `list`, `read`, `create`, `update` or `delete`; the other fields are
/// the same as the tools'.
pub fn web(body: &Value, roots: Roots) -> Result<Value, String> {
    match body["action"].as_str() {
        Some("list") => Ok(json!({ "notes": note_entries(roots)? })),
        Some("profiles") => Ok(json!({ "notes": profile_entries(roots)? })),
        Some("read") => {
            let scope = scope_of(body)?;
            let (category, name) = note_names(body)?;
            Ok(json!({ "text": show(scope, category, name, roots)? }))
        }
        Some("create") => create(body, roots).map(|message| json!({ "message": message })),
        Some("update") => update(body, roots).map(|message| json!({ "message": message })),
        Some("delete") => delete(body, roots).map(|message| json!({ "message": message })),
        _ => Err("unknown action".to_owned()),
    }
}

fn text(result: Result<String, String>) -> String {
    result.unwrap_or_else(|err| format!("error: {err}"))
}

/// Shows the note named by `scope/category/name`, as typed after `/notes`.
fn show_path(note: &str, roots: Roots) -> Result<String, String> {
    let parts: Vec<&str> = note.split('/').collect();
    match parts.as_slice() {
        [scope, category, name] if SCOPES.contains(scope) => show(scope, category, name, roots),
        _ => Err("usage: /notes or /notes <local|global>/<category>/<name>".to_owned()),
    }
}

fn list(roots: Roots) -> Result<String, String> {
    let mut lines = Vec::new();
    for scope in SCOPES {
        for (category, name) in note_files(scope, roots)? {
            lines.push(format!("{scope} {category}/{name}"));
        }
    }
    if lines.is_empty() {
        return Ok(NO_NOTES.to_owned());
    }
    Ok(lines.join("\n"))
}

fn read(args: &Value, roots: Roots) -> Result<String, String> {
    let scope = scope_of(args)?;
    let (category, name) = note_names(args)?;
    let (start, end) = workspace::line_range(args)?;
    let target = note_path(scope, roots, category, name)?;
    workspace::read_range(&format!("{category}/{name}"), &target, start, end)
}

fn edit(args: &Value, roots: Roots) -> Result<String, String> {
    let scope = scope_of(args)?;
    let (category, name) = note_names(args)?;
    let old = workspace::string_arg(args, "old")?;
    let new = workspace::string_arg(args, "new")?;
    if old.is_empty() {
        return Err("old must not be empty".to_owned());
    }
    let target = note_path(scope, roots, category, name)?;
    let text = fs::read_to_string(&target).map_err(|err| format!("could not read {category}/{name}: {err}"))?;
    match text.matches(old).count() {
        0 => Err(format!("old text not found in {category}/{name}")),
        1 => {
            fs::write(&target, text.replacen(old, new, 1))
                .map_err(|err| format!("could not write {category}/{name}: {err}"))?;
            Ok(format!("edited {category}/{name}"))
        }
        count => Err(format!(
            "old text occurs {count} times in {category}/{name}; include more surrounding text so it occurs once"
        )),
    }
}
