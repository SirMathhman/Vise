//! Subagents: a `run_subagent` call runs a fresh conversation that follows a profile and is sent one task. The turn runner
//! is passed in, so this module does not depend on `agent`, which calls it.

use std::collections::BTreeSet;
use std::path::Path;
use std::sync::atomic::AtomicBool;

use serde_json::Value;

use crate::notes;
use crate::strata::{Chunk, Config, Message, Role};
use crate::tools::{self, Switches};
use crate::turn::TurnError;

/// A turn runner, as `agent::run_turn`. A subagent runs its turns through one, so this module does not call `agent`.
pub type TurnRunner = fn(&[Message], &Config, &Switches, &AtomicBool, &mut dyn FnMut(Chunk)) -> Result<String, TurnError>;

/// Runs a `run_subagent` call: a fresh conversation that follows the profile and is sent the task. Its steps go to
/// `on_chunk` between the start and end chunks. Bad arguments and an unreadable profile come back as answer text for
/// the model, so only a stop or a failed run is an error.
pub fn run_subagent(
    arguments: &str,
    config: &Config,
    switches: &Switches,
    cancel: &AtomicBool,
    on_chunk: &mut dyn FnMut(Chunk),
    turn: TurnRunner,
) -> Result<String, TurnError> {
    let args: Value = match serde_json::from_str(arguments) {
        Ok(args) => args,
        Err(err) => return Ok(format!("error: invalid arguments: {err}")),
    };
    let (Some(reference), Some(task)) = (args["profile"].as_str(), args["task"].as_str()) else {
        return Ok("error: run_subagent needs a profile and a task, both strings".to_owned());
    };
    let home = std::env::home_dir();
    let roots = notes::Roots { working: config.working_dir.as_deref().map(Path::new), home: home.as_deref() };
    let profile = match notes::read_profile(reference, roots) {
        Ok(profile) => profile,
        Err(err) => return Ok(format!("error: {err}")),
    };

    let child = subagent_switches(profile.tools.as_deref(), &switches.snapshot()).sharing_approvals(switches);
    let mut messages = Vec::new();
    if !profile.instructions.is_empty() {
        let content = format!(
            "[Profile {} is active. Follow these instructions from now on.]\n\n{}",
            profile.label, profile.instructions
        );
        messages.push(Message { role: Role::Profile, content });
    }
    messages.push(Message { role: Role::User, content: task.to_owned() });

    on_chunk(Chunk::SubagentStart { profile: profile.label.as_str(), task });
    let outcome = turn(&messages, config, &child, cancel, &mut |step: Chunk<'_>| on_chunk(Chunk::Nested(&step)));
    on_chunk(Chunk::SubagentEnd { failed: outcome.is_err() });
    outcome
}

/// The switches a subagent runs with. A profile with a tool list gets exactly those tools; otherwise it keeps the
/// parent's switches. `run_subagent` is always off, so a subagent cannot start another one.
pub(crate) fn subagent_switches(profile_tools: Option<&[String]>, parent_disabled: &BTreeSet<String>) -> Switches {
    let child = Switches::default();
    for name in tools::NAMES {
        let enabled = match profile_tools {
            Some(listed) => listed.iter().any(|tool| tool.as_str() == name),
            None => !parent_disabled.contains(name),
        };
        child.set(name, enabled);
    }
    child.set(tools::RUN_SUBAGENT, false);
    child
}
