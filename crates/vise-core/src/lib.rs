//! The backend of Vise: the conversation, the provider, the tools, the notes and profiles, and the saved sessions.
//! It never reads or writes a terminal. A frontend drives an `engine::Engine` with `engine::Request`s and receives
//! `frontend::UiEvent`s through the `frontend::Frontend` it passes in.

pub mod after_turn;
pub mod before_turn;
pub mod command;
pub mod default_model;
pub mod engine;
pub mod environment;
pub mod error;
pub mod file_commands;
pub mod frontend;
pub mod notes;
pub mod parts;
pub mod profile;
pub mod provider;
pub mod saved_sessions;
pub mod session;
pub mod shutdown;
pub mod slash;
pub mod startup;
pub mod stop;
pub mod subagent;
pub mod tools;
pub mod turn;
