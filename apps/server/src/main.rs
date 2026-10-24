use axum::routing::{get, post};
use axum::Router;
use tokio::net::TcpListener;

mod agent;
mod config;
mod error;
mod llama;
mod routes;
mod tools;

use config::Config;
use routes::AppState;

#[tokio::main]
async fn main() {
    dotenv::dotenv().ok();
    let config = Config::from_env().expect("failed to load config");

    let cwd = std::env::current_dir()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|_| "unknown".to_string());

    let state = AppState {
        client: reqwest::Client::new(),
        config,
        cwd,
    };

    let port = state.config.server_port;

    let app = Router::new()
        .route("/health", get(routes::health))
        .route("/api/chat", post(routes::chat))
        .with_state(state);

    let addr = format!("127.0.0.1:{port}");
    let listener = TcpListener::bind(&addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}