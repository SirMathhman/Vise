use std::io::Read;

use serde::Deserialize;

const MAX_LISTING_ENTRIES: usize = 500;
const MAX_FILE_BYTES: usize = 32 * 1024; // 32 KiB

#[derive(Deserialize)]
pub struct DirListing {
    pub entries: Vec<DirEntry>,
    pub found: bool,
    pub truncated: bool,
}

#[derive(Deserialize)]
pub struct DirEntry {
    pub name: String,
    pub size: u64,
    pub kind: EntryKind,
}

#[derive(Deserialize)]
pub enum EntryKind {
    File,
    Dir,
}

#[derive(Deserialize)]
pub struct FileContent {
    pub content: String,
    pub truncated: bool,
    pub error: Option<String>,
}

pub fn read_dir(path: &str, base: &std::path::Path) -> DirListing {
    let dir_path = base.join(path);
    let mut entries: Vec<DirEntry> = Vec::new();
    let mut found = false;
    let mut truncated = false;

    if let Ok(dir) = std::fs::read_dir(&dir_path) {
        found = true;
        for entry in dir {
            match entry {
                Ok(entry) => {
                    let name = entry.file_name().to_string_lossy().into_owned();
                    let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                    let kind = match entry.file_type() {
                        Ok(t) if t.is_dir() => EntryKind::Dir,
                        _ => EntryKind::File,
                    };
                    entries.push(DirEntry { name, size, kind });
                }
                Err(_) => continue,
            }
            if entries.len() >= MAX_LISTING_ENTRIES {
                truncated = true;
                break;
            }
        }
    }

    DirListing { entries, found, truncated }
}

pub fn read_file(path: &str, base: &std::path::Path) -> FileContent {
    let file_path = base.join(path);
    let mut content = String::new();
    let mut truncated = false;
    let mut error: Option<String> = None;

    match std::fs::metadata(&file_path) {
        Ok(meta) => {
            if !meta.is_file() {
                error = Some("not a file".to_string());
            } else {
                let size = meta.len();
                match std::fs::File::open(&file_path) {
                    Ok(mut f) => {
                        let mut buf = vec![0u8; MAX_FILE_BYTES + 1];
                        match f.read(&mut buf) {
                            Ok(n) => {
                                truncated = size > MAX_FILE_BYTES as u64;
                                let head = &buf[..n.min(MAX_FILE_BYTES)];
                                content = String::from_utf8_lossy(head).into_owned();
                            }
                            Err(_) => error = Some("could not read".to_string()),
                        }
                    }
                    Err(_) => error = Some("could not open".to_string()),
                }
            }
        }
        Err(_) => error = Some("not found".to_string()),
    }

    FileContent { content, truncated, error }
}

pub fn format_listing(dir: &str, listing: &DirListing) -> String {
    let mut out = String::new();
    if !listing.found {
        out.push_str(&format!("Listing of \"{}\": not found\n", dir));
        return out;
    }
    let count = listing.entries.len();
    let note = if listing.truncated { " (truncated)" } else { "" };
    out.push_str(&format!(
        "Listing of \"{}\" ({} entries{})\n",
        dir, count, note
    ));
    for e in &listing.entries {
        match e.kind {
            EntryKind::Dir => out.push_str(&format!("- {}\n", e.name)),
            EntryKind::File => out.push_str(&format!("- {} ({} bytes)\n", e.name, e.size)),
        }
    }
    out
}

pub fn format_file(path: &str, file: &FileContent) -> String {
    match &file.error {
        Some(e) => return format!("File \"{}\": {}\n", path, e),
        None => {}
    }
    let note = if file.truncated { " (truncated)" } else { "" };
    format!(
        "Contents of \"{}\" ({} bytes{})\n{}\n",
        path,
        file.content.len(),
        note,
        file.content
    )
}
