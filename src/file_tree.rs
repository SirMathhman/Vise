//! The file tree of the working directory, for the web UI's Files panel. `.git`, `target` and `node_modules` are left
//! out at every level. A folder that cannot be read is shown empty rather than failing the whole tree.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use crate::workspace::resolve;

const SKIPPED: [&str; 3] = [".git", "target", "node_modules"];

/// The most entries a tree lists. A larger tree is cut short, and the result says so.
pub const MAX_ENTRIES: usize = 2000;

/// The tree of `root`: its name, its entries as `children`, and whether the listing was cut short.
pub fn build(root: &Path) -> Result<Value, String> {
    build_with_limit(root, MAX_ENTRIES)
}

fn build_with_limit(root: &Path, limit: usize) -> Result<Value, String> {
    let mut builder = Builder { limit, count: 0, truncated: false };
    let children = builder.children(root)?;
    let name = root
        .file_name()
        .map_or_else(|| root.display().to_string(), |name| name.to_string_lossy().into_owned());
    Ok(json!({ "name": name, "children": children, "truncated": builder.truncated }))
}

/// The largest file whose text is read, in bytes.
pub const MAX_TEXT_BYTES: u64 = 1024 * 1024;

/// The text of a file in the working directory, named relative to it. The path is confined to the working directory,
/// a file larger than `MAX_TEXT_BYTES` is refused, and a file that is not UTF-8 text, or holds a NUL byte, is refused.
pub fn read_text(root: &Path, path: &str) -> Result<String, String> {
    let target = resolve(Some(root), path, false)?;
    if !target.is_file() {
        return Err(format!("not a file: {path}"));
    }
    let size = target.metadata().map_err(|err| format!("could not read {path}: {err}"))?.len();
    if size > MAX_TEXT_BYTES {
        return Err(format!("{path} is larger than {MAX_TEXT_BYTES} bytes, so its contents are not shown"));
    }
    let bytes = fs::read(&target).map_err(|err| format!("could not read {path}: {err}"))?;
    match String::from_utf8(bytes) {
        Ok(text) if !text.contains('\0') => Ok(text),
        _ => Err(format!("{path} is not a text file, so its contents cannot be shown")),
    }
}

struct Builder {
    limit: usize,
    count: usize,
    truncated: bool,
}

impl Builder {
    /// The entries of a folder: folders first, then files, each sorted by name.
    fn children(&mut self, dir: &Path) -> Result<Vec<Value>, String> {
        let reader = fs::read_dir(dir).map_err(|err| format!("could not read {}: {err}", dir.display()))?;
        let mut entries: Vec<(bool, String, PathBuf)> = reader
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_str().is_none_or(|name| !SKIPPED.contains(&name)))
            .map(|entry| {
                let is_dir = entry.file_type().is_ok_and(|kind| kind.is_dir());
                (is_dir, entry.file_name().to_string_lossy().into_owned(), entry.path())
            })
            .collect();
        entries.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));

        let mut nodes = Vec::new();
        for (is_dir, name, path) in entries {
            if self.count >= self.limit {
                self.truncated = true;
                break;
            }
            self.count += 1;
            let node = if is_dir {
                json!({ "name": name, "dir": true, "children": self.children(&path).unwrap_or_default() })
            } else {
                json!({ "name": name, "dir": false })
            };
            nodes.push(node);
        }
        Ok(nodes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder(test: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("vise-tree-{test}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("src")).unwrap();
        fs::create_dir_all(root.join("target")).unwrap();
        fs::write(root.join("README.md"), "").unwrap();
        fs::write(root.join("src/main.rs"), "").unwrap();
        fs::write(root.join("target/out.bin"), "").unwrap();
        root
    }

    #[test]
    fn folders_come_first_and_skipped_folders_are_left_out() {
        let root = folder("skip");
        let tree = build(&root);
        fs::remove_dir_all(&root).unwrap();

        let tree = tree.unwrap();
        let names: Vec<&str> = tree["children"].as_array().unwrap().iter().map(|node| node["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["src", "README.md"]);
        assert_eq!(tree["truncated"], false);
    }

    #[test]
    fn a_text_file_is_read_but_paths_outside_the_folder_and_binary_files_are_refused() {
        let root = folder("read");
        fs::write(root.join("data.bin"), [0u8, 159, 146, 150]).unwrap();
        let text = read_text(&root, "src/main.rs");
        let escape = read_text(&root, "../secret");
        let binary = read_text(&root, "data.bin");
        fs::remove_dir_all(&root).unwrap();

        assert_eq!(text.unwrap(), "");
        assert!(escape.is_err());
        assert!(binary.unwrap_err().contains("not a text file"));
    }

    #[test]
    fn a_tree_past_the_limit_is_cut_short_and_says_so() {
        let root = folder("limit");
        let tree = build_with_limit(&root, 1);
        fs::remove_dir_all(&root).unwrap();

        let tree = tree.unwrap();
        assert_eq!(tree["children"].as_array().unwrap().len(), 1);
        assert_eq!(tree["truncated"], true);
    }
}
