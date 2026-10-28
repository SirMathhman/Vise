use super::types::{Arguments, Invocation, Param, ParamType, ToolError, ToolSpec};

pub const SPEC: ToolSpec = ToolSpec {
    name: "run_subagent",
    description: "Start a subagent to do a task in a fresh conversation, and get its final reply. The profile must exist, and it sets the subagent's instructions, tools, notes and hooks. A subagent cannot start another subagent.",
    params: &[
        Param {
            name: "profile",
            kind: ParamType::String,
            description: "The name of the profile the subagent runs under, as listed by /profile.",
        },
        Param {
            name: "task",
            kind: ParamType::String,
            description: "What the subagent should do. Its reply is returned to you.",
        },
    ],
    bind,
};

fn bind(args: &Arguments) -> Result<Invocation, ToolError> {
    Ok(Invocation::RunSubagent {
        profile: args.text("profile")?.to_string(),
        task: args.text("task")?.to_string(),
    })
}
