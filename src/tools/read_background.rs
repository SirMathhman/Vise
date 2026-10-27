use super::jobs::Jobs;
use super::types::{Arguments, Invocation, Param, ParamType, ToolError, ToolSpec};

pub const SPEC: ToolSpec = ToolSpec {
    name: "read_background",
    description: "Return the output a background task printed since the last read, and whether it is still running. A task that has finished is removed after its final output is returned.",
    params: &[Param {
        name: "id",
        kind: ParamType::Integer { min: Some(1), max: None },
        description: "The background task's id.",
    }],
    bind,
};

fn bind(args: &Arguments) -> Result<Invocation, ToolError> {
    Ok(Invocation::ReadBackground { id: task_id(args)? })
}

/// Reads the id argument shared by the background-task tools.
pub(super) fn task_id(args: &Arguments) -> Result<usize, ToolError> {
    usize::try_from(args.integer("id")?).map_err(|_| ToolError::InvalidArguments("'id' is out of range".into()))
}

pub fn run(id: usize, jobs: &mut Jobs) -> Result<String, ToolError> {
    jobs.read(id)
}
