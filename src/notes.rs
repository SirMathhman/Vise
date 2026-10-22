//! Notes: Markdown files kept in `.vise/notes/<category>/<name>.md` under the working directory. The model
//! and the user can list, read, create, edit and delete them. A note reaches the model only when the model
//! reads it, so nothing is added to the prompt automatically.

use std::fs::{self, DirEntry, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use crate::workspace;

pub const LIST_NOTES: &str = "list_notes";
pub const READ_NOTE: &str = "read_note";
pub const CREATE_NOTE: &str = "create_note";
pub const EDIT_NOTE: &str = "edit_note";
pub const DELETE_NOTE: &str = "delete_note";

const NOTES_DIR: &str = ".vise/notes";
const NO_NOTES: &str = "no notes";

pub fn definitions() -> Vec<Value> {
    vec![
        json!({
            "type": "function",
            "function": {
                "name": LIST_NOTES,
                "description": "List every note as category/name. Notes are stored under .vise/notes in the working directory.",
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
                "description": "Create a note with the given content. Fails if the note already exists. The category directory is created when needed.",
                "parameters": {
                    "type": "object",
                    "properties": {
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
pub fn run(name: &str, arguments: &str, root: Option<&Path>) -> Result<String, String> {
    let args: Value = serde_json::from_str(arguments).map_err(|err| format!("invalid arguments: {err}"))?;
    match name {
        LIST_NOTES => list(root),
        READ_NOTE => read(&args, root),
        CREATE_NOTE => create(&args, root),
        EDIT_NOTE => edit(&args, root),
        DELETE_NOTE => delete(&args, root),
        _ => Err(format!("unknown tool {name}")),
    }
}

/// Handles a `/notes` or `/note <category>/<name>` line typed by the user. Returns the text to show,
/// or `None` if the line is not one of these commands.
pub fn command(line: &str, root: Option<&Path>) -> Option<String> {
    let mut words = line.split_whitespace();
    match words.next()? {
        "/notes" => Some(text(list(root))),
        "/note" => Some(match words.next().and_then(|note| note.split_once('/')) {
            Some((category, name)) => text(show(category, name, root)),
            None => "usage: /note <category>/<name>".to_owned(),
        }),
        _ => None,
    }
}

fn text(result: Result<String, String>) -> String {
    result.unwrap_or_else(|err| format!("error: {err}"))
}

fn note_names(args: &Value) -> Result<(&str, &str), String> {
    Ok((workspace::string_arg(args, "category")?, workspace::string_arg(args, "name")?))
}

/// A note's path inside the working directory. Both names are checked first, so no name can reach
/// outside the notes directory.
fn note_path(root: Option<&Path>, category: &str, name: &str) -> Result<PathBuf, String> {
    check_segment("category", category)?;
    check_segment("name", name)?;
    workspace::resolve(root, &format!("{NOTES_DIR}/{category}/{name}.md"), false)
}

fn check_segment(what: &str, value: &str) -> Result<(), String> {
    let plain = !value.is_empty() && value.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if plain {
        Ok(())
    } else {
        Err(format!("{what} may only use letters, digits, '-' and '_': {value:?}"))
    }
}

/// The entries of a directory, sorted by name, so listings are stable.
fn entries(dir: &Path) -> Result<Vec<DirEntry>, String> {
    let mut found = fs::read_dir(dir)
        .and_then(|reader| reader.collect::<Result<Vec<_>, _>>())
        .map_err(|err| format!("could not read {}: {err}", dir.display()))?;
    found.sort_by_key(DirEntry::file_name);
    Ok(found)
}

fn list(root: Option<&Path>) -> Result<String, String> {
    let dir = workspace::resolve(root, NOTES_DIR, false)?;
    if !dir.is_dir() {
        return Ok(NO_NOTES.to_owned());
    }
    let mut notes = Vec::new();
    for category in entries(&dir)? {
        if !category.file_type().is_ok_and(|kind| kind.is_dir()) {
            continue;
        }
        let category_name = category.file_name().to_string_lossy().into_owned();
        for note in entries(&category.path())? {
            let file = note.file_name().to_string_lossy().into_owned();
            let is_file = note.file_type().is_ok_and(|kind| kind.is_file());
            if let (true, Some(name)) = (is_file, file.strip_suffix(".md")) {
                notes.push(format!("{category_name}/{name}"));
            }
        }
    }
    if notes.is_empty() {
        Ok(NO_NOTES.to_owned())
    } else {
        Ok(notes.join("\n"))
    }
}

fn read(args: &Value, root: Option<&Path>) -> Result<String, String> {
    let (category, name) = note_names(args)?;
    let (start, end) = workspace::line_range(args)?;
    let target = note_path(root, category, name)?;
    workspace::read_range(&format!("{category}/{name}"), &target, start, end)
}

/// The whole text of a note, for the user's `/note` command.
fn show(category: &str, name: &str, root: Option<&Path>) -> Result<String, String> {
    let target = note_path(root, category, name)?;
    fs::read_to_string(&target).map_err(|err| format!("could not read {category}/{name}: {err}"))
}

fn create(args: &Value, root: Option<&Path>) -> Result<String, String> {
    let (category, name) = note_names(args)?;
    let content = workspace::string_arg(args, "content")?;
    let target = note_path(root, category, name)?;
    if target.exists() {
        return Err(format!("already exists: {category}/{name}"));
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|err| format!("could not create {category}: {err}"))?;
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&target)
        .map_err(|err| format!("could not create {category}/{name}: {err}"))?;
    file.write_all(content.as_bytes())
        .map_err(|err| format!("could not write {category}/{name}: {err}"))?;
    Ok(format!("created {category}/{name}"))
}

fn edit(args: &Value, root: Option<&Path>) -> Result<String, String> {
    let (category, name) = note_names(args)?;
    let old = workspace::string_arg(args, "old")?;
    let new = workspace::string_arg(args, "new")?;
    if old.is_empty() {
        return Err("old must not be empty".to_owned());
    }
    let target = note_path(root, category, name)?;
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

fn delete(args: &Value, root: Option<&Path>) -> Result<String, String> {
    let (category, name) = note_names(args)?;
    let target = note_path(root, category, name)?;
    fs::remove_file(&target).map_err(|err| format!("could not delete {category}/{name}: {err}"))?;
    Ok(format!("deleted {category}/{name}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh working directory for one test.
    fn root(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("vise-notes-{}-{label}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn call(name: &str, args: Value, root: &Path) -> Result<String, String> {
        run(name, &args.to_string(), Some(root))
    }

    #[test]
    fn a_note_can_be_created_read_edited_listed_and_deleted() {
        let root = root("round-trip");
        let created = call(CREATE_NOTE, json!({ "category": "work", "name": "plan", "content": "a\nb\nc\n" }), &root);
        let listed = call(LIST_NOTES, json!({}), &root);
        let read_back = call(READ_NOTE, json!({ "category": "work", "name": "plan", "start": 2, "end": 4 }), &root);
        let edited = call(EDIT_NOTE, json!({ "category": "work", "name": "plan", "old": "b\n", "new": "B\n" }), &root);
        let after_edit = fs::read_to_string(root.join(".vise/notes/work/plan.md")).unwrap();
        let deleted = call(DELETE_NOTE, json!({ "category": "work", "name": "plan" }), &root);
        let listed_again = call(LIST_NOTES, json!({}), &root);
        fs::remove_dir_all(&root).unwrap();

        assert_eq!(created, Ok("created work/plan".to_owned()));
        assert_eq!(listed, Ok("work/plan".to_owned()));
        assert_eq!(read_back, Ok("2\tb\n3\tc".to_owned()));
        assert_eq!(edited, Ok("edited work/plan".to_owned()));
        assert_eq!(after_edit, "a\nB\nc\n");
        assert_eq!(deleted, Ok("deleted work/plan".to_owned()));
        assert_eq!(listed_again, Ok(NO_NOTES.to_owned()));
    }

    #[test]
    fn edit_needs_exactly_one_match() {
        let root = root("edit-match");
        call(CREATE_NOTE, json!({ "category": "c", "name": "n", "content": "x x" }), &root).unwrap();
        let repeated = call(EDIT_NOTE, json!({ "category": "c", "name": "n", "old": "x", "new": "y" }), &root);
        let missing = call(EDIT_NOTE, json!({ "category": "c", "name": "n", "old": "z", "new": "y" }), &root);
        fs::remove_dir_all(&root).unwrap();

        assert!(repeated.unwrap_err().starts_with("old text occurs 2 times"));
        assert_eq!(missing, Err("old text not found in c/n".to_owned()));
    }

    #[test]
    fn names_must_be_plain_segments() {
        let root = root("names");
        let parent = call(CREATE_NOTE, json!({ "category": "..", "name": "x", "content": "" }), &root);
        let slash = call(CREATE_NOTE, json!({ "category": "a", "name": "b/c", "content": "" }), &root);
        let empty = call(CREATE_NOTE, json!({ "category": "a", "name": "", "content": "" }), &root);
        fs::remove_dir_all(&root).unwrap();

        assert!(parent.unwrap_err().contains("may only use"));
        assert!(slash.unwrap_err().contains("may only use"));
        assert!(empty.unwrap_err().contains("may only use"));
    }
}
