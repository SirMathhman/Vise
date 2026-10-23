use std::collections::BTreeSet;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::Path;
use std::sync::{Mutex, MutexGuard, PoisonError};

use serde_json::{Value, json};

use crate::notes;
use crate::workspace::{line_range, read_range, resolve, string_arg};

pub const LIST_FILES: &str = "list_files";
pub const READ_FILE: &str = "read_file";
pub const CREATE_FILE: &str = "create_file";
pub const CREATE_DIRECTORY: &str = "create_directory";
pub const DELETE_FILE: &str = "delete_file";
pub const DELETE_DIRECTORY: &str = "delete_directory";
/// Runs a subagent. The agent loop handles it, because it needs the model connection.
pub const RUN_SUBAGENT: &str = "run_subagent";

/// Every tool name, in the order they are listed to the user.
pub const NAMES: [&str; 12] = [
    LIST_FILES,
    READ_FILE,
    CREATE_FILE,
    CREATE_DIRECTORY,
    DELETE_FILE,
    DELETE_DIRECTORY,
    notes::LIST_NOTES,
    notes::READ_NOTE,
    notes::CREATE_NOTE,
    notes::EDIT_NOTE,
    notes::DELETE_NOTE,
    RUN_SUBAGENT,
];

/// Which tools are switched off. One instance is shared by the whole run, so a change made by a
/// command applies to every later request.
#[derive(Default)]
pub struct Switches {
    disabled: Mutex<BTreeSet<String>>,
}

impl Switches {
    /// The names of the tools that are switched off right now.
    pub fn snapshot(&self) -> BTreeSet<String> {
        lock(&self.disabled).clone()
    }

    pub fn set(&self, name: &str, enabled: bool) {
        let mut disabled = lock(&self.disabled);
        if enabled {
            disabled.remove(name);
        } else {
            disabled.insert(name.to_owned());
        }
    }
}

/// Prefixes `text` with a note of the switch changes since the model was last told (`told`), given
/// the switches now (`now`). Returns `text` unchanged when nothing changed. The caller records `now`
/// as the new `told` only once the reply has been delivered.
pub fn note_changes(text: &str, told: &BTreeSet<String>, now: &BTreeSet<String>) -> String {
    let off: Vec<&str> = now.difference(told).map(String::as_str).collect();
    let on: Vec<&str> = told.difference(now).map(String::as_str).collect();
    let mut parts = Vec::new();
    if !off.is_empty() {
        parts.push(format!("now switched off: {}", off.join(", ")));
    }
    if !on.is_empty() {
        parts.push(format!("now switched on: {}", on.join(", ")));
    }
    if parts.is_empty() {
        return text.to_owned();
    }
    format!("[Tool status changed: {}.]\n\n{text}", parts.join("; "))
}

fn lock(set: &Mutex<BTreeSet<String>>) -> MutexGuard<'_, BTreeSet<String>> {
    // A panic cannot leave a set half-updated, so a poisoned lock is still safe to use.
    set.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The tool definitions offered to the model. Switched-off tools stay in this list, so the request
/// prefix does not change when a tool is toggled. Calls to them are refused in `agent`.
pub fn definitions() -> Value {
    let mut all = json!([
        {
            "type": "function",
            "function": {
                "name": LIST_FILES,
                "description": "List the files and subdirectories in a directory, down to the given depth. Depth 1 lists only the directory's own entries. Subdirectories end with a slash.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "Directory to list" },
                        "depth": { "type": "integer", "minimum": 1, "description": "How many levels to list; 1 is only the directory's own entries" }
                    },
                    "required": ["path", "depth"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": READ_FILE,
                "description": "Read lines from a text file. Lines are 1-based: start is included and end is excluded, so start 3 and end 6 returns lines 3, 4 and 5. Each returned line is prefixed with its line number and a tab.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "File to read" },
                        "start": { "type": "integer", "minimum": 1, "description": "First line to return, 1-based and included" },
                        "end": { "type": "integer", "minimum": 1, "description": "Line after the last one to return, 1-based and excluded" }
                    },
                    "required": ["path", "start", "end"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": CREATE_FILE,
                "description": "Create a new text file with the given content. Fails if the file already exists or its parent directory does not exist.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "File to create" },
                        "content": { "type": "string", "description": "Full text of the new file" }
                    },
                    "required": ["path", "content"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": CREATE_DIRECTORY,
                "description": "Create a directory, including any missing parent directories. Fails if the path already exists.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "Directory to create" }
                    },
                    "required": ["path"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": DELETE_FILE,
                "description": "Delete a file. Fails if the path is a directory or does not exist.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "File to delete" }
                    },
                    "required": ["path"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": DELETE_DIRECTORY,
                "description": "Delete an empty directory. Fails if the directory contains anything, or if the path is a file.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "Empty directory to delete" }
                    },
                    "required": ["path"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": RUN_SUBAGENT,
                "description": "Run a task in a fresh conversation that follows a profile. The profile's instructions guide it, and it can use only the tools the profile lists. Its steps are not shown to you; only its final answer comes back. Profiles are the notes marked profile: true in the notes index, named local/<category>/<name> or global/<category>/<name>. A subagent cannot run another subagent.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "profile": { "type": "string", "description": "The profile's name, such as local/review/strict" },
                        "task": { "type": "string", "description": "What the subagent should do, in full, since it sees nothing else from this conversation" }
                    },
                    "required": ["profile", "task"]
                }
            }
        }
    ]);
    all.as_array_mut().expect("definitions are an array").extend(notes::definitions());
    all
}

/// Every tool with its description and whether it is switched on, for the web UI's tool panel.
pub fn listing(switches: &Switches) -> Vec<Value> {
    let disabled = switches.snapshot();
    definitions()
        .as_array()
        .into_iter()
        .flatten()
        .map(|definition| {
            let name = definition["function"]["name"].as_str().unwrap_or_default();
            json!({
                "name": name,
                "description": definition["function"]["description"],
                "enabled": !disabled.contains(name),
            })
        })
        .collect()
}

/// Longest tool result sent back to the model, in bytes.
const MAX_TOOL_OUTPUT: usize = 16 * 1024;

/// Runs a tool call and returns the text the model should see. Failures are returned as text too,
/// so the model can recover instead of the whole turn failing. Long results are cut short.
/// Every path must resolve inside `root`, the working directory.
pub fn run(name: &str, arguments: &str, root: Option<&Path>) -> String {
    let output = match name {
        LIST_FILES => list_files(arguments, root),
        READ_FILE => read_file(arguments, root),
        CREATE_FILE => create_file(arguments, root),
        CREATE_DIRECTORY => create_directory(arguments, root),
        DELETE_FILE => delete_file(arguments, root),
        DELETE_DIRECTORY => delete_directory(arguments, root),
        RUN_SUBAGENT => Err("run_subagent runs inside the turn, so it cannot be called here".to_owned()),
        notes::LIST_NOTES | notes::READ_NOTE | notes::CREATE_NOTE | notes::EDIT_NOTE | notes::DELETE_NOTE => {
            let home = std::env::home_dir();
            notes::run(name, arguments, notes::Roots { working: root, home: home.as_deref() })
        }
        _ => Err(format!("unknown tool {name}")),
    };
    truncate(output.unwrap_or_else(|err| format!("error: {err}")))
}

fn truncate(output: String) -> String {
    if output.len() <= MAX_TOOL_OUTPUT {
        return output;
    }
    let mut end = MAX_TOOL_OUTPUT;
    while !output.is_char_boundary(end) {
        end -= 1;
    }
    format!(
        "{}\n... output truncated at {MAX_TOOL_OUTPUT} bytes; narrow the range or depth",
        &output[..end]
    )
}

fn parse_arguments(arguments: &str) -> Result<Value, String> {
    serde_json::from_str(arguments).map_err(|err| format!("invalid arguments: {err}"))
}

fn list_files(arguments: &str, root: Option<&Path>) -> Result<String, String> {
    let args = parse_arguments(arguments)?;
    let path = args
        .get("path")
        .and_then(Value::as_str)
        .ok_or("path must be a string")?;
    let depth = args
        .get("depth")
        .and_then(Value::as_u64)
        .filter(|depth| *depth >= 1)
        .ok_or("depth must be an integer of at least 1")?;

    let target = resolve(root, path, true)?;
    if !target.is_dir() {
        return Err(format!("not a directory: {path}"));
    }
    let mut lines = Vec::new();
    walk(&target, &target, depth, &mut lines).map_err(|err| format!("could not read {path}: {err}"))?;
    Ok(lines.join("\n"))
}

fn walk(root: &Path, dir: &Path, depth: u64, lines: &mut Vec<String>) -> std::io::Result<()> {
    let mut entries = fs::read_dir(dir)?.collect::<Result<Vec<_>, _>>()?;
    entries.sort_by_key(|entry| entry.file_name());

    for entry in entries {
        let path = entry.path();
        let relative = path.strip_prefix(root).unwrap_or(&path).display().to_string();
        if entry.file_type()?.is_dir() {
            lines.push(format!("{relative}/"));
            if depth > 1 {
                walk(root, &path, depth - 1, lines)?;
            }
        } else {
            lines.push(relative);
        }
    }
    Ok(())
}

fn read_file(arguments: &str, root: Option<&Path>) -> Result<String, String> {
    let args = parse_arguments(arguments)?;
    let path = string_arg(&args, "path")?;
    let (start, end) = line_range(&args)?;
    let target = resolve(root, path, true)?;
    read_range(path, &target, start, end)
}

/// Creates a new file. An existing file is never changed, and the parent directory must exist.
fn create_file(arguments: &str, root: Option<&Path>) -> Result<String, String> {
    let args = parse_arguments(arguments)?;
    let path = string_arg(&args, "path")?;
    let content = string_arg(&args, "content")?;
    let target = resolve(root, path, false)?;

    let mut file = match OpenOptions::new().write(true).create_new(true).open(&target) {
        Ok(file) => file,
        Err(err) if err.kind() == io::ErrorKind::AlreadyExists => {
            return Err(format!("already exists: {path}"));
        }
        Err(err) => return Err(format!("could not create {path}: {err}")),
    };
    file.write_all(content.as_bytes())
        .map_err(|err| format!("could not write {path}: {err}"))?;
    Ok(format!("created file {path}"))
}

/// Creates a directory and any missing parents. Fails if the path already exists.
fn create_directory(arguments: &str, root: Option<&Path>) -> Result<String, String> {
    let args = parse_arguments(arguments)?;
    let path = string_arg(&args, "path")?;
    let target = resolve(root, path, false)?;
    if target.exists() {
        return Err(format!("already exists: {path}"));
    }
    fs::create_dir_all(&target).map_err(|err| format!("could not create {path}: {err}"))?;
    Ok(format!("created directory {path}"))
}

fn delete_file(arguments: &str, root: Option<&Path>) -> Result<String, String> {
    let args = parse_arguments(arguments)?;
    let path = string_arg(&args, "path")?;
    let target = resolve(root, path, false)?;
    if target.is_dir() {
        return Err(format!("is a directory, use delete_directory: {path}"));
    }
    fs::remove_file(&target).map_err(|err| format!("could not delete {path}: {err}"))?;
    Ok(format!("deleted file {path}"))
}

/// Deletes a directory only when it is empty.
fn delete_directory(arguments: &str, root: Option<&Path>) -> Result<String, String> {
    let args = parse_arguments(arguments)?;
    let path = string_arg(&args, "path")?;
    let target = resolve(root, path, false)?;
    if target.is_file() {
        return Err(format!("is a file, use delete_file: {path}"));
    }
    fs::remove_dir(&target).map_err(|err| format!("could not delete {path}: {err}"))?;
    Ok(format!("deleted directory {path}"))
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    /// Runs a tool with the system temp directory as the working directory.
    fn run_in_temp(name: &str, arguments: &str) -> String {
        run(name, arguments, Some(&std::env::temp_dir()))
    }

    #[test]
    fn paths_outside_working_directory_are_refused() {
        let root = std::env::temp_dir().join(format!("vise-scope-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let outside = root.join("..").join(format!("vise-outside-{}.txt", std::process::id()));
        let relative = format!("../vise-outside-{}.txt", std::process::id());
        let args = json!({ "path": relative, "content": "x" }).to_string();

        let result = run(CREATE_FILE, &args, Some(&root));
        let without_root = run(CREATE_FILE, &args, None);
        fs::remove_dir_all(&root).unwrap();

        assert!(result.starts_with("error: path is outside the working directory"));
        assert!(without_root.starts_with("error: no working directory"));
        assert!(!outside.exists());
    }

    #[test]
    fn refuses_working_directory_and_non_relative_paths() {
        let root = std::env::temp_dir().join(format!("vise-refuse-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let run_in_root = |name: &str, path: &str| {
            run(name, &json!({ "path": path, "depth": 1 }).to_string(), Some(&root))
        };

        let dot = run_in_root(DELETE_DIRECTORY, ".");
        let empty = run_in_root(DELETE_DIRECTORY, "");
        let drive_relative = run_in_root(LIST_FILES, "C:foo");
        let unc = run_in_root(LIST_FILES, r"\\server\share");
        let slash_unc = run_in_root(LIST_FILES, "//server/share");
        let absolute = run_in_root(LIST_FILES, "C:\\Windows");
        let root_still_exists = root.is_dir();
        fs::remove_dir_all(&root).unwrap();

        assert!(dot.starts_with("error: the working directory itself cannot be changed"));
        assert!(empty.starts_with("error: the working directory itself cannot be changed"));
        assert!(drive_relative.starts_with("error: absolute, network, device, and drive-relative"));
        assert!(unc.starts_with("error: absolute, network, device, and drive-relative"));
        assert!(slash_unc.starts_with("error: absolute, network, device, and drive-relative"));
        assert!(absolute.starts_with("error: absolute, network, device, and drive-relative"));
        assert!(root_still_exists);
    }

    #[cfg(windows)]
    #[test]
    fn symlink_loop_inside_root_is_refused_not_treated_as_missing() {
        let root = std::env::temp_dir().join(format!("vise-loop-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let link = root.join("loop");
        std::os::windows::fs::symlink_dir(&link, &link).unwrap();

        let result = run(
            LIST_FILES,
            &json!({ "path": "loop", "depth": 1 }).to_string(),
            Some(&root),
        );
        fs::remove_dir_all(&root).unwrap();

        assert!(result.starts_with("error: could not resolve loop"));
    }

    #[test]
    fn list_files_respects_depth() {
        let root = std::env::temp_dir().join(format!("vise-list-{}", std::process::id()));
        fs::create_dir_all(root.join("sub")).unwrap();
        fs::write(root.join("a.txt"), "").unwrap();
        fs::write(root.join("sub").join("b.txt"), "").unwrap();
        let path = root.file_name().unwrap().to_str().unwrap().to_owned();

        let shallow = run_in_temp(LIST_FILES, &format!(r#"{{"path":"{path}","depth":1}}"#));
        let deep = run_in_temp(LIST_FILES, &format!(r#"{{"path":"{path}","depth":2}}"#));
        fs::remove_dir_all(&root).unwrap();

        let nested = format!("sub{}b.txt", std::path::MAIN_SEPARATOR);
        assert_eq!(shallow, "a.txt\nsub/");
        assert_eq!(deep, format!("a.txt\nsub/\n{nested}"));
    }

    #[test]
    fn read_file_returns_numbered_lines_from_start_to_excluded_end() {
        let file = std::env::temp_dir().join(format!("vise-read-{}.txt", std::process::id()));
        fs::write(&file, "a\nb\nc\n").unwrap();
        let path = file.file_name().unwrap().to_str().unwrap().to_owned();

        let middle = run_in_temp(READ_FILE, &json!({ "path": path, "start": 2, "end": 4 }).to_string());
        let clipped = run_in_temp(READ_FILE, &json!({ "path": path, "start": 1, "end": 10 }).to_string());
        let empty = run_in_temp(READ_FILE, &json!({ "path": path, "start": 3, "end": 3 }).to_string());
        fs::remove_file(&file).unwrap();

        assert_eq!(middle, "2\tb\n3\tc");
        assert_eq!(clipped, "1\ta\n2\tb\n3\tc");
        assert!(empty.starts_with("error: no lines in range 3 to 3"));
    }

    #[test]
    fn long_tool_output_is_truncated_with_notice() {
        let file = std::env::temp_dir().join(format!("vise-long-{}.txt", std::process::id()));
        let text: Vec<String> = (1..=2000).map(|n| format!("row {n}")).collect();
        fs::write(&file, text.join("\n")).unwrap();

        let result = run_in_temp(
            READ_FILE,
            &json!({ "path": file.file_name().unwrap().to_str().unwrap(), "start": 1, "end": 2001 })
                .to_string(),
        );
        fs::remove_file(&file).unwrap();

        assert!(result.len() <= MAX_TOOL_OUTPUT + 100);
        assert!(result.ends_with("narrow the range or depth"));
    }

    #[test]
    fn create_and_delete_refuse_wrong_kinds_and_existing_paths() {
        let root = std::env::temp_dir().join(format!("vise-edit-{}", std::process::id()));
        let file = root.join("made.txt");
        let file_path = format!("vise-edit-{}/made.txt", std::process::id());
        let dir_path = format!("vise-edit-{}", std::process::id());

        let created_dir = run_in_temp(CREATE_DIRECTORY, &json!({ "path": dir_path }).to_string());
        let created_file = run_in_temp(
            CREATE_FILE,
            &json!({ "path": file_path, "content": "hi" }).to_string(),
        );
        let read_back = fs::read_to_string(&file).unwrap();
        let file_again = run_in_temp(
            CREATE_FILE,
            &json!({ "path": file_path, "content": "again" }).to_string(),
        );
        let delete_nonempty = run_in_temp(DELETE_DIRECTORY, &json!({ "path": dir_path }).to_string());
        let delete_file_as_dir = run_in_temp(DELETE_DIRECTORY, &json!({ "path": file_path }).to_string());
        let deleted_file = run_in_temp(DELETE_FILE, &json!({ "path": file_path }).to_string());
        let deleted_dir = run_in_temp(DELETE_DIRECTORY, &json!({ "path": dir_path }).to_string());

        assert_eq!(created_dir, format!("created directory {dir_path}"));
        assert_eq!(created_file, format!("created file {file_path}"));
        assert_eq!(read_back, "hi");
        assert!(file_again.starts_with("error: already exists"));
        assert!(delete_nonempty.starts_with("error: could not delete"));
        assert!(delete_file_as_dir.starts_with("error: is a file"));
        assert_eq!(deleted_file, format!("deleted file {file_path}"));
        assert_eq!(deleted_dir, format!("deleted directory {dir_path}"));
        assert!(!root.exists());
    }
}


#[cfg(test)]
mod note_tests {
    use super::*;

    fn names(items: &[&str]) -> BTreeSet<String> {
        items.iter().map(|item| item.to_string()).collect()
    }

    #[test]
    fn note_lists_switch_changes_in_both_directions() {
        let off = note_changes("hi", &names(&[]), &names(&["delete_file"]));
        let on = note_changes("hi", &names(&["delete_file"]), &names(&[]));
        let both = note_changes("hi", &names(&["read_file"]), &names(&["delete_file"]));

        assert_eq!(off, "[Tool status changed: now switched off: delete_file.]\n\nhi");
        assert_eq!(on, "[Tool status changed: now switched on: delete_file.]\n\nhi");
        assert_eq!(
            both,
            "[Tool status changed: now switched off: delete_file; now switched on: read_file.]\n\nhi"
        );
    }

    #[test]
    fn no_change_leaves_text_alone() {
        let same = names(&["delete_file"]);

        assert_eq!(note_changes("hi", &same, &same), "hi");
    }
}
