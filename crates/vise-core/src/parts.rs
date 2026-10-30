//! The pieces an `Engine` borrows, built together and owned in one place. A frontend creates a `Parts` (on the thread that will
//! run the engine, since the provider and the tool runner are not `Sync`) and asks it for an `Engine`.

use crate::engine::Engine;
use crate::environment::{self, Environment};
use crate::provider::llama_cpp::LlamaCpp;
use crate::provider::types::Provider;
use crate::saved_sessions;
use crate::session::Conversation;
use crate::stop::Stop;
use crate::tools::runner::WorkspaceTools;
use crate::tools::types::ToolRunner;
use std::path::PathBuf;

pub struct Parts {
    pub provider: Box<dyn Provider>,
    pub tools: Box<dyn ToolRunner>,
    pub conversation: Conversation,
    /// The folder the saved sessions are kept in.
    pub sessions: PathBuf,
    /// The working directory the run started in, for the command files.
    pub cwd: PathBuf,
}

impl Parts {
    /// The real parts for a run in `env`'s directory: the llama.cpp provider, the workspace tools, and a conversation that
    /// autosaves. Fails when the standing instructions in `AGENTS.md` cannot be read.
    pub fn for_directory(api_key: String, env: &Environment, stop: Stop) -> Result<Self, String> {
        environment::instructions(&env.cwd).map_err(|err| err.to_string())?;
        let mut conversation = Conversation::new(env);
        conversation.enable_autosave();
        Ok(Self {
            provider: Box::new(LlamaCpp::new(api_key, stop)),
            tools: Box::new(WorkspaceTools::new(env.cwd.clone())),
            conversation,
            sessions: PathBuf::from(saved_sessions::FOLDER),
            cwd: env.cwd.clone(),
        })
    }

    /// An engine over these parts. It borrows them, so they outlive it. `stop` is the switch a frontend flips to stop the
    /// work that is running; the provider holds a clone of the same one.
    pub fn engine(&mut self, stop: Stop) -> Engine<'_> {
        Engine::new(&*self.provider, &*self.tools, &mut self.conversation, &self.sessions, stop)
    }
}
