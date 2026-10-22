//! Helpers shared by the file tools and the note tools: path confinement to the working directory, reading
//! a line range, and argument parsing. This module depends on nothing else in the crate, so both tool modules
//! can use it without a cycle.

use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

use serde_json::Value;

/// Resolves a tool path and refuses it unless it lies inside the working directory. The path must
/// be relative and is checked lexically before any filesystem call. Missing trailing components are
/// allowed, so new files are checked against their existing parent. The root itself is refused
/// unless `allow_root` is set, so a write or delete can never target the working directory.
pub fn resolve(root: Option<&Path>, path: &str, allow_root: bool) -> Result<PathBuf, String> {
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

pub fn string_arg<'a>(args: &'a Value, key: &str) -> Result<&'a str, String> {
    args.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{key} must be a string"))
}

/// Reads the `start` and `end` arguments of a line-range call. Both are 1-based and at least 1.
pub fn line_range(args: &Value) -> Result<(u64, u64), String> {
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
    Ok((start, end))
}

/// Returns lines `start` (included) to `end` (excluded), both 1-based, each prefixed with its number.
/// An end past the last line is clipped to the file; a range with nothing in it is an error. `label`
/// names the file in messages.
pub fn read_range(label: &str, target: &Path, start: u64, end: u64) -> Result<String, String> {
    let text = fs::read_to_string(target).map_err(|err| format!("could not read {label}: {err}"))?;
    let lines: Vec<&str> = text.lines().collect();
    let total = lines.len() as u64;
    let stop = end.min(total + 1);
    if start >= stop {
        return Err(format!("no lines in range {start} to {end}; {label} has {total} lines"));
    }

    let selected = &lines[(start - 1) as usize..(stop - 1) as usize];
    Ok(selected
        .iter()
        .enumerate()
        .map(|(offset, line)| format!("{}\t{line}", start + offset as u64))
        .collect::<Vec<_>>()
        .join("\n"))
}
