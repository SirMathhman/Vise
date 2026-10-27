use super::types::ToolError;
use std::path::{Path, PathBuf};

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
