//! Subagents: a task run in a fresh conversation under a profile. The subagent has the profile's instructions, tools,
//! notes and hooks, and its writes are approved in the parent turn. Only its final reply goes back to the parent.

use crate::after_turn;
use crate::environment;
use crate::error::ProviderError;
use crate::profile::{self, Profile};
use crate::provider::types::{Event, Provider};
use crate::turn;
use crate::session::{Conversation, HookLines};
use crate::tools::specs;
use crate::tools::types::{ToolError, ToolRunner};
use std::io;

/// What a subagent's turns need from its parent: the session's before-turn and after-turn lines, the approval function
/// for its writes, and where its tool lines are reported.
pub struct Parent<'a> {
    pub hooks: Hooks<'a>,
    pub approve: &'a mut dyn FnMut(&str) -> bool,
    pub on_event: &'a mut dyn FnMut(Event),
}

/// The main session's before-turn and after-turn lines, which run around each of a subagent's turns.
pub type Hooks<'a> = (&'a [String], &'a [String]);

/// Runs `task` as a subagent under the profile `profile_name`, and returns its final reply. `parent` holds the
/// before-turn and after-turn lines of the main session, which run around each of the subagent's turns, the approval
/// function for its writes, and the display its tool lines go to. The parent's enabled tools and notes are restored
/// afterwards.
pub fn run(
    profile_name: &str,
    task: &str,
    provider: &dyn Provider,
    tools: &dyn ToolRunner,
    parent: Parent<'_>,
) -> Result<String, ToolError> {
    let mut loaded = profile::load(profile_name).map_err(ToolError::Failed)?;
    // A profile the model wrote has not been seen by the user as a profile, so its hook lines do not run.
    if tools.profile_written(profile_name) {
        loaded.hooks = HookLines::default();
    }
    let saved_enabled = tools.enabled();
    let saved_notes = tools.allowed_notes();
    let result = session(profile_name, loaded, task, provider, tools, parent);
    for spec in specs() {
        // Every name here is a known tool, so set_enabled cannot fail.
        let _ = tools.set_enabled(spec.name, saved_enabled.contains(&spec.name));
    }
    tools.set_allowed_notes(saved_notes);
    result
}

/// The subagent's turns: its profile sets the tools and notes, its startup hook runs first, and each turn runs as the
/// main session's turns do, with follow-ups for a failing after-turn command. Only tool lines are passed on: its answer
/// text is not streamed, so the parent's reply is the only answer shown.
fn session(
    profile_name: &str,
    loaded: Profile,
    task: &str,
    provider: &dyn Provider,
    tools: &dyn ToolRunner,
    parent: Parent<'_>,
) -> Result<String, ToolError> {
    turn::apply_whitelist(tools, loaded.tools.as_deref())?;
    // A subagent cannot start another one.
    tools.set_enabled("run_subagent", false)?;
    tools.set_allowed_notes(loaded.notes);
    let environment = environment::gather().map_err(|err| ToolError::Failed(format!("cannot read the directory: {err}")))?;
    let mut conversation = Conversation::new(&environment);
    conversation.set_before_turn(parent.hooks.0.to_vec());
    conversation.set_after_turn(parent.hooks.1.to_vec());
    let marked = profile::marked(profile_name, &loaded.instructions);
    let (mut out, mut err) = (Vec::new(), Vec::new());
    turn::select_hooks(loaded.hooks, &mut conversation, tools, &mut out, &mut err).map_err(io_error)?;

    let mut no_subagent = |_: &str, _: &str, _: &mut dyn FnMut(&str) -> bool| -> Result<String, ToolError> {
        Err(ToolError::Failed("a subagent cannot start a subagent".into()))
    };
    let mut pending = Some(task.to_string());
    let mut follow_ups = 0;
    let mut reply = String::new();
    while let Some(text) = pending.take() {
        let message = turn::prepare_message(text, Some(&marked), &conversation, tools, &mut out, &mut err)
            .map_err(io_error)?;
        let (turn, _) = turn::run_turn(
            provider,
            &mut conversation,
            message,
            tools,
            parent.approve,
            &mut no_subagent,
            &mut |event| {
                // A subagent's answer text is discarded, so only its tool lines are worth showing.
                if matches!(event, Event::Tool { .. } | Event::ToolFailed(_)) {
                    (parent.on_event)(event);
                }
            },
        )
        .map_err(|err| match err {
            // A stopped subagent returns to its parent at once, with no after-turn lines and no follow-ups.
            ProviderError::Interrupted { .. } => ToolError::Failed(YIELD.into()),
            err => ToolError::Failed(err.to_string()),
        })?;
        reply = turn.reply().to_string();
        conversation.commit(turn);
        let after = turn::hook_lines(conversation.after_turn(), &conversation.profile_hooks().after_turn);
        pending = after_turn::run(&after, tools, &mut out, &mut err).map_err(io_error)?;
        if pending.is_some() {
            if follow_ups == after_turn::FOLLOW_UPS {
                pending = None;
            } else {
                follow_ups += 1;
            }
        }
    }
    Ok(reply)
}

/// What a stopped subagent reports to its parent. The parent's turn is stopped too, so the text only has to be true.
const YIELD: &str = "the subagent was interrupted";

fn io_error(err: io::Error) -> ToolError {
    ToolError::Failed(format!("cannot write the subagent's output: {err}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ProviderError;
    use crate::provider::types::SubagentRunner;
    use crate::session::{Message, Turn};
    use crate::tools::runner::WorkspaceTools;
    use std::cell::RefCell;
    use std::fs;

    /// A provider that must never be asked for a reply, since the profile is refused first.
    struct Unused;

    impl Provider for Unused {
        fn complete(
            &self,
            _history: &[Message],
            _input: String,
            _runner: &dyn ToolRunner,
            _approve: &mut dyn FnMut(&str) -> bool,
            _subagent: &mut SubagentRunner,
        ) -> Result<Turn, ProviderError> {
            Err(ProviderError::EmptyResponse)
        }

        fn context_size(&self) -> Result<u64, ProviderError> {
            Ok(0)
        }

        fn summarize(&self, _history: &[Message]) -> Result<(String, crate::session::RequestRecord), ProviderError> {
            Err(ProviderError::EmptyResponse)
        }
    }

    #[test]
    fn unknown_profile_is_refused_before_the_model_is_called() {
        let tools = WorkspaceTools::new(std::env::temp_dir());
        let result = run(
            "no-such-profile-xyz",
            "task",
            &Unused,
            &tools,
            Parent { hooks: (&[], &[]), approve: &mut |_: &str| true, on_event: &mut |_| {} },
        );
        assert!(result.is_err_and(|err| err.to_string().contains("cannot read profile")));
    }

    /// A provider that records what each request carries, and fails when `fail` is set.
    struct Recorder {
        fail: bool,
        inputs: RefCell<Vec<String>>,
        enabled: RefCell<Vec<&'static str>>,
    }

    impl Recorder {
        fn new(fail: bool) -> Self {
            Self { fail, inputs: RefCell::new(Vec::new()), enabled: RefCell::new(Vec::new()) }
        }
    }

    impl Provider for Recorder {
        fn complete(
            &self,
            _history: &[Message],
            input: String,
            runner: &dyn ToolRunner,
            _approve: &mut dyn FnMut(&str) -> bool,
            _subagent: &mut SubagentRunner,
        ) -> Result<Turn, ProviderError> {
            *self.enabled.borrow_mut() = runner.enabled();
            self.inputs.borrow_mut().push(input.clone());
            if self.fail {
                return Err(ProviderError::EmptyResponse);
            }
            Turn::new(vec![
                Message::User(input),
                Message::Assistant { content: "done".into(), tool_calls: Vec::new() },
            ])
            .map_err(ProviderError::Session)
        }

        fn context_size(&self) -> Result<u64, ProviderError> {
            Ok(0)
        }

        fn summarize(&self, _history: &[Message]) -> Result<(String, crate::session::RequestRecord), ProviderError> {
            Err(ProviderError::EmptyResponse)
        }
    }

    /// Runs `test` with a profile file of the given name and text in the profiles folder, removing the file after.
    fn with_profile<T>(name: &str, text: &str, test: impl FnOnce() -> T) -> T {
        let folder = std::path::Path::new("profiles");
        fs::create_dir_all(folder).unwrap();
        let file = folder.join(format!("{name}.txt"));
        fs::write(&file, text).unwrap();
        let result = test();
        fs::remove_file(&file).unwrap();
        result
    }

    #[test]
    fn failing_subagent_restores_the_parent_tools_and_notes() {
        with_profile("vise-subagent-fail", "tools: read_file
be brief", || {
            let tools = WorkspaceTools::new(std::env::temp_dir());
            let result = run(
                "vise-subagent-fail",
                "task",
                &Recorder::new(true),
                &tools,
                Parent { hooks: (&[], &[]), approve: &mut |_: &str| true, on_event: &mut |_| {} },
            );
            assert!(result.is_err());
            assert!(tools.enabled().contains(&"list_directory"));
            assert!(tools.enabled().contains(&"run_subagent"));
        });
    }

    #[test]
    fn subagent_runs_its_hooks_and_cannot_start_another_subagent() {
        with_profile("vise-subagent-hooks", "hook before-turn: Write-Output profile-hook
be brief", || {
            let tools = WorkspaceTools::new(std::env::temp_dir());
            let provider = Recorder::new(false);
            let global = vec!["Write-Output global-hook".to_string()];
            let result = run(
                "vise-subagent-hooks",
                "task",
                &provider,
                &tools,
                Parent { hooks: (&global, &[]), approve: &mut |_: &str| true, on_event: &mut |_| {} },
            );
            assert_eq!(result.unwrap(), "done");
            let input = provider.inputs.borrow()[0].clone();
            let global_at = input.find("Before-turn command: Write-Output global-hook").expect("the global hook ran");
            let profile_at = input.find("Before-turn command: Write-Output profile-hook").expect("the profile hook ran");
            assert!(global_at < profile_at);
            assert!(!provider.enabled.borrow().contains(&"run_subagent"));
            assert!(tools.enabled().contains(&"run_subagent"));
        });
    }
}

