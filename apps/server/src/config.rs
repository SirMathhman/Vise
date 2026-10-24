use std::env;

#[derive(Debug, Clone)]
pub struct Config {
    pub llama_base: String,
    pub llama_api_key: String,
    pub llama_model: String,
    pub server_port: u16,
}

impl Config {
    pub fn from_env() -> Result<Self, ConfigError> {
        Ok(Self {
            llama_base: env::var("LLAMA_BASE").unwrap_or_else(|_| "http://localhost:9931".into()),
            llama_api_key: env::var("LLAMA_API_KEY")
                .map_err(|_| ConfigError::Missing("LLAMA_API_KEY"))?,
            llama_model: env::var("LLAMA_MODEL").unwrap_or_else(|_| {
                "ayozhee/Qwen3.8-27B-Abliterated-GSQ-Orca-GGUF:MTP".into()
            }),
            server_port: env::var("SERVER_PORT")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(8080),
        })
    }
}

#[derive(Debug)]
pub enum ConfigError {
    Missing(&'static str),
}

impl std::fmt::Display for ConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConfigError::Missing(var) => write!(f, "required environment variable {var} is not set"),
        }
    }
}

impl std::error::Error for ConfigError {}
