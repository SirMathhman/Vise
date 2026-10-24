use axum::http::StatusCode;
use axum::response::IntoResponse;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("upstream error: {0}")]
    Upstream(String),
    #[error("timeout contacting upstream")]
    Timeout,
    #[error("bad request: {0}")]
    BadRequest(String),
    #[error("internal error: {0}")]
    Internal(String),
}

impl IntoResponse for AppError {
    fn into_response(self) -> axum::http::Response<axum::body::Body> {
        let (status, code, message) = match &self {
            AppError::Upstream(msg) => (StatusCode::BAD_GATEWAY, "upstream", msg.as_str()),
            AppError::Timeout => (StatusCode::GATEWAY_TIMEOUT, "timeout", "timeout contacting upstream"),
            AppError::BadRequest(msg) => (StatusCode::BAD_REQUEST, "bad_request", msg.as_str()),
            AppError::Internal(msg) => (StatusCode::INTERNAL_SERVER_ERROR, "internal", msg.as_str()),
        };
        axum::http::Response::builder()
            .status(status)
            .header("content-type", "application/json")
            .body(axum::body::Body::from(serde_json::json!({
                "code": code,
                "message": message,
            })
            .to_string()))
            .unwrap()
    }
}
