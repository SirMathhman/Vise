pub mod llama_cpp;

use crate::session::{Message, Turn};

pub trait Provider {
    fn complete(&self, history: &[Message], input: String) -> Result<Turn, Box<dyn std::error::Error>>;
}
