use futures_util::{SinkExt, StreamExt};
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use hyper_util::rt::tokio::WithTokioIo;
use http_body_util::Full;
use std::net::TcpListener;
use bytes::Bytes;
use tokio::sync::watch;
use tokio_tungstenite::tungstenite::handshake::derive_accept_key;
use tokio_tungstenite::tungstenite::Message;

type ResBody = Full<Bytes>;
type HttpError = std::io::Error;

fn text_response(status: StatusCode, body: &str) -> Response<ResBody> {
    let mut res = Response::new(Full::from(Bytes::copy_from_slice(body.as_bytes())));
    *res.status_mut() = status;
    res
}

// ── Port selection (mirrors apps/web/src/port.ts choosePort) ──────────────────

fn is_port_free(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).is_ok()
}

fn choose_port(preferred: u16) -> u16 {
    if is_port_free(preferred) {
        return preferred;
    }
    for port in (preferred + 1)..=std::cmp::min(preferred + 100, 65535) {
        if is_port_free(port) {
            return port;
        }
    }
    let l = TcpListener::bind(("127.0.0.1", 0)).expect("could not bind to any port");
    let port = l.local_addr().expect("bound listener has a local address").port();
    drop(l);
    port
}

// ── Static assets (mirrors apps/web/src/assets.ts WEB_ASSETS) ───────────────────

const ASSETS: &[(&str, &str, &str)] = &[
    ("/", "packages/frontend/index.html", "text/html; charset=utf-8"),
    ("/index.html", "packages/frontend/index.html", "text/html; charset=utf-8"),
    ("/icon.svg", "assets/icon.svg", "image/svg+xml"),
    ("/dist/app.js", "packages/frontend/dist/app.js", "text/javascript; charset=utf-8"),
    ("/dist/app.css", "packages/frontend/dist/app.css", "text/css; charset=utf-8"),
];

fn is_local_host(host: &str, port: u16) -> bool {
    host == format!("localhost:{port}") || host == format!("127.0.0.1:{port}")
}

fn asset_response(path: &str) -> Response<ResBody> {
    match ASSETS.iter().find(|(p, _, _)| *p == path) {
        Some((_, file, ct)) => match std::fs::read(file) {
            Ok(bytes) => {
                let mut res = Response::new(Full::from(bytes));
                res.headers_mut()
                    .insert("Content-Type", ct.parse().unwrap());
                res
            }
            Err(e) => {
                text_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    &format!("500: cannot read {}: {}", file, e),
                )
            }
        },
        None => text_response(StatusCode::NOT_FOUND, "not found"),
    }
}

// ── Request handler ─────────────────────────────────────────────────────────────

async fn handle(mut req: Request<Incoming>, port: u16) -> Result<Response<ResBody>, HttpError> {
    let path = req.uri().path().to_string();

    // WebSocket upgrade on /ws and /ext
    if (path == "/ws" || path == "/ext")
        && req.method() == Method::GET
        && req
            .headers()
            .get("upgrade")
            .is_some_and(|v| v.as_bytes().eq_ignore_ascii_case(b"websocket"))
    {
        let key = req
            .headers()
            .get("sec-websocket-key")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        let accept_key = derive_accept_key(key.as_bytes());

        let upgraded = hyper::upgrade::on(&mut req);

        let mut res = Response::new(Full::default());
        *res.status_mut() = StatusCode::SWITCHING_PROTOCOLS;
        res.headers_mut().insert("Upgrade", "websocket".parse().unwrap());
        res.headers_mut().insert("Connection", "Upgrade".parse().unwrap());
        res.headers_mut().insert("Sec-WebSocket-Accept", accept_key.parse().unwrap());

        tokio::spawn(async move {
            let Ok(upgraded) = upgraded.await else { return; };
            // WithTokioIo bridges hyper's Read/Write to tokio's AsyncRead/AsyncWrite.
            let Ok(mut ws) =
                tokio_tungstenite::accept_async(WithTokioIo::new(upgraded)).await
            else {
                return;
            };
            loop {
                match ws.next().await {
                    Some(Ok(Message::Ping(payload))) => {
                        if ws.send(Message::Pong(payload)).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(Message::Close(_))) => break,
                    Some(Ok(_)) => {}
                    _ => break,
                }
            }
        });

        return Ok(res);
    }

    // Host-header check (DNS-rebinding guard)
    let host = req
        .headers()
        .get("host")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    if !is_local_host(&host, port) {
        return Ok(text_response(StatusCode::FORBIDDEN, "forbidden"));
    }

    Ok(asset_response(&path))
}

// ── Main ─────────────────────────────────────────────────────────────────────────

#[tokio::main(flavor = "multi_thread")]
async fn main() {
    let port: u16 = std::env::args()
        .find_map(|a| a.strip_prefix("--port=").and_then(|v| v.parse().ok()))
        .unwrap_or(3000);

    let port = choose_port(port);
    println!("vise web: http://localhost:{port}");

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
        .await
        .expect("bind to port");

    let (shutdown_tx, shutdown_rx) = watch::channel(true);

    tokio::spawn({
        let shutdown_tx = shutdown_tx.clone();
        async move {
            tokio::signal::ctrl_c().await.expect("ctrl+c");
            let _ = shutdown_tx.send(false);
        }
    });

    loop {
        if !*shutdown_rx.borrow() {
            break;
        }
        let (stream, _addr) = listener.accept().await.expect("accept");
        let port = port;
        tokio::spawn(async move {
            let io = TokioIo::new(stream);
            let _ = http1::Builder::new()
                .serve_connection(io, service_fn(move |req| handle(req, port)))
                .await;
        });
    }
}


