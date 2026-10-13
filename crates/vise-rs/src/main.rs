use std::net::TcpListener;

use hyper::server;
use hyper::{
    body::{Bytes, IncomingBody},
    server::conn::http1,
    service::service_fn,
    Body as HyperBody,
};
use tokio::net::TcpListener as TokioTcpListener;
use tokio::sync::watch;
use tokio_tungstenite::tungstenite::Message;

// ── Port selection (mirrors apps/web/src/port.ts choosePort) ────────────────

fn is_port_free(port: u16) -> bool {
    match TcpListener::bind(("127.0.0.1", port)) {
        Ok(_) => true,
        Err(_) => false,
    }
}

fn choose_port(preferred: u16) -> u16 {
    if is_port_free(preferred) {
        return preferred;
    }
    // Scan preferred+1 through preferred+100 (matching suggestPort).
    for port in (preferred as u16 + 1)..=std::cmp::min(preferred as u16 + 100, 65535) {
        if is_port_free(port) {
            return port;
        }
    }
    // No port in the scan window: bind to port 0 and let the OS pick.
    // (anyFreePort in port.ts)
    let l = TcpListener::bind(("127.0.0.1", 0)).expect("could not bind to any port");
    let port = l
        .local_addr()
        .expect("bound listener has a local address")
        .port();
    drop(l);
    port
}

// ── Static assets (mirrors apps/web/src/assets.ts WEB_ASSETS) ─────────────────

/// Maps a request path to (file on disk, content-type). Paths are relative to the repo root.
const ASSETS: &[(&str, &str, &str)] = &[
    ("/", "packages/frontend/index.html", "text/html; charset=utf-8"),
    ("/index.html", "packages/frontend/index.html", "text/html; charset=utf-8"),
    ("/icon.svg", "assets/icon.svg", "image/svg+xml"),
    ("/dist/app.js", "packages/frontend/dist/app.js", "text/javascript; charset=utf-8"),
    ("/dist/app.css", "packages/frontend/dist/app.css", "text/css; charset=utf-8"),
];

/// Host is accepted when it is exactly `localhost:PORT` or `127.0.0.1:PORT`.
fn is_local_host(host: &str, port: u16) -> bool {
    host == format!("localhost:{port}") || host == format!("127.0.0.1:{port}")
}

fn asset_response(path: &str, port: u16) -> hyper::Response<HyperBody> {
    let host_ok = {
        // The Host header is checked in the caller; this is a helper for the static-file
        // dispatch only. It is called only after the Host check has already passed.
        true
    };
    if !host_ok {
        return hyper::Response::from((hyper::StatusCode::FORBIDDEN, "forbidden"));
    }

    let _ = port; // port is used by is_local_host in the caller

    match ASSETS.iter().find(|(p, _, _)| p == path) {
        Some((_, file, ct)) => {
            match std::fs::read(file) {
                Ok(bytes) => {
                    let res = hyper::Response::new(HyperBody::from(bytes));
                    let res = res
                        .headers()
                        .get("Content-Type")
                        .map(|_| ())
                        .or_else(|| Some(()))
                        .map(|_| hyper::Response::new(HyperBody::from(bytes)))
                        .unwrap_or_else(|| {
                            let mut res = hyper::Response::new(HyperBody::from(bytes));
                            res.headers_mut().insert(
                                "Content-Type",
                                ct.parse().unwrap(),
                            );
                            res
                        });
                    res
                }
                Err(e) => {
                    let body = format!("500: cannot read {}: {}", file, e);
                    hyper::Response::from((hyper::StatusCode::INTERNAL_SERVER_ERROR, body))
                }
            }
        }
        None => hyper::Response::from((hyper::StatusCode::NOT_FOUND, "not found")),
    }
}

// ── WebSocket placeholder ─────────────────────────────────────────────────────

fn is_ws_path(path: &str) -> bool {
    path == "/ws" || path == "/ext"
}

// ── Request handler ───────────────────────────────────────────────────────────

async fn handle_request(
    req: hyper::Request<HyperBody>,
    port: u16,
    shutdown: tokio::sync::watch::Receiver<()>,
) -> std::io::Result<hyper::Response<HyperBody>> {
    let path = req.uri().path().to_string();

    // WebSocket upgrade
    if is_ws_path(&path)
        && req.method() == hyper::Method::GET
        && req
            .headers()
            .get("upgrade")
            .map(|v| v.as_str().eq_ignore_ascii_case("websocket"))
            .unwrap_or(false)
    {
        // Compute Sec-WebSocket-Accept
        let key = req.headers().get("sec-websocket-key").unwrap();
        let accept_key = {
            // base64(sha1(key + GUID))
            use sha1::Digest;
            use base64::Engine;
            let mut h = sha1::Sha1::new();
            h.update(key.as_bytes());
            h.update(b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11");
            let digest = h.finalize();
            base64::prelude::BASE64_STANDARD.encode(digest)
        };

        let up = hyper::upgrade::on(&req);

        let mut res = hyper::Response::new(HyperBody::empty());
        res.headers_mut()
            .insert("Upgrade", "websocket".parse().unwrap());
        res.headers_mut()
            .insert("Connection", "Upgrade".parse().unwrap());
        res.headers_mut()
            .insert("Sec-WebSocket-Accept", accept_key.parse().unwrap());

        tokio::spawn(async move {
            let incoming = up();
            let stream = match tokio_tungstenite::accept_async(incoming).await {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("ws accept error: {e}");
                    return;
                }
            };
            let mut ws = tokio_tungstenite::WebSocketStream::from(stream);
            while let Some(msg) = ws.next().await {
                match msg {
                    Ok(Message::Ping(payload)) => {
                        let _ = ws.send(Message::Pong(payload)).await;
                    }
                    Ok(Message::Close(_)) => break,
                    Ok(_) => {}
                    Err(_) => break,
                }
            }
        });

        return Ok(res);
    }

    // Host-header check
    let host = req
        .headers()
        .get("host")
        .map(|v| v.to_str().unwrap_or("").to_string())
        .unwrap_or_default();
    if !is_local_host(&host, port) {
        return Ok(hyper::Response::from((hyper::StatusCode::FORBIDDEN, "forbidden")));
    }

    // Static files
    Ok(asset_response(&path, port))
}

// ── Main ──────────────────────────────────────────────────────────────────────

fn main() {
    // CLI arg: --port=N, default 3000
    let port = std::env::args()
        .find_map(|a| a.strip_prefix("--port="))
        .and_then(|v| v.parse().ok())
        .unwrap_or(3000);

    let port = choose_port(port);
    println!("vise web: http://localhost:{port}");

    let rt = tokio::runtime::Runtime::new().expect("create tokio runtime");
    let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel::<()>(());

    rt.block_on(async move {
        let listener = std::net::TcpListener::bind(("127.0.0.1", port))
            .expect("bind to port");
        listener.set_nonblocking(true);
        let tokio_listener = TokioTcpListener::from_std(listener)
            .await
            .expect("convert to tokio listener");

        let port = port;
        let shutdown_rx = shutdown_rx;

        tokio::spawn(async move {
            // Ctrl+C handler
            tokio::signal::ctrl_c().await.expect("ctrl+c signal");
            let _ = shutdown_tx.send(());
        });

        // Serve until shutdown
        while !*shutdown_rx.borrow() {
            match tokio_listener.accept().await {
                Ok((stream, _addr)) => {
                    let port = port;
                    let shutdown_rx = shutdown_rx.clone();
                    tokio::spawn(async move {
                        let conn = http1::Builder::new()
                            .serve_connection(
                                stream,
                                service_fn(move |req| {
                                    handle_request(req, port, shutdown_rx.clone())
                                }),
                            )
                            .with_upgrades();
                        let _ = conn.await;
                    });
                }
                Err(e) => {
                    eprintln!("accept error: {e}");
                }
            }
        }
    });
}
