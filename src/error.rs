use std::fmt;

#[derive(Debug)]
pub enum EvalError {
    Request(reqwest::Error),
    Response { status: u16, body: String },
    BadJson,
}

impl fmt::Display for EvalError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            EvalError::Request(e) => write!(f, "request failed: {e}"),
            EvalError::Response { status, body } => {
                write!(f, "server returned {status}: {body}")
            }
            EvalError::BadJson => write!(f, "server returned invalid JSON"),
        }
    }
}
