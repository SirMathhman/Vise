use super::jobs::Jobs;
use super::read_background::{task_id, TASK_ID_PARAM};
use super::types::{Arguments, Invocation, ToolError, ToolSpec};

pub const SPEC: ToolSpec = ToolSpec {
    name: "kill_background",
    description: "Stop a background task and every process it started. The user approves each stop. The result includes any output the task printed since the last read.",
    params: &[TASK_ID_PARAM],
    bind,
};

fn bind(args: &Arguments) -> Result<Invocation, ToolError> {
    Ok(Invocation::KillBackground { id: task_id(args)? })
}

pub fn run(id: usize, jobs: &mut Jobs) -> Result<String, ToolError> {
    jobs.kill(id)
}
