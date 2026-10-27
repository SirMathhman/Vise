use super::types::ToolError;
use std::ffi::OsStr;
use std::path::{Component, Path, PathBuf};

pub fn confine(cwd: &Path, requested: &str) -> Result<PathBuf, ToolError> {
    let root = cwd
        .canonicalize()
        .map_err(|err| ToolError::Failed(format!("cannot open the working directory: {err}")))?;
    let target = root
        .join(requested)
        .canonicalize()
        .map_err(|err| ToolError::Failed(format!("cannot open '{requested}': {err}")))?;
    if !target.starts_with(&root) {
        return Err(ToolError::Failed(format!("'{requested}' is outside the working directory")));
    }
    Ok(target)
}

/// Resolves a path for a write, where the path itself may not exist yet. `..` is resolved lexically
/// and may not climb above the working directory. The deepest existing ancestor must also stay inside
/// it, so a symlink cannot redirect the write.
pub fn confine_new(cwd: &Path, requested: &str) -> Result<PathBuf, ToolError> {
    let root = cwd
        .canonicalize()
        .map_err(|err| ToolError::Failed(format!("cannot open the working directory: {err}")))?;
    let outside = || ToolError::Failed(format!("'{requested}' is outside the working directory"));
    let mut parts: Vec<&OsStr> = Vec::new();
    for component in Path::new(requested).components() {
        match component {
            Component::Normal(part) => parts.push(part),
            Component::CurDir => {}
            Component::ParentDir => {
                parts.pop().ok_or_else(outside)?;
            }
            Component::RootDir | Component::Prefix(_) => return Err(outside()),
        }
    }
    let target = parts.iter().fold(root.clone(), |path, part| path.join(part));
    let existing = target.ancestors().find(|ancestor| ancestor.exists()).unwrap_or(root.as_path());
    let existing = existing
        .canonicalize()
        .map_err(|err| ToolError::Failed(format!("cannot open '{requested}': {err}")))?;
    if !existing.starts_with(&root) {
        return Err(outside());
    }
    Ok(target)
}
