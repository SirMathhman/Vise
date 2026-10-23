//! The Sessions panel's requests from the web UI: saving, loading, listing, and titling saved sessions.

use std::path::Path;

use serde_json::{Value, json};

use super::{Response, json_response, parse_messages, parse_told};
use crate::saved_sessions;
use crate::strata::Config;
use crate::titles;

/// Runs one saved-session request from the web UI: `save` writes the page's conversation, `load` returns a saved
/// one, `list` names the saved ones, and `title` gives a saved one its title. Failures are reported as a 400 with the reason.
pub(super) fn sessions_response(body: &[u8], config: &Config) -> Response {
    let working = config.working_dir.as_deref().map(Path::new);
    let data: Value = match serde_json::from_slice(body) {
        Ok(data) => data,
        Err(err) => return json_response(400, json!({ "error": format!("invalid JSON: {err}") })),
    };
    let name = data["name"].as_str().unwrap_or_default();
    let result = match data["action"].as_str() {
        Some("save") => parse_messages(body)
            .and_then(|messages| saved_sessions::save(working, name, &messages, &parse_told(body)))
            .map(|message| json!({ "message": message })),
        Some("load") => saved_sessions::load(working, name)
            .map(|saved| saved_sessions::to_value(&saved.messages, &saved.told, saved.title.as_deref())),
        Some("list") => saved_sessions::listed(working).map(|listed| {
            let sessions: Vec<Value> = listed.into_iter().map(|item| json!({ "name": item.name, "title": item.title })).collect();
            json!({ "sessions": sessions })
        }),
        Some("title") => parse_messages(body)
            .and_then(|messages| titles::ensure(working, name, &messages, config))
            .map(|title| json!({ "title": title })),
        _ => Err("action must be save, load, list, or title".to_owned()),
    };
    match result {
        Ok(value) => json_response(200, value),
        Err(error) => json_response(400, json!({ "error": error })),
    }
}
