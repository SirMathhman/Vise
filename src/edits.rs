//! Undo for the model's edits. The state an edit is about to change is recorded before it runs, so an edit the user denies
//! or stops can be taken back. This module knows no tools: `tools` decides what each edit changes.

use std::fs;
use std::path::{Path, PathBuf};

/// One step of an undo. The steps run in the order they were recorded.
enum Step {
    /// Removes a file the edit created.
    RemoveFile(PathBuf),
    /// Removes a directory the edit created. It must be empty by then.
    RemoveDir(PathBuf),
    /// Creates a directory the edit removed.
    MakeDir(PathBuf),
    /// Puts back the bytes of a file the edit changed or removed.
    WriteFile(PathBuf, Vec<u8>),
}

/// The steps that take an edit back. An edit that changes nothing has none.
#[derive(Default)]
pub struct Undo(Vec<Step>);

impl Undo {
    /// A file the edit creates, then the directories it created, deepest first.
    pub fn created_file(path: &Path) -> Self {
        let mut steps = vec![Step::RemoveFile(path.to_path_buf())];
        steps.extend(missing_dirs(path.parent().unwrap_or(path)).into_iter().map(Step::RemoveDir));
        Self(steps)
    }

    /// A directory the edit creates, with any parents it creates, deepest first.
    pub fn created_dir(path: &Path) -> Self {
        Self(missing_dirs(path).into_iter().map(Step::RemoveDir).collect())
    }

    /// A file's bytes as they are now, so an edit that changes or removes the file can be put back. Records nothing when
    /// the file cannot be read, since the edit cannot read it either.
    pub fn file_as_it_is(path: &Path) -> Self {
        match fs::read(path) {
            Ok(bytes) => Self(vec![Step::WriteFile(path.to_path_buf(), bytes)]),
            Err(_) => Self::default(),
        }
    }

    /// A directory the edit removes, to be created again.
    pub fn deleted_dir(path: &Path) -> Self {
        Self(vec![Step::MakeDir(path.to_path_buf())])
    }

    /// Takes the edit back. The first step that fails stops the undo, and its error is returned.
    pub fn restore(self) -> Result<(), String> {
        for step in self.0 {
            let (path, result) = match step {
                Step::RemoveFile(path) => (path.clone(), fs::remove_file(&path)),
                Step::RemoveDir(path) => (path.clone(), fs::remove_dir(&path)),
                Step::MakeDir(path) => (path.clone(), fs::create_dir(&path)),
                Step::WriteFile(path, bytes) => (path.clone(), fs::write(&path, bytes)),
            };
            result.map_err(|err| format!("could not undo {}: {err}", path.display()))?;
        }
        Ok(())
    }
}

/// The directories that do not exist yet on the way from `start` up to the first one that does, `start` first.
fn missing_dirs(start: &Path) -> Vec<PathBuf> {
    let mut missing = Vec::new();
    let mut current = start.to_path_buf();
    while !current.exists() {
        missing.push(current.clone());
        if !current.pop() {
            break;
        }
    }
    missing
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("vise-edits-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn a_created_file_and_its_new_folders_are_removed() {
        let root = scratch("created");
        let path = root.join("a/b/note.md");
        let undo = Undo::created_file(&path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "text").unwrap();
        undo.restore().unwrap();

        assert!(!root.join("a").exists());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_created_directory_and_its_new_parents_are_removed() {
        let root = scratch("created-dir");
        let path = root.join("x/y");
        let undo = Undo::created_dir(&path);
        fs::create_dir_all(&path).unwrap();
        undo.restore().unwrap();

        assert!(!root.join("x").exists());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_changed_file_gets_its_old_bytes_back() {
        let root = scratch("changed");
        let path = root.join("notes.txt");
        fs::write(&path, "before").unwrap();
        let undo = Undo::file_as_it_is(&path);
        fs::write(&path, "after").unwrap();
        undo.restore().unwrap();

        assert_eq!(fs::read_to_string(&path).unwrap(), "before");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_deleted_directory_is_created_again() {
        let root = scratch("deleted-dir");
        let path = root.join("empty");
        fs::create_dir(&path).unwrap();
        let undo = Undo::deleted_dir(&path);
        fs::remove_dir(&path).unwrap();
        undo.restore().unwrap();

        assert!(path.is_dir());
        fs::remove_dir_all(&root).unwrap();
    }
}
