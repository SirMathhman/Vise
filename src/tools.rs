use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Component, Path, PathBuf};

use serde_json::{Value, json};

pub const LIST_FILES: &str = "list_files";
pub const READ_FILE: &str = "read_file";
pub const CREATE_FILE: &str = "create_file";
pub const CREATE_DIRECTORY: &str = "create_directory";
pub const DELETE_FILE: &str = "delete_file";
pub const DELETE_DIRECTORY: &str = "delete_directory";

/// The tool definitions sent with every chat request.
pub fn definitions() -> Value {
    json!([
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
        }
    ])
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
        _ => Err(format!("unknown tool {name}")),
    };
    truncate(output.unwrap_or_else(|err| format!("error: {err}")))
}

/// Resolves a tool path and refuses it unless it lies inside the working directory. The path must
/// be relative and is checked lexically before any filesystem call. Missing trailing components are
/// allowed, so new files are checked against their existing parent. The root itself is refused
/// unless `allow_root` is set, so a write or delete can never target the working directory.
fn resolve(root: Option<&Path>, path: &str, allow_root: bool) -> Result<PathBuf, String> {
    let root = root
        .ok_or("no working directory is set, so file tools are unavailable")?
        .canonicalize()
        .map_err(|err| format!("could not read the working directory: {err}"))?;
    if Path::new(path)
        .components()
        .any(|part| matches!(part, Component::Prefix(_) | Component::RootDir))
    {
        return Err(format!(
            "absolute, network, device, and drive-relative paths are refused; use a path relative to the working directory: {path}"
        ));
    }
    let requested = root.join(path);

    let mut existing = requested.as_path();
    let mut missing = Vec::new();
    loop {
        match existing.symlink_metadata() {
            Ok(_) => break,
            Err(err) if err.kind() == io::ErrorKind::NotFound => {
                match (existing.parent(), existing.file_name()) {
                    (Some(parent), Some(name)) => {
                        missing.push(name.to_owned());
                        existing = parent;
                    }
                    _ => return Err(format!("cannot resolve path: {path}")),
                }
            }
            Err(err) => return Err(format!("could not inspect {path}: {err}")),
        }
    }
    let mut resolved = existing
        .canonicalize()
        .map_err(|err| format!("could not resolve {path}: {err}"))?;
    resolved.extend(missing.iter().rev());

    if !resolved.starts_with(&root) {
        return Err(format!("path is outside the working directory: {path}"));
    }
    if resolved == root && !allow_root {
        return Err(format!("the working directory itself cannot be changed: {path}"));
    }
    Ok(resolved)
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

/// Returns lines `start` (included) to `end` (excluded), both 1-based, each prefixed with its number.
/// An end past the last line is clipped to the file; a range with nothing in it is an error.
fn read_file(arguments: &str, root: Option<&Path>) -> Result<String, String> {
    let args = parse_arguments(arguments)?;
    let path = args
        .get("path")
        .and_then(Value::as_str)
        .ok_or("path must be a string")?;
    let start = args
        .get("start")
        .and_then(Value::as_u64)
        .filter(|start| *start >= 1)
        .ok_or("start must be an integer of at least 1")?;
    let end = args
        .get("end")
        .and_then(Value::as_u64)
        .filter(|end| *end >= 1)
        .ok_or("end must be an integer of at least 1")?;

    let target = resolve(root, path, true)?;
    let text = fs::read_to_string(&target).map_err(|err| format!("could not read {path}: {err}"))?;
    let lines: Vec<&str> = text.lines().collect();
    let total = lines.len() as u64;
    let stop = end.min(total + 1);
    if start >= stop {
        return Err(format!("no lines in range {start} to {end}; {path} has {total} lines"));
    }

    let selected = &lines[(start - 1) as usize..(stop - 1) as usize];
    Ok(selected
        .iter()
        .enumerate()
        .map(|(offset, line)| format!("{}\t{line}", start + offset as u64))
        .collect::<Vec<_>>()
        .join("\n"))
}

fn string_arg<'a>(args: &'a Value, key: &str) -> Result<&'a str, String> {
    args.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{key} must be a string"))
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
