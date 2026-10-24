//! The Vise library: the chat turn loop, the tools, and the web server. The REPL (`vise-repl`) and the web UI
//! (`vise-web`) are both built from it.

pub mod agent;
pub mod approval;
pub mod chunk;
pub mod commands;
pub mod compaction;
pub mod config;
pub mod edits;
pub mod file_tree;
pub mod grammar;
pub mod notes;
pub mod saved_sessions;
pub mod session;
pub mod strata;
pub mod subagent;
pub mod titles;
pub mod tools;
pub mod turn;
pub mod web;
pub mod workflow_runner;
pub mod workflows;
pub mod workspace;
