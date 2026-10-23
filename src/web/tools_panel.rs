//! The Tools panel's requests from the web UI: listing a tab's tools, and switching one on or off.

use serde_json::{Value, json};

use super::{Response, Sessions, json_response, parse_session};
use crate::tools;

/// Lists the tools for the tab's session. A body with `name` and `enabled` also switches that tool first.
pub(super) fn tools_response(body: &[u8], sessions: &Sessions) -> Response {
    let Some(session) = parse_session(body) else {
        return json_response(400, json!({ "error": "missing or invalid session" }));
    };
    let data: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
    if data.get("name").is_some() {
        let Some(name) = data["name"].as_str().filter(|name| tools::NAMES.contains(name)) else {
            return json_response(400, json!({ "error": "unknown tool" }));
        };
        let Some(enabled) = data["enabled"].as_bool() else {
            return json_response(400, json!({ "error": "enabled must be true or false" }));
        };
        sessions.get(&session).set(name, enabled);
    }
    // A listing alone does not record the session, so reads cannot grow the session map.
    let switches = sessions.find(&session).unwrap_or_default();
    json_response(200, json!({ "tools": tools::listing(&switches) }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_tools_listing_does_not_record_the_session() {
        let sessions = Sessions::default();
        let response = tools_response(br#"{"session":"tab-3"}"#, &sessions);

        assert_eq!(response.status, 200);
        assert!(sessions.by_id.lock().unwrap().is_empty());
    }

    #[test]
    fn tools_endpoint_switches_only_its_own_tab() {
        let sessions = Sessions::default();
        let response = tools_response(br#"{"session":"tab-1","name":"delete_file","enabled":false}"#, &sessions);
        let data: Value = serde_json::from_str(&response.body).unwrap();
        let unknown = tools_response(br#"{"session":"tab-1","name":"nope","enabled":true}"#, &sessions);

        assert_eq!(response.status, 200);
        let delete = data["tools"].as_array().unwrap().iter().find(|tool| tool["name"] == "delete_file").unwrap();
        assert_eq!(delete["enabled"], false);
        assert!(sessions.get("tab-2").snapshot().is_empty());
        assert_eq!(unknown.status, 400);
    }
}
