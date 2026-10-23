//! The Notes section's requests from the web UI.

use serde_json::{Value, json};

use super::{Response, json_response};
use crate::notes;

/// Runs one notes request from the web UI. Failures are reported as a 400 with the reason.
pub(super) fn notes_response(body: &[u8], roots: notes::Roots) -> Response {
    let data: Value = match serde_json::from_slice(body) {
        Ok(data) => data,
        Err(err) => return json_response(400, json!({ "error": format!("invalid JSON: {err}") })),
    };
    match notes::web(&data, roots) {
        Ok(value) => json_response(200, value),
        Err(error) => json_response(400, json!({ "error": error })),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notes_endpoint_reports_failures_as_bad_requests() {
        let roots = notes::Roots { working: None, home: None };
        let unknown = notes_response(br#"{"action":"explode"}"#, roots);
        let malformed = notes_response(b"not json", roots);

        assert_eq!(unknown.status, 400);
        assert_eq!(malformed.status, 400);
    }
}
