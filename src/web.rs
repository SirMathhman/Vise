use std::collections::{BTreeSet, HashMap};
use std::io::{self, BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread;
use std::time::Duration;

use serde_json::{Value, json};

use crate::agent::{self, TurnError};
use crate::commands;
use crate::compaction;
use crate::notes;
use crate::tools::{self, Switches};
use crate::strata::{Chunk, Config, Message, Role};

pub const DEFAULT_PORT: u16 = 3000;

const INDEX_HTML: &str = include_str!("../web/index.html");
const APP_JS: &str = include_str!("../web/app.js");
const JSON_TYPE: &str = "application/json";
const MAX_BODY_BYTES: usize = 1024 * 1024;
const READ_TIMEOUT: Duration = Duration::from_secs(10);

struct Request {
    method: String,
    path: String,
    content_type: Option<String>,
    content_length: usize,
    body: Vec<u8>,
}

struct Response {
    status: u16,
    content_type: &'static str,
    body: String,
}

/// Each browser tab's switches, keyed by the session id the tab sends. The map is shared; each tab's set is its own,
/// so `/disable` in one tab never changes another.
#[derive(Default)]
struct Sessions {
    by_id: Mutex<HashMap<String, Arc<Switches>>>,
}

impl Sessions {
    fn get(&self, id: &str) -> Arc<Switches> {
        let mut by_id = self.by_id.lock().unwrap_or_else(PoisonError::into_inner);
        Arc::clone(by_id.entry(id.to_owned()).or_insert_with(|| Arc::new(Switches::default())))
    }
}

pub fn serve(port: u16, config: Config) -> io::Result<()> {
    let listener = TcpListener::bind(("127.0.0.1", port))?;
    println!("Serving UI at http://127.0.0.1:{port}");
    accept_loop(listener, Arc::new(config), Arc::new(Sessions::default()));
    Ok(())
}

fn accept_loop(listener: TcpListener, config: Arc<Config>, sessions: Arc<Sessions>) {
    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                let config = Arc::clone(&config);
                let sessions = Arc::clone(&sessions);
                thread::spawn(move || {
                    if let Err(err) = handle(stream, &config, &sessions) {
                        eprintln!("request failed: {err}");
                    }
                });
            }
            Err(err) => eprintln!("connection failed: {err}"),
        }
    }
}

fn handle(mut stream: TcpStream, config: &Config, sessions: &Sessions) -> io::Result<()> {
    stream.set_read_timeout(Some(READ_TIMEOUT))?;
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut request = read_request(&mut reader)?;
    if request.content_length > MAX_BODY_BYTES {
        let response = json_response(413, json!({ "error": "request body too large" }));
        return write_response(&mut stream, &response);
    }

    request.body = read_body(&mut reader, request.content_length)?;
    if request.method == "POST" && request.path == "/api/chat" {
        return chat(stream, &request, config, sessions);
    }
    write_response(&mut stream, &route(&request))
}

fn read_request(reader: &mut impl BufRead) -> io::Result<Request> {
    let mut request_line = String::new();
    reader.read_line(&mut request_line)?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_owned();
    let path = parts.next().unwrap_or_default().to_owned();

    let mut content_length = 0;
    let mut content_type = None;
    loop {
        let mut header = String::new();
        if reader.read_line(&mut header)? == 0 || header.trim().is_empty() {
            break;
        }
        if let Some((name, value)) = header.split_once(':') {
            let name = name.trim();
            let value = value.trim();
            if name.eq_ignore_ascii_case("content-length") {
                content_length = value.parse().unwrap_or(0);
            } else if name.eq_ignore_ascii_case("content-type") {
                content_type = Some(value.to_ascii_lowercase());
            }
        }
    }

    Ok(Request {
        method,
        path,
        content_type,
        content_length,
        body: Vec::new(),
    })
}

fn read_body(reader: &mut impl BufRead, length: usize) -> io::Result<Vec<u8>> {
    let mut body = vec![0; length];
    reader.read_exact(&mut body)?;
    Ok(body)
}

fn route(request: &Request) -> Response {
    match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/") => Response {
            status: 200,
            content_type: "text/html; charset=utf-8",
            body: INDEX_HTML.to_owned(),
        },
        ("GET", "/app.js") => Response {
            status: 200,
            content_type: "text/javascript; charset=utf-8",
            body: APP_JS.to_owned(),
        },
        _ => Response {
            status: 404,
            content_type: "text/plain; charset=utf-8",
            body: "Not found".to_owned(),
        },
    }
}

/// Streams the reply as server-sent events: `reasoning` and `content` deltas, then `done` or `error`.
fn chat(
    mut stream: TcpStream,
    request: &Request,
    config: &Config,
    sessions: &Sessions,
) -> io::Result<()> {
    let is_json = request
        .content_type
        .as_deref()
        .is_some_and(|content_type| content_type.starts_with("application/json"));
    if !is_json {
        let response = json_response(
            415,
            json!({ "error": "expected Content-Type application/json" }),
        );
        return write_response(&mut stream, &response);
    }

    let Some(session) = parse_session(&request.body) else {
        let response = json_response(400, json!({ "error": "missing or invalid session" }));
        return write_response(&mut stream, &response);
    };
    let switches = sessions.get(&session);

    let mut messages = match parse_messages(&request.body) {
        Ok(messages) => messages,
        Err(reason) => {
            return write_response(&mut stream, &json_response(400, json!({ "error": reason })));
        }
    };

    let mut started = false;
    if let Some(reply) = messages
        .last()
        .filter(|message| matches!(message.role, Role::User))
        .and_then(|message| {
            commands::handle(&message.content, &switches)
                .or_else(|| notes::command(&message.content, config.working_dir.as_deref().map(Path::new)))
        })
    {
        start_stream(&mut stream, &mut started)?;
        write_event(&mut stream, &json!({ "type": "content", "text": reply }))?;
        return write_event(&mut stream, &json!({ "type": "done", "answer": reply }));
    }

    // The page sends the switches it has told the model about. The note goes on the user message, and
    // the new record is returned in the done event, which the page keeps only once it arrives.
    let now = switches.snapshot();
    let told = parse_told(&request.body);
    // The notes index goes on the first message of a conversation only, so it is kept in the page's history.
    let first = messages.len() == 1;
    let root = config.working_dir.as_deref().map(Path::new);
    let noted = messages
        .last_mut()
        .filter(|message| matches!(message.role, Role::User))
        .map(|message| {
            if first {
                message.content = notes::with_index(&message.content, root);
            }
            message.content = tools::note_changes(&message.content, &told, &now);
            message.content.clone()
        });

    // A failed write means the browser closed the page (or stopped the reply): the turn stops there.
    let cancel = AtomicBool::new(false);
    let outcome = agent::run_turn(&messages, config, &switches, &cancel, &mut |chunk| {
        let event = match chunk {
            Chunk::Reasoning(text) => json!({ "type": "reasoning", "text": text }),
            Chunk::Content(text) => json!({ "type": "content", "text": text }),
            Chunk::Tool(text) => json!({ "type": "tool", "text": text }),
        };
        let sent = start_stream(&mut stream, &mut started).and_then(|()| write_event(&mut stream, &event));
        if sent.is_err() {
            cancel.store(true, Ordering::Relaxed);
        }
    });

    match outcome {
        // The page stopped the turn itself: nothing more is sent, and the connection is already gone.
        Err(TurnError::Stopped { .. }) => Ok(()),
        Ok(answer) => {
            start_stream(&mut stream, &mut started)?;
            let mut log = messages.clone();
            log.push(Message {
                role: Role::Assistant,
                content: answer.clone(),
            });
            let (summary, summary_failed) = match compaction::after_turn(&log, config) {
                Some(Message { role: Role::Summary, content }) => (Some(content), None),
                Some(Message { content, .. }) => (None, Some(content)),
                None => (None, None),
            };
            write_event(
                &mut stream,
                &json!({
                    "type": "done",
                    "answer": answer,
                    "user_message": noted,
                    "told": now,
                    "summary": summary,
                    "summary_failed": summary_failed,
                }),
            )
        }
        // Nothing was sent yet, so the failure can still be a plain JSON error response.
        Err(err @ TurnError::Failed { .. }) if !started => {
            let response = json_response(502, json!({ "error": err.to_string(), "ran": err.ran() }));
            write_response(&mut stream, &response)
        }
        Err(err @ TurnError::Failed { .. }) => write_event(
            &mut stream,
            &json!({ "type": "error", "error": err.to_string(), "ran": err.ran() }),
        ),
    }
}

/// Sends the event-stream headers once, before the first event.
fn start_stream(stream: &mut TcpStream, started: &mut bool) -> io::Result<()> {
    if !*started {
        *started = true;
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n"
        )?;
    }
    Ok(())
}

fn write_event(stream: &mut TcpStream, event: &Value) -> io::Result<()> {
    write!(stream, "data: {event}\n\n")
}

/// The tab's session id: a short token the page keeps in sessionStorage. Missing or malformed ids are refused.
fn parse_session(body: &[u8]) -> Option<String> {
    let id = serde_json::from_slice::<Value>(body)
        .ok()?
        .get("session")?
        .as_str()?
        .to_owned();
    let valid = !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    valid.then_some(id)
}

/// The switched-off tools the page has already told the model about, sent with each chat request.
fn parse_told(body: &[u8]) -> BTreeSet<String> {
    serde_json::from_slice::<Value>(body)
        .ok()
        .and_then(|data| data.get("told").and_then(Value::as_array).cloned())
        .unwrap_or_default()
        .iter()
        .filter_map(|name| name.as_str().map(str::to_owned))
        .collect()
}

fn json_response(status: u16, value: Value) -> Response {
    Response {
        status,
        content_type: JSON_TYPE,
        body: value.to_string(),
    }
}

fn parse_messages(body: &[u8]) -> Result<Vec<Message>, String> {
    let data: Value = serde_json::from_slice(body).map_err(|err| format!("invalid JSON: {err}"))?;
    let items = data
        .get("messages")
        .and_then(Value::as_array)
        .ok_or("expected a messages array")?;

    items
        .iter()
        .map(|item| {
            let role = match item.get("role").and_then(Value::as_str) {
                Some("user") => Role::User,
                Some("assistant") => Role::Assistant,
                Some("summary") => Role::Summary,
                Some("summary_failed") => Role::SummaryFailed,
                _ => return Err("each message needs role user, assistant, summary, or summary_failed".to_owned()),
            };
            let content = item
                .get("content")
                .and_then(Value::as_str)
                .ok_or_else(|| "each message needs string content".to_owned())?;
            Ok(Message {
                role,
                content: content.to_owned(),
            })
        })
        .collect()
}

fn write_response(stream: &mut TcpStream, response: &Response) -> io::Result<()> {
    let reason = match response.status {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        413 => "Payload Too Large",
        415 => "Unsupported Media Type",
        _ => "Bad Gateway",
    };
    write!(
        stream,
        "HTTP/1.1 {} {reason}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        response.status,
        response.content_type,
        response.body.len(),
        response.body
    )
}

#[cfg(test)]
mod tests {
    use std::io::{Cursor, Read};

    use super::*;

    #[test]
    fn stalled_client_does_not_block_other_requests() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        thread::spawn(move || {
            accept_loop(
                listener,
                Arc::new(Config::default()),
                Arc::new(Sessions::default()),
            )
        });

        let _stalled = TcpStream::connect(("127.0.0.1", port)).unwrap();
        let mut client = TcpStream::connect(("127.0.0.1", port)).unwrap();
        client.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        client
            .write_all(b"GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
            .unwrap();

        let mut response = String::new();
        client.read_to_string(&mut response).unwrap();
        assert!(response.starts_with("HTTP/1.1 200 OK"));
    }

    #[test]
    fn read_request_reports_oversized_content_length_without_reading_body() {
        let head = format!(
            "POST /api/chat HTTP/1.1\r\nContent-Length: {}\r\n\r\n",
            MAX_BODY_BYTES + 1
        );
        let request = read_request(&mut Cursor::new(head)).unwrap();

        assert!(request.content_length > MAX_BODY_BYTES);
        assert!(request.body.is_empty());
    }
    #[test]
    fn a_tabs_switches_do_not_change_another_tab() {
        let sessions = Sessions::default();
        let a = sessions.get("tab-a");
        let b = sessions.get("tab-b");

        a.set("delete_file", false);

        assert!(a.snapshot().contains("delete_file"));
        assert!(!b.snapshot().contains("delete_file"));
        assert!(Arc::ptr_eq(&a, &sessions.get("tab-a")));
    }

    #[test]
    fn simultaneous_toggles_in_two_tabs_stay_separate() {
        let sessions = Arc::new(Sessions::default());
        let workers: Vec<_> = ["tab-a", "tab-b"]
            .into_iter()
            .map(|id| {
                let sessions = Arc::clone(&sessions);
                thread::spawn(move || {
                    let switches = sessions.get(id);
                    for _ in 0..500 {
                        switches.set("delete_file", false);
                        switches.set("delete_file", true);
                    }
                    switches.set("list_files", false);
                })
            })
            .collect();
        for worker in workers {
            worker.join().unwrap();
        }

        for id in ["tab-a", "tab-b"] {
            let switches = sessions.get(id);
            assert!(!switches.snapshot().contains("delete_file"), "{id}");
            assert!(switches.snapshot().contains("list_files"), "{id}");
        }
    }

    #[test]
    fn session_ids_are_required_and_short() {
        assert_eq!(parse_session(br#"{"session":"tab-1"}"#).as_deref(), Some("tab-1"));
        assert_eq!(parse_session(br#"{"messages":[]}"#), None);
        assert_eq!(parse_session(br#"{"session":"a b"}"#), None);
        assert_eq!(parse_session(br#"{"session":""}"#), None);
        assert_eq!(parse_session(format!(r#"{{"session":"{}"}}"#, "x".repeat(65)).as_bytes()), None);
    }
}
