//! The Files panel's requests: one page of a folder's entries, and the text of one file in the working directory.

use std::path::Path;

use serde_json::{Value, json};

use super::{Response, json_response};
use crate::file_tree;
use crate::strata::Config;

/// The text of one file in the working directory, for the Files panel. Failures are reported as a 400 with the reason.
pub(super) fn file_response(body: &[u8], config: &Config) -> Response {
    let data: Value = match serde_json::from_slice(body) {
        Ok(data) => data,
        Err(err) => return json_response(400, json!({ "error": format!("invalid JSON: {err}") })),
    };
    let Some(path) = data["path"].as_str() else {
        return json_response(400, json!({ "error": "path must be a string" }));
    };
    let offset = data["offset"].as_u64().unwrap_or(0);
    let Some(root) = config.working_dir.as_deref() else {
        return json_response(400, json!({ "error": "no working directory is set" }));
    };
    match file_tree::read_lines(Path::new(root), path, offset) {
        Ok(block) => json_response(200, json!({ "path": path, "lines": block.lines, "next": block.next, "more": block.more })),
        Err(error) => json_response(400, json!({ "error": error })),
    }
}

/// One page of a folder's entries for the Files panel. The folder is named relative to the working directory (`""` is
/// the working directory), and `after` names the entry the page starts after. Failures are reported as a 400.
pub(super) fn files_response(body: &[u8], config: &Config) -> Response {
    let data: Value = match serde_json::from_slice(body) {
        Ok(data) => data,
        Err(err) => return json_response(400, json!({ "error": format!("invalid JSON: {err}") })),
    };
    let dir = data["dir"].as_str().unwrap_or("");
    let after = data["after"].as_object().and_then(|after| {
        Some(file_tree::Cursor { name: after.get("name")?.as_str()?.to_owned(), dir: after.get("dir")?.as_bool()? })
    });
    let Some(root) = config.working_dir.as_deref() else {
        return json_response(400, json!({ "error": "no working directory is set" }));
    };
    match file_tree::list_dir(Path::new(root), dir, after.as_ref()) {
        Ok(page) => {
            let entries: Vec<Value> = page.entries.iter().map(|entry| json!({ "name": entry.name, "dir": entry.dir })).collect();
            let next = page.next.as_ref().map_or(Value::Null, |cursor| json!({ "name": cursor.name, "dir": cursor.dir }));
            json_response(200, json!({ "dir": dir, "name": page.name, "entries": entries, "next": next, "more": page.more }))
        }
        Err(error) => json_response(400, json!({ "error": error })),
    }
}
