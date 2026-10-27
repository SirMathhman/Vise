//! Notes: one file per note in the `notes` folder of the working directory. A file starts with a `---` block
//! holding `summary:` and `category:` lines, then the content. The model is told each note's name, category
//! and summary, and reads the content when it needs it.

use crate::session::Message;
use std::fs;
use std::io::{self, Write};
use std::path::PathBuf;

const FOLDER: &str = "notes";
const MARK: &str = "[Notes]";
const NONE: &str = "[Notes]\n(none)";

pub struct Note {
    pub summary: String,
    pub category: String,
    pub content: String,
}

/// The file for a note. Only letters, digits, '-' and '_' are accepted in a name, so a name cannot reach
/// outside the folder.
fn path(name: &str) -> Result<PathBuf, String> {
    let valid = !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !valid {
        return Err(format!("'{name}' is not a note name; use letters, digits, '-' and '_'"));
    }
    Ok(PathBuf::from(FOLDER).join(format!("{name}.md")))
}

/// The summary and category are one line each, and neither may be empty.
fn check(note: &Note) -> Result<(), String> {
    for (field, value) in [("summary", &note.summary), ("category", &note.category)] {
        if value.contains('\n') || value.trim().is_empty() {
            return Err(format!("the {field} must be one non-empty line"));
        }
    }
    Ok(())
}

fn format(note: &Note) -> String {
    format!("---\nsummary: {}\ncategory: {}\n---\n{}", note.summary, note.category, note.content)
}

fn parse(text: &str) -> Result<Note, String> {
    let rest = text.strip_prefix("---\n").ok_or_else(|| "the note has no header".to_string())?;
    let (header, content) = rest.split_once("\n---\n").ok_or_else(|| "the note's header is not closed".to_string())?;
    let (mut summary, mut category) = (None, None);
    for line in header.lines() {
        if let Some(value) = line.strip_prefix("summary: ") {
            summary = Some(value.to_string());
        } else if let Some(value) = line.strip_prefix("category: ") {
            category = Some(value.to_string());
        }
    }
    Ok(Note {
        summary: summary.ok_or_else(|| "the note has no summary line".to_string())?,
        category: category.ok_or_else(|| "the note has no category line".to_string())?,
        content: content.to_string(),
    })
}

pub fn read(name: &str) -> Result<Note, String> {
    let file = path(name)?;
    let text = fs::read_to_string(&file).map_err(|err| format!("cannot read note '{name}': {err}"))?;
    parse(&text)
}

pub fn create(name: &str, note: &Note) -> Result<(), String> {
    check(note)?;
    let file = path(name)?;
    fs::create_dir_all(FOLDER).map_err(|err| format!("cannot create the notes folder: {err}"))?;
    let written = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&file)
        .and_then(|mut out| out.write_all(format(note).as_bytes()));
    written.map_err(|err| {
        if err.kind() == io::ErrorKind::AlreadyExists {
            format!("note '{name}' already exists")
        } else {
            format!("cannot create note '{name}': {err}")
        }
    })
}

pub fn update(name: &str, note: &Note) -> Result<(), String> {
    check(note)?;
    let file = path(name)?;
    if !file.exists() {
        return Err(format!("note '{name}' does not exist"));
    }
    fs::write(&file, format(note)).map_err(|err| format!("cannot update note '{name}': {err}"))
}

pub fn delete(name: &str) -> Result<(), String> {
    let file = path(name)?;
    fs::remove_file(&file).map_err(|err| format!("cannot delete note '{name}': {err}"))
}

/// The notes in one category, sorted by name. An empty category matches every note. A file whose name is not
/// a valid note name is not a note, so it is skipped.
pub fn list(category: &str) -> Result<Vec<(String, Note)>, String> {
    let entries = match fs::read_dir(FOLDER) {
        Ok(entries) => entries,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(format!("cannot read the notes folder: {err}")),
    };
    let mut names: Vec<String> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter_map(|file| file.strip_suffix(".md").map(str::to_string))
        .filter(|name| path(name).is_ok())
        .collect();
    names.sort();
    let mut notes = Vec::new();
    for name in names {
        let note = read(&name)?;
        if category.is_empty() || note.category == category {
            notes.push((name, note));
        }
    }
    Ok(notes)
}

/// One line per note: its name, category and summary. Empty when there are no notes.
pub fn describe_list(notes: &[(String, Note)]) -> String {
    notes
        .iter()
        .map(|(name, note)| format!("{name} [{}]: {}", note.category, note.summary))
        .collect::<Vec<_>>()
        .join("\n")
}

/// A whole note: its summary and category, then its content.
pub fn show(note: &Note) -> String {
    format!("summary: {}\ncategory: {}\n\n{}", note.summary, note.category, note.content)
}

/// The notes list the model is told about: every note's name, category and summary, or `NONE`.
pub fn index() -> Result<String, String> {
    let notes = list("")?;
    if notes.is_empty() {
        return Ok(NONE.to_string());
    }
    Ok(format!("{MARK}\n{}", describe_list(&notes)))
}

/// Whether the model must be told the notes again: the latest list in `history` is not `index`. With no
/// notes, and none mentioned yet, nothing is said.
pub fn needed(history: &[Message], index: &str) -> bool {
    let latest = history.iter().rev().map(Message::content).find(|text| text.starts_with(MARK));
    match latest {
        Some(text) => !text.starts_with(&format!("{index}\n\n")),
        None => index != NONE,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn note_round_trips_through_its_file_format() {
        let note = Note { summary: "a summary".into(), category: "memory".into(), content: "line one\n---\nline two".into() };
        let parsed = parse(&format(&note)).expect("a formatted note parses");
        assert_eq!(parsed.summary, "a summary");
        assert_eq!(parsed.category, "memory");
        assert_eq!(parsed.content, "line one\n---\nline two");
    }

    #[test]
    fn multi_line_summary_is_rejected() {
        let note = Note { summary: "two\nlines".into(), category: "memory".into(), content: String::new() };
        assert!(check(&note).is_err());
    }
}
