//! The file tree of the working directory, for the web UI's Files panel. `.git`, `target` and `node_modules` are left
//! out at every level. A folder that cannot be read is shown empty rather than failing the whole tree.

use std::fs;
use std::io::{self, BufRead, BufReader, Read, Seek, SeekFrom};
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

/// The most lines sent in one block of a file.
pub const LINES_PER_BLOCK: usize = 200;

/// One block of a text file: its lines, the byte offset where the next block starts, and whether more lines follow.
#[derive(Debug)]
pub struct Block {
    pub lines: Vec<String>,
    pub next: u64,
    pub more: bool,
}

/// Up to `LINES_PER_BLOCK` lines of a file in the working directory, starting at byte `offset` (0 for the first block).
/// The offset of the next block comes back in `next`, so each block costs only its own reads. The path is confined to
/// the working directory, and a file that is not UTF-8 text, or holds a NUL byte, is refused.
pub fn read_lines(root: &Path, path: &str, offset: u64) -> Result<Block, String> {
    let target = resolve(Some(root), path, false)?;
    if !target.is_file() {
        return Err(format!("not a file: {path}"));
    }
    let read_error = |err: io::Error| format!("could not read {path}: {err}");
    let mut file = fs::File::open(&target).map_err(read_error)?;
    if offset > 0 && !starts_a_line(&mut file, offset).map_err(read_error)? {
        return Err(format!("offset {offset} is not the start of a line in {path}; the file may have changed"));
    }
    file.seek(SeekFrom::Start(offset)).map_err(read_error)?;
    let mut reader = BufReader::new(file);
    let mut lines = Vec::new();
    let mut next = offset;
    let mut bytes = Vec::new();
    while lines.len() < LINES_PER_BLOCK {
        bytes.clear();
        // At most one line longer than MAX_LINE_BYTES is read, so a file with no line endings cannot fill memory.
        let read = (&mut reader).take(MAX_LINE_BYTES + 1).read_until(b'\n', &mut bytes).map_err(read_error)?;
        if read == 0 {
            return Ok(Block { lines, next, more: false });
        }
        if bytes.len() as u64 > MAX_LINE_BYTES && !bytes.ends_with(b"\n") {
            return Err(format!("a line in {path} is longer than {MAX_LINE_BYTES} bytes, so its contents are not shown"));
        }
        next += read as u64;
        lines.push(text_line(path, &bytes)?);
    }
    // The next line is looked at, not consumed, so the next block starts exactly where this one ends.
    let more = !reader.fill_buf().map_err(read_error)?.is_empty();
    Ok(Block { lines, next, more })
}

/// The longest line read, in bytes, line ending included.
pub const MAX_LINE_BYTES: u64 = 64 * 1024;

/// Whether byte `offset` is the first byte of a line: the byte before it is a line feed.
fn starts_a_line(file: &mut fs::File, offset: u64) -> io::Result<bool> {
    file.seek(SeekFrom::Start(offset - 1))?;
    let mut before = [0u8; 1];
    file.read_exact(&mut before)?;
    Ok(before[0] == b'\n')
}

/// One line of text without its line ending. A line that is not UTF-8, or holds a NUL byte, is refused.
fn text_line(path: &str, bytes: &[u8]) -> Result<String, String> {
    match std::str::from_utf8(bytes) {
        Ok(line) if !line.contains('\0') => Ok(line.trim_end_matches(['\n', '\r']).to_owned()),
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
        let text = read_lines(&root, "src/main.rs", 0);
        let escape = read_lines(&root, "../secret", 0);
        let binary = read_lines(&root, "data.bin", 0);
        fs::remove_dir_all(&root).unwrap();

        let text = text.unwrap();
        assert!(text.lines.is_empty());
        assert!(!text.more);
        assert!(escape.is_err());
        assert!(binary.unwrap_err().contains("not a text file"));
    }

    #[test]
    fn a_line_too_long_to_read_and_an_offset_inside_a_line_are_refused() {
        let root = folder("refuse");
        fs::write(root.join("one-line.txt"), "x".repeat(MAX_LINE_BYTES as usize + 10)).unwrap();
        fs::write(root.join("two.txt"), "first\nsecond\n").unwrap();
        let too_long = read_lines(&root, "one-line.txt", 0);
        let inside = read_lines(&root, "two.txt", 2);
        fs::remove_dir_all(&root).unwrap();

        assert!(too_long.unwrap_err().contains("longer than"));
        assert!(inside.unwrap_err().contains("not the start of a line"));
    }

    #[test]
    fn a_long_file_is_read_a_block_at_a_time() {
        let root = folder("blocks");
        let body: String = (1..=LINES_PER_BLOCK + 50).map(|n| format!("line {n}\n")).collect();
        fs::write(root.join("long.txt"), body).unwrap();
        let first = read_lines(&root, "long.txt", 0).unwrap();
        let second = read_lines(&root, "long.txt", first.next);
        fs::remove_dir_all(&root).unwrap();

        assert_eq!(first.lines.len(), LINES_PER_BLOCK);
        assert!(first.more);
        let second = second.unwrap();
        assert_eq!(second.lines.first().map(String::as_str), Some("line 201"));
        assert_eq!(second.lines.len(), 50);
        assert!(!second.more);
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
