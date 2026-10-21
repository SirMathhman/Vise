use std::io::{self, BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};

use serde_json::{Value, json};

use crate::strata::{self, Config, Message, Role};

pub const DEFAULT_PORT: u16 = 3000;

const INDEX_HTML: &str = include_str!("../web/index.html");
const APP_JS: &str = include_str!("../web/app.js");
const JSON_TYPE: &str = "application/json";

struct Request {
    method: String,
    path: String,
    body: Vec<u8>,
}

struct Response {
    status: u16,
    content_type: &'static str,
    body: String,
}

pub fn serve(port: u16) -> io::Result<()> {
    let listener = TcpListener::bind(("127.0.0.1", port))?;
    println!("Serving UI at http://127.0.0.1:{port}");

    for stream in listener.incoming() {
        if let Err(err) = stream.and_then(handle) {
            eprintln!("request failed: {err}");
        }
    }
    Ok(())
}

fn handle(stream: TcpStream) -> io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let request = read_request(&mut reader)?;
    let response = route(&request);
    write_response(stream, &response)
}

fn read_request(reader: &mut impl BufRead) -> io::Result<Request> {
    let mut request_line = String::new();
    reader.read_line(&mut request_line)?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_owned();
    let path = parts.next().unwrap_or_default().to_owned();

    let mut content_length = 0;
    loop {
        let mut header = String::new();
        if reader.read_line(&mut header)? == 0 || header.trim().is_empty() {
            break;
        }
        if let Some((name, value)) = header.split_once(':')
            && name.trim().eq_ignore_ascii_case("content-length")
        {
            content_length = value.trim().parse().unwrap_or(0);
        }
    }

    let mut body = vec![0; content_length];
    reader.read_exact(&mut body)?;
    Ok(Request { method, path, body })
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
        ("POST", "/api/chat") => chat(&request.body),
        _ => Response {
            status: 404,
            content_type: "text/plain; charset=utf-8",
            body: "Not found".to_owned(),
        },
    }
}

fn chat(body: &[u8]) -> Response {
    let messages = match parse_messages(body) {
        Ok(messages) => messages,
        Err(reason) => return json_response(400, json!({ "error": reason })),
    };

    match strata::send_message(&messages, &Config::default()) {
        Ok(reply) => json_response(200, json!({ "reply": reply })),
        Err(err) => json_response(502, json!({ "error": err.to_string() })),
    }
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
                _ => return Err("each message needs role user or assistant".to_owned()),
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

fn write_response(mut stream: TcpStream, response: &Response) -> io::Result<()> {
    let reason = match response.status {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
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
