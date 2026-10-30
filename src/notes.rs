//! Notes: one file per note in the `notes` folder of the working directory. A file starts with a `---` block
//! holding `summary:` and `category:` lines, then the content. The model is told each note's name, category
//! and summary, and reads the content when it needs it.

use crate::session::Message;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

/// The folder of the notes, inside the working directory.
pub const FOLDER: &str = "notes";
const MARK: &str = "[Notes]";
const NONE: &str = "[Notes]\n(none)";

pub struct Note {
    pub summary: String,
    pub category: String,
    /// The other header lines, such as a profile's `tools:` and `hook ...:` lines, kept as they were written.
    pub extra: Vec<String>,
    pub content: String,
}

/// Whether `name` may be a note name: letters, digits, '-' and '_' only, so it cannot reach outside the folder.
pub fn valid_name(name: &str) -> bool {
    !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// The file for a note in `folder`.
fn path(folder: &Path, name: &str) -> Result<PathBuf, String> {
    if !valid_name(name) {
        return Err(format!("'{name}' is not a note name; use letters, digits, '-' and '_'"));
    }
    Ok(folder.join(format!("{name}.md")))
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
    let extra: String = note.extra.iter().map(|line| format!("{line}\n")).collect();
    format!("---\nsummary: {}\ncategory: {}\n{extra}---\n{}", note.summary, note.category, note.content)
}

/// Reads a note from its file text. Windows line endings are accepted. Header lines other than `summary:` and
/// `category:` go to `extra`.
pub fn parse(text: &str) -> Result<Note, String> {
    let text = text.replace("\r\n", "\n");
    let rest = text.strip_prefix("---\n").ok_or_else(|| "the note has no header".to_string())?;
    let (header, content) = rest.split_once("\n---\n").ok_or_else(|| "the note's header is not closed".to_string())?;
    let (mut summary, mut category) = (None, None);
    let mut extra = Vec::new();
    for line in header.lines() {
        if let Some(value) = line.strip_prefix("summary: ") {
            summary = Some(value.to_string());
        } else if let Some(value) = line.strip_prefix("category: ") {
            category = Some(value.to_string());
        } else if !line.trim().is_empty() {
            extra.push(line.trim().to_string());
        }
    }
    Ok(Note {
        summary: summary.ok_or_else(|| "the note has no summary line".to_string())?,
        category: category.ok_or_else(|| "the note has no category line".to_string())?,
        extra,
        content: content.to_string(),
    })
}

pub fn read(folder: &Path, name: &str) -> Result<Note, String> {
    let file = path(folder, name)?;
    let text = fs::read_to_string(&file).map_err(|err| format!("cannot read note '{name}': {err}"))?;
    parse(&text)
}

pub fn create(folder: &Path, name: &str, note: &Note) -> Result<(), String> {
    check(note)?;
    let file = path(folder, name)?;
    fs::create_dir_all(folder).map_err(|err| format!("cannot create the notes folder: {err}"))?;
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

pub fn update(folder: &Path, name: &str, note: &Note) -> Result<(), String> {
    check(note)?;
    let file = path(folder, name)?;
    if !file.exists() {
        return Err(format!("note '{name}' does not exist"));
    }
    // The header lines beyond the summary and category stay as they are: a profile's hook lines run without a prompt,
    // so an update from the model may change the text but not them.
    let kept = read(folder, name)?.extra;
    let updated = Note {
        summary: note.summary.clone(),
        category: note.category.clone(),
        extra: kept,
        content: note.content.clone(),
    };
    fs::write(&file, format(&updated)).map_err(|err| format!("cannot update note '{name}': {err}"))
}

pub fn delete(folder: &Path, name: &str) -> Result<(), String> {
    let file = path(folder, name)?;
    fs::remove_file(&file).map_err(|err| format!("cannot delete note '{name}': {err}"))
}

/// The notes `list` found, and a message for each file it had to leave out because it could not be read as a note.
pub struct Listing {
    pub notes: Vec<(String, Note)>,
    pub skipped: Vec<String>,
}

/// The notes in one category, sorted by name. An empty category matches every note, and `allowed` (when
/// given) limits the result to the named notes. A file whose name is not a valid note name is not a note, so
/// it is skipped without a word. A note that cannot be read is left out and reported in `skipped`, so one bad file does
/// not hide the others.
pub fn list(folder: &Path, category: &str, allowed: Option<&[String]>) -> Result<Listing, String> {
    let entries = match fs::read_dir(folder) {
        Ok(entries) => entries,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(Listing { notes: Vec::new(), skipped: Vec::new() }),
        Err(err) => return Err(format!("cannot read the notes folder: {err}")),
    };
    let mut names: Vec<String> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter_map(|file| file.strip_suffix(".md").map(str::to_string))
        .filter(|name| path(folder, name).is_ok())
        .collect();
    names.sort();
    let mut listing = Listing { notes: Vec::new(), skipped: Vec::new() };
    for name in names {
        if allowed.is_some_and(|allowed| !allowed.contains(&name)) {
            continue;
        }
        match read(folder, &name) {
            Ok(note) if category.is_empty() || note.category == category => listing.notes.push((name, note)),
            Ok(_) => {}
            Err(err) => listing.skipped.push(format!("note '{name}' is skipped: {err}")),
        }
    }
    Ok(listing)
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

/// The notes list the model is told about: the allowed notes' names, categories and summaries, or `NONE`. It comes with a
/// message for each note that could not be read, which is left out of the list.
pub fn index(folder: &Path, allowed: Option<&[String]>) -> Result<(String, Vec<String>), String> {
    let Listing { notes, skipped } = list(folder, "", allowed)?;
    if notes.is_empty() {
        return Ok((NONE.to_string(), skipped));
    }
    Ok((format!("{MARK}\n{}", describe_list(&notes)), skipped))
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
        let note = Note {
            summary: "a summary".into(),
            category: "memory".into(),
            extra: Vec::new(),
            content: "line one\n---\nline two".into(),
        };
        let parsed = parse(&format(&note)).expect("a formatted note parses");
        assert_eq!(parsed.summary, "a summary");
        assert_eq!(parsed.category, "memory");
        assert_eq!(parsed.content, "line one\n---\nline two");
    }

    #[test]
    fn multi_line_summary_is_rejected() {
        let note = Note { summary: "two\nlines".into(), category: "memory".into(), extra: Vec::new(), content: String::new() };
        assert!(check(&note).is_err());
    }

    #[test]
    fn extra_header_lines_round_trip_in_order() {
        let note = Note {
            summary: "s".into(),
            category: "profile".into(),
            extra: vec!["tools: read_file".into(), "hook before-turn: Get-Date".into()],
            content: "be brief".into(),
        };
        let parsed = parse(&format(&note)).expect("a formatted note parses");
        assert_eq!(parsed.extra, vec!["tools: read_file".to_string(), "hook before-turn: Get-Date".to_string()]);
        assert_eq!(parsed.content, "be brief");
    }

    #[test]
    fn windows_line_endings_are_accepted() {
        let parsed = parse("---\r\nsummary: s\r\ncategory: profile\r\ntools: read_file\r\n---\r\nbe brief").expect("parses");
        assert_eq!(parsed.category, "profile");
        assert_eq!(parsed.extra, vec!["tools: read_file".to_string()]);
        assert_eq!(parsed.content, "be brief");
    }

    #[test]
    fn update_keeps_the_extra_header_lines() {
        let folder = std::env::temp_dir().join(format!("vise-note-update-{}", std::process::id()));
        let _ = fs::remove_dir_all(&folder);
        fs::create_dir_all(&folder).expect("the test folder is made");
        fs::write(folder.join("p.md"), "---\nsummary: s\ncategory: profile\nhook before-turn: Get-Date\n---\nold").expect("written");
        let replacement = Note { summary: "new".into(), category: "profile".into(), extra: Vec::new(), content: "new text".into() };
        update(&folder, "p", &replacement).expect("updates");
        let read_back = read(&folder, "p").expect("reads");
        fs::remove_dir_all(&folder).expect("the test folder is removed");
        assert_eq!(read_back.extra, vec!["hook before-turn: Get-Date".to_string()]);
        assert_eq!(read_back.content, "new text");
    }

    #[test]
    fn one_unreadable_note_does_not_hide_the_others() {
        let folder = std::env::temp_dir().join(format!("vise-note-skip-{}", std::process::id()));
        let _ = fs::remove_dir_all(&folder);
        fs::create_dir_all(&folder).expect("the test folder is made");
        fs::write(folder.join("good.md"), "---\nsummary: s\ncategory: memory\n---\ntext").expect("written");
        fs::write(folder.join("bad.md"), "no header at all").expect("written");
        let listing = list(&folder, "", None).expect("the folder is listed");
        let (text, skipped) = index(&folder, None).expect("the index is built");
        fs::remove_dir_all(&folder).expect("the test folder is removed");
        assert_eq!(listing.notes.len(), 1);
        assert_eq!(listing.notes[0].0, "good");
        assert_eq!(listing.skipped.len(), 1);
        assert!(listing.skipped[0].contains("note 'bad' is skipped"), "{:?}", listing.skipped);
        assert!(text.contains("good [memory]: s") && !text.contains("bad"));
        assert_eq!(skipped, listing.skipped);
    }
}
