//! Where notes live, and the file operations on them. Local notes sit under the working directory and global
//! notes under the home directory. Every name is checked before it becomes a path.

use std::collections::BTreeMap;
use std::fs::{self, DirEntry, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::workspace;

pub(super) const LOCAL: &str = "local";
pub(super) const GLOBAL: &str = "global";
pub(super) const SCOPES: [&str; 2] = [LOCAL, GLOBAL];
const NOTES_DIR: &str = ".vise/notes";

/// The folders the two scopes live in. Local notes are under `working`, global notes under `home`. Either
/// may be missing: a missing working directory makes local notes unavailable, and a missing home makes
/// global notes empty. Callers pass them in, so tests can use their own folders.
#[derive(Clone, Copy)]
pub struct Roots<'a> {
    pub working: Option<&'a Path>,
    pub home: Option<&'a Path>,
}

/// The scope a tool call names. Without one, the call is for a local note.
pub(super) fn scope_of(args: &Value) -> Result<&'static str, String> {
    match args.get("scope").map(Value::as_str) {
        None => Ok(LOCAL),
        Some(Some(LOCAL)) => Ok(LOCAL),
        Some(Some(GLOBAL)) => Ok(GLOBAL),
        Some(_) => Err("scope must be \"local\" or \"global\"".to_owned()),
    }
}

pub(super) fn note_names(args: &Value) -> Result<(&str, &str), String> {
    Ok((workspace::string_arg(args, "category")?, workspace::string_arg(args, "name")?))
}

/// The folder that holds a scope's `.vise/notes`: the working directory for local notes, the home
/// directory for global ones.
fn base(scope: &str, roots: Roots) -> Result<PathBuf, String> {
    if scope == GLOBAL {
        return roots
            .home
            .map(Path::to_path_buf)
            .ok_or_else(|| "no home directory is set, so global notes are unavailable".to_owned());
    }
    roots
        .working
        .map(Path::to_path_buf)
        .ok_or_else(|| "no working directory is set, so local notes are unavailable".to_owned())
}

/// A note's path. Both names are checked first, so no name can reach outside the notes directory.
pub(super) fn note_path(scope: &str, roots: Roots, category: &str, name: &str) -> Result<PathBuf, String> {
    check_segment("category", category)?;
    check_segment("name", name)?;
    let base = base(scope, roots)?;
    workspace::resolve(Some(base.as_path()), &format!("{NOTES_DIR}/{category}/{name}.md"), false)
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

/// The (category, name) of every note in one scope, sorted. A scope with no folder, or global notes with no
/// home directory, has none.
pub(super) fn note_files(scope: &str, roots: Roots) -> Result<Vec<(String, String)>, String> {
    if scope == GLOBAL && roots.home.is_none() {
        return Ok(Vec::new());
    }
    let base = base(scope, roots)?;
    if !base.is_dir() {
        return Ok(Vec::new());
    }
    let dir = workspace::resolve(Some(base.as_path()), NOTES_DIR, false)?;
    if !dir.is_dir() {
        return Ok(Vec::new());
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
                notes.push((category_name.clone(), name.to_owned()));
            }
        }
    }
    Ok(notes)
}

/// A note's frontmatter fields and the text after them. The frontmatter is the `key: value` lines between two
/// `---` lines at the top. `None` when the note has no closed frontmatter block.
pub(super) fn split_frontmatter(text: &str) -> Option<(BTreeMap<String, String>, String)> {
    let mut lines = text.split_inclusive('\n');
    if lines.next()?.trim_end() != "---" {
        return None;
    }
    let mut fields = BTreeMap::new();
    while let Some(line) = lines.next() {
        if line.trim_end() == "---" {
            return Some((fields, lines.collect()));
        }
        if let Some((key, value)) = line.split_once(':') {
            fields.insert(key.trim().to_owned(), value.trim().to_owned());
        }
    }
    None
}

/// The `name` and `summary` in a note's frontmatter. Both must be present and non-empty.
pub(super) fn frontmatter(text: &str) -> Option<(String, String)> {
    let (fields, _) = split_frontmatter(text)?;
    let name = fields.get("name").filter(|value| !value.is_empty())?.clone();
    let summary = fields.get("summary").filter(|value| !value.is_empty())?.clone();
    Some((name, summary))
}

/// The whole text of a note, for the user's `/notes` command.
pub(super) fn show(scope: &str, category: &str, name: &str, roots: Roots) -> Result<String, String> {
    let target = note_path(scope, roots, category, name)?;
    fs::read_to_string(&target).map_err(|err| format!("could not read {category}/{name}: {err}"))
}

pub(super) fn create(args: &Value, roots: Roots) -> Result<String, String> {
    let scope = scope_of(args)?;
    let (category, name) = note_names(args)?;
    let content = workspace::string_arg(args, "content")?;
    let target = note_path(scope, roots, category, name)?;
    frontmatter(content).ok_or("content must start with frontmatter giving name and summary, between --- lines")?;
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

/// Replaces a whole existing note. The new text must keep its frontmatter, as a created note's must.
pub(super) fn update(args: &Value, roots: Roots) -> Result<String, String> {
    let scope = scope_of(args)?;
    let (category, name) = note_names(args)?;
    let content = workspace::string_arg(args, "content")?;
    let target = note_path(scope, roots, category, name)?;
    frontmatter(content).ok_or("content must start with frontmatter giving name and summary, between --- lines")?;
    if !target.is_file() {
        return Err(format!("no such note: {category}/{name}"));
    }
    fs::write(&target, content).map_err(|err| format!("could not write {category}/{name}: {err}"))?;
    Ok(format!("updated {category}/{name}"))
}

pub(super) fn delete(args: &Value, roots: Roots) -> Result<String, String> {
    let scope = scope_of(args)?;
    let (category, name) = note_names(args)?;
    let target = note_path(scope, roots, category, name)?;
    fs::remove_file(&target).map_err(|err| format!("could not delete {category}/{name}: {err}"))?;
    Ok(format!("deleted {category}/{name}"))
}
