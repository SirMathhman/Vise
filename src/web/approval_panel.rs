//! The web UI's answer to an edit that waits for approval: `POST /api/approve` with the tab's session, the request id,
//! and the answer (`allow`, `always`, `deny`, or `stop`).

use serde_json::{Value, json};

use super::{Response, Sessions, json_response, parse_session};
use crate::approval::Answer;

pub(super) fn approve_response(body: &[u8], sessions: &Sessions) -> Response {
    let Some(session) = parse_session(body) else {
        return json_response(400, json!({ "error": "missing or invalid session" }));
    };
    let data: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
    let Some(id) = data["id"].as_u64() else {
        return json_response(400, json!({ "error": "id must be a number" }));
    };
    let Some(answer) = data["answer"].as_str().and_then(parse_answer) else {
        return json_response(400, json!({ "error": "answer must be allow, always, deny or stop" }));
    };
    let answered = sessions.find(&session).is_some_and(|switches| switches.approvals().answer(id, answer));
    if answered {
        json_response(200, json!({ "ok": true }))
    } else {
        json_response(404, json!({ "error": "no approval is waiting with that id" }))
    }
}

fn parse_answer(text: &str) -> Option<Answer> {
    match text {
        "allow" => Some(Answer::Allow),
        "always" => Some(Answer::AllowAlways),
        "deny" => Some(Answer::Deny),
        "stop" => Some(Answer::Stop),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_answer_reaches_the_waiting_tab_once() {
        let sessions = Sessions::default();
        let id = sessions.get("tab-1").approvals().open();
        let body = format!(r#"{{"session":"tab-1","id":{id},"answer":"allow"}}"#);

        assert_eq!(approve_response(body.as_bytes(), &sessions).status, 200);
        assert_eq!(approve_response(body.as_bytes(), &sessions).status, 404);
    }

    #[test]
    fn an_answer_for_another_tab_is_refused() {
        let sessions = Sessions::default();
        let id = sessions.get("tab-1").approvals().open();
        let body = format!(r#"{{"session":"tab-2","id":{id},"answer":"deny"}}"#);

        assert_eq!(approve_response(body.as_bytes(), &sessions).status, 404);
    }
}
