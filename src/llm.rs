//! Client for the local llama.cpp OpenAI-compatible server.

use reqwest::Client;
use serde::Deserialize;
use tokio_stream::StreamExt as _;
use tokio::sync::mpsc;

const BASE_URL: &str = "http://localhost:8080";

#[derive(Deserialize)]
struct ChatChunk {
    #[serde(default)]
    choices: Vec<Choice>,
}

#[derive(Deserialize)]
struct Choice {
    #[serde(default)]
    delta: Delta,
}

#[derive(Deserialize, Default)]
struct Delta {
    #[serde(default)]
    content: Option<String>,
}

/// Sends `content` to `/v1/chat/completions` (streaming) and forwards each
/// generated token over `tx`. Returns an error if the request fails before
/// any token is produced.
pub async fn send_streaming(
    client: &Client,
    content: String,
    tx: mpsc::Sender<String>,
) -> Result<(), String> {
    let body = serde_json::json!({
        "messages": [
            { "role": "user", "content": content }
        ],
        "stream": true
    });

    let resp = client
        .post(format!("{BASE_URL}/v1/chat/completions"))
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("server returned {status}: {text}"));
    }

    let mut stream = resp.bytes_stream();
    let mut buf = Vec::new();

    while let Some(Ok(chunk)) = stream.next().await {
        buf.extend_from_slice(&chunk);
        drain_lines(&mut buf, &tx).await;
    }
    drain_lines(&mut buf, &tx).await;

    Ok(())
}

/// Pulls complete `\n`-terminated lines out of `buf`, forwarding each
/// `data:` payload's token to `tx`. Stops and clears `buf` at `[DONE]`.
async fn drain_lines(buf: &mut Vec<u8>, tx: &mpsc::Sender<String>) {
    loop {
        match memchr::memchr(b'\n', buf) {
            Some(pos) => {
                let line: Vec<u8> = buf.drain(..=pos).collect();
                let line = String::from_utf8_lossy(&line);
                let trimmed = line.trim();
                if let Some(payload) = trimmed.strip_prefix("data:") {
                    let payload = payload.trim();
                    if payload == "[DONE]" {
                        buf.clear();
                        return;
                    }
                    if let Ok(chunk) = serde_json::from_str::<ChatChunk>(payload) {
                        if let Some(token) = chunk.choices.first().and_then(|c| c.delta.content.clone())
                        {
                            let _ = tx.send(token);
                        }
                    }
                }
            }
            None => return,
        }
    }
}
