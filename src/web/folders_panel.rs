//! Folders for the web UI: the folder picker's listing (`POST /api/dirs`), and the folder a request runs in. Each chat
//! works in one folder, which the page sends as `working_dir` with each request.

use std::path::Path;

use serde_json::{Value, json};

use super::{Response, json_response};
use crate::strata::Config;

/// The config for one request. A request that names a `working_dir` runs in that folder, which must be an absolute path
/// to an existing directory. A request without one runs in the server's startup folder.
pub(super) fn folder_config(config: &Config, body: &[u8]) -> Result<Config, String> {
    let data: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
    let Some(dir) = data["working_dir"].as_str() else {
        return Ok(config.clone());
    };
    let path = Path::new(dir);
    if !path.is_absolute() || !path.is_dir() {
        return Err(format!("not an existing folder: {dir}"));
    }
    Ok(Config { working_dir: Some(dir.to_owned()), ..config.clone() })
}

/// Lists the folders in the picker's path. An empty path lists the top level: the drives on Windows, or `/` elsewhere.
/// Without a path, the picker starts in the server's startup folder.
pub(super) fn folders_response(body: &[u8], config: &Config) -> Response {
    let data: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
    let path = data["path"].as_str().map(str::to_owned).or_else(|| config.working_dir.clone()).unwrap_or_default();
    if path.is_empty() {
        return json_response(200, json!({ "path": "", "parent": "", "folders": top_level() }));
    }
    match list(&path) {
        Ok(listing) => json_response(200, listing),
        Err(err) => json_response(400, json!({ "error": err })),
    }
}

/// The folders directly inside `path`, sorted by name, without files.
fn list(path: &str) -> Result<Value, String> {
    let dir = Path::new(path);
    if !dir.is_absolute() || !dir.is_dir() {
        return Err(format!("not an existing folder: {path}"));
    }
    let entries = std::fs::read_dir(dir).map_err(|err| format!("could not read {path}: {err}"))?;
    let mut folders: Vec<(String, String)> = entries
        .filter_map(Result::ok)
        .filter(|entry| entry.path().is_dir())
        .map(|entry| (entry.file_name().to_string_lossy().into_owned(), entry.path().display().to_string()))
        .collect();
    folders.sort_by_key(|(name, _)| name.to_lowercase());
    let parent = dir.parent().map(|parent| parent.display().to_string()).unwrap_or_default();
    Ok(json!({ "path": path, "parent": parent, "folders": folder_items(folders) }))
}

/// The top level: the drives that exist on Windows, or `/` elsewhere.
fn top_level() -> Vec<Value> {
    let roots: Vec<(String, String)> = if cfg!(windows) {
        ('A'..='Z')
            .map(|letter| format!("{letter}:\\"))
            .filter(|root| Path::new(root).is_dir())
            .map(|root| (root.clone(), root))
            .collect()
    } else {
        vec![("/".to_owned(), "/".to_owned())]
    };
    folder_items(roots)
}

fn folder_items(folders: Vec<(String, String)>) -> Vec<Value> {
    folders.into_iter().map(|(name, path)| json!({ "name": name, "path": path })).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("vise-folders-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("b")).unwrap();
        std::fs::create_dir_all(root.join("A")).unwrap();
        std::fs::write(root.join("file.txt"), "x").unwrap();
        root
    }

    #[test]
    fn a_request_without_a_folder_keeps_the_startup_folder() {
        let config = Config { working_dir: Some("C:\\start".to_owned()), ..Config::default() };
        let scoped = folder_config(&config, br#"{"messages":[]}"#).unwrap();

        assert_eq!(scoped.working_dir.as_deref(), Some("C:\\start"));
    }

    #[test]
    fn a_request_with_an_existing_folder_runs_in_it() {
        let root = scratch("runs");
        let dir = root.display().to_string();
        let body = format!(r#"{{"working_dir":{}}}"#, serde_json::to_string(&dir).unwrap());
        let scoped = folder_config(&Config::default(), body.as_bytes()).unwrap();
        std::fs::remove_dir_all(&root).unwrap();

        assert_eq!(scoped.working_dir.as_deref(), Some(dir.as_str()));
    }

    #[test]
    fn a_missing_or_relative_folder_is_refused() {
        let missing = folder_config(&Config::default(), br#"{"working_dir":"/no/such/folder/here"}"#);
        let relative = folder_config(&Config::default(), br#"{"working_dir":"some/folder"}"#);

        assert!(missing.is_err());
        assert!(relative.is_err());
    }

    #[test]
    fn the_listing_has_only_folders_sorted_by_name() {
        let root = scratch("listing");
        let body = format!(r#"{{"path":{}}}"#, serde_json::to_string(&root.display().to_string()).unwrap());
        let response = folders_response(body.as_bytes(), &Config::default());
        std::fs::remove_dir_all(&root).unwrap();
        let data: Value = serde_json::from_str(&response.body).unwrap();
        let names: Vec<&str> = data["folders"].as_array().unwrap().iter().map(|folder| folder["name"].as_str().unwrap()).collect();

        assert_eq!(response.status, 200);
        assert_eq!(names, ["A", "b"]);
    }
}
