//! Runs a workflow's steps in order within one reply. An instructions step is a turn of its own: its text joins the
//! conversation, and the model's answer follows it. A profile step applies that profile, as `/profile` does. A tool step
//! runs its tool, with fixed arguments or with arguments the model supplies. When the steps are done, the profile that
//! was active before the workflow is applied again, if the server knows which profile that was.

use std::collections::BTreeSet;
use std::path::Path;
use std::sync::atomic::AtomicBool;

use serde_json::{Map, Value, json};

use crate::agent;
use crate::turn::{TurnError, turn_error};
use crate::commands;
use crate::grammar;
use crate::notes;
use crate::strata::{self, Chunk, Config, Constraint, Message, Role, ToolCall};
use crate::tools::{self, Switches};
use crate::workflows::{self, Call, Step, Workflow};

/// What a run starts from: the conversation before the workflow, the switch notes the model has been given, and the
/// profile that is active when the workflow starts.
pub struct Start<'a> {
    pub history: &'a [Message],
    pub told: BTreeSet<String>,
    pub profile: Option<String>,
}

/// How a run ended. `result` holds the messages the conversation keeps, when every step ran. `told` holds the switch
/// notes the model now has, and `profile` the profile active when the run ended, whether or not every step ran.
pub struct Outcome {
    pub result: Result<Vec<Message>, TurnError>,
    pub told: BTreeSet<String>,
    pub profile: Option<String>,
}

/// What every step needs from the chat it runs in.
pub struct Env<'a> {
    pub config: &'a Config,
    pub switches: &'a Switches,
    pub cancel: &'a AtomicBool,
    pub roots: notes::Roots<'a>,
}

/// The state of a run as it goes: the messages the model sees, the messages to keep, and the calls that have run.
struct Run {
    messages: Vec<Message>,
    added: Vec<Message>,
    told: BTreeSet<String>,
    profile: Option<String>,
    ran: Vec<String>,
}

impl Run {
    /// Adds a message to what the model sees, and to what the conversation keeps.
    fn keep(&mut self, role: Role, content: String) {
        let message = Message { role, content };
        self.messages.push(message.clone());
        self.added.push(message);
    }

    fn fail(&self, reason: String) -> TurnError {
        TurnError::Step { ran: self.ran.clone(), reason }
    }
}

/// Runs `workflow` with `argument`. `on_chunk` gets the start of each step and the output of its turns. An error stops
/// the run, and the calls that ran before it, in any step, are listed in the error.
pub fn run(workflow: &Workflow, argument: &str, start: Start<'_>, env: &Env<'_>, on_chunk: &mut dyn FnMut(Chunk)) -> Outcome {
    let initial = start.profile.clone();
    let mut run = Run {
        messages: start.history.to_vec(),
        added: Vec::new(),
        told: start.told,
        profile: start.profile,
        ran: Vec::new(),
    };
    let result = execute(&mut run, workflow, argument, env, initial, on_chunk);
    Outcome { result: result.map(|()| run.added), told: run.told, profile: run.profile }
}

/// Runs the steps, then applies the profile from before the run. A step that fails stops here, so the profile is not
/// applied again.
fn execute(
    run: &mut Run,
    workflow: &Workflow,
    argument: &str,
    env: &Env<'_>,
    initial: Option<String>,
    on_chunk: &mut dyn FnMut(Chunk),
) -> Result<(), TurnError> {
    for step in &workflow.steps {
        match step {
            Step::Instructions(text) => instructions(run, text, argument, env, on_chunk)?,
            Step::Profile(reference) => {
                on_chunk(Chunk::Step(&format!("Profile {reference}")));
                apply_profile(run, reference, env)?;
            }
            Step::Tool { name, arguments } => tool(run, name, arguments.as_ref(), argument, env, on_chunk)?,
        }
    }
    if let Some(reference) = initial {
        apply_profile(run, &reference, env)?;
    }
    Ok(())
}

/// An instructions step: its text, with the argument filled in, joins the conversation, and the model answers it in a
/// turn of its own, with the tools as the switches have them.
fn instructions(run: &mut Run, text: &str, argument: &str, env: &Env<'_>, on_chunk: &mut dyn FnMut(Chunk)) -> Result<(), TurnError> {
    let text = workflows::fill(text, argument);
    on_chunk(Chunk::Step(&text));
    let mut content = if strata::is_first_turn(&run.messages) { notes::with_index(&text, env.roots) } else { text };
    // The model is told about switch changes made since it was last told, as a normal message is.
    let now = env.switches.snapshot();
    content = tools::note_changes(&content, &run.told, &now);
    run.told = now;
    run.keep(Role::User, content);

    let outcome = agent::run_turn(&run.messages, env.config, env.switches, env.cancel, &mut |chunk| {
        if let Chunk::Tool(call) = chunk {
            run.ran.push(call.to_owned());
        }
        on_chunk(chunk);
    });
    let answer = outcome.map_err(|err| with_ran(err, &run.ran))?;
    run.keep(Role::Assistant, answer);
    Ok(())
}

/// Applies a profile as `/profile` does: its tools are switched, and its instructions join the conversation.
fn apply_profile(run: &mut Run, reference: &str, env: &Env<'_>) -> Result<(), TurnError> {
    let choice = match commands::profile(&format!("/profile {reference}"), env.switches, env.roots) {
        Some(Ok(choice)) => choice,
        Some(Err(err)) => return Err(run.fail(err)),
        None => return Err(run.fail(format!("{reference} is not a profile"))),
    };
    if !choice.instructions.is_empty() {
        run.keep(Role::Profile, choice.instructions);
    }
    run.profile = Some(reference.to_owned());
    Ok(())
}

/// A tool step: the tool runs. Each argument is fixed by the step or left to the model. When every argument is fixed the
/// call is made as it is; otherwise the model makes the call, and each fixed argument is set to its value. Its result is
/// shown under the call, but not kept in the conversation, as a tool call's result is not kept in a normal reply.
fn tool(run: &mut Run, name: &str, arguments: Option<&Value>, argument: &str, env: &Env<'_>, on_chunk: &mut dyn FnMut(Chunk)) -> Result<(), TurnError> {
    on_chunk(Chunk::Step(&format!("Tool {name}")));
    if env.switches.snapshot().contains(name) {
        return Err(run.fail(format!("tool {name} is switched off, so its workflow step cannot run")));
    }
    let fixed = match arguments.map(|value| workflows::fill_arguments(value, argument)) {
        Some(Value::Object(map)) => map,
        _ => Map::new(),
    };
    let calls = match workflows::call_of(name, fixed) {
        Call::Direct(fixed) => vec![ToolCall { name: name.to_owned(), arguments: Value::Object(fixed).to_string(), ..ToolCall::default() }],
        Call::Forced { fixed, model } => {
            let mut calls = forced_calls(run, name, &model, env)?;
            for call in &mut calls {
                call.arguments = with_fixed(&call.arguments, &fixed).map_err(|reason| run.fail(reason))?;
            }
            calls
        }
    };
    let root = env.config.working_dir.as_deref().map(Path::new);
    for call in calls {
        let line = format!("{} {}", call.name, call.arguments);
        let result = tools::run(&call.name, &call.arguments, root);
        on_chunk(Chunk::Tool(&format!("{line}\n{result}")));
        run.ran.push(line);
    }
    Ok(())
}

/// The model's arguments for a call, with each fixed argument set to its fixed value, so the model cannot change one.
fn with_fixed(arguments: &str, fixed: &Map<String, Value>) -> Result<String, String> {
    let Ok(Value::Object(mut call)) = serde_json::from_str::<Value>(arguments) else {
        return Err("the model's arguments for this workflow step were not an object".to_owned());
    };
    call.extend(fixed.clone());
    Ok(Value::Object(call).to_string())
}

/// The calls the model makes for a tool step. The grammar allows only calls to `name`, and one reply must make one.
fn forced_calls(run: &mut Run, name: &str, model: &[String], env: &Env<'_>) -> Result<Vec<ToolCall>, TurnError> {
    let mut items = strata::message_items(&run.messages, env.config);
    items.push(json!({ "role": "user", "content": format!("Call the {name} tool now. Supply these arguments: {}.", model.join(", ")) }));
    let grammar = grammar::forced_call(name);
    let constraint = Constraint { grammar: &grammar, lazy: false };
    let reply = strata::stream_reply(&items, env.config, Some(constraint), env.cancel, &mut |_| {})
        .map_err(|err| turn_error(err, &run.ran))?;
    if reply.tool_calls.is_empty() {
        return Err(run.fail(format!("the model did not call {name} for this workflow step")));
    }
    Ok(reply.tool_calls)
}

/// The same failure, listing the calls that ran in the whole workflow rather than in the step alone.
fn with_ran(err: TurnError, ran: &[String]) -> TurnError {
    let ran = ran.to_vec();
    match err {
        TurnError::Stopped { .. } => TurnError::Stopped { ran },
        TurnError::Failed { cause, .. } => TurnError::Failed { ran, cause },
        TurnError::Step { reason, .. } => TurnError::Step { ran, reason },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fixed_argument_overrides_the_models_value_and_the_rest_are_kept() {
        let fixed = Map::from_iter([("scope".to_owned(), json!("global"))]);
        let merged = with_fixed(r#"{"scope":"local","category":"c"}"#, &fixed).unwrap();
        let refused = with_fixed("not json", &fixed);

        assert_eq!(serde_json::from_str::<Value>(&merged).unwrap(), json!({ "scope": "global", "category": "c" }));
        assert!(refused.is_err());
    }
}
