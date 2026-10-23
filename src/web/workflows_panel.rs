//! The Workflows panel's requests: the workflows in the working directory, and reading, saving and deleting one. A save
//! checks the steps the way a run reads them, and checks each profile step against the profiles that exist.

use std::path::Path;

use serde_json::{Value, json};

use super::{Response, json_response};
use crate::notes;
use crate::strata::Config;
use crate::tools;
use crate::workflows::{self, Step, Workflow};

/// Runs one workflow request from the Workflows panel. Failures are reported as a 400 with the reason.
pub(super) fn workflows_response(body: &[u8], config: &Config) -> Response {
    let data: Value = match serde_json::from_slice(body) {
        Ok(data) => data,
        Err(err) => return json_response(400, json!({ "error": format!("invalid JSON: {err}") })),
    };
    let working = config.working_dir.as_deref().map(Path::new);
    let home = std::env::home_dir();
    let roots = notes::Roots { working, home: home.as_deref() };
    let name = data["name"].as_str().unwrap_or_default();
    let result = match data["action"].as_str() {
        // The tool names are listed too, so the editor can offer them without asking the tabs' switches.
        Some("list") => workflows::list(working).map(|names| json!({ "workflows": names, "tools": tools::NAMES })),
        Some("load") => workflows::load(working, name)
            .and_then(|found| found.ok_or_else(|| format!("there is no workflow named {name}")))
            .map(|workflow| workflows::to_value(&workflow)),
        Some("save") => save(working, roots, name, &data["steps"]).map(|()| json!({ "message": format!("Saved workflow {name}.") })),
        Some("delete") => workflows::delete(working, name).map(|()| json!({ "message": format!("Deleted workflow {name}.") })),
        _ => Err("action must be list, load, save, or delete".to_owned()),
    };
    match result {
        Ok(value) => json_response(200, value),
        Err(error) => json_response(400, json!({ "error": error })),
    }
}

/// Checks the steps and their profiles, then writes the workflow. Nothing is written if a step is wrong.
fn save(working: Option<&Path>, roots: notes::Roots, name: &str, steps: &Value) -> Result<(), String> {
    workflows::check_name(name)?;
    let items = steps.as_array().ok_or("steps must be a list")?;
    let workflow: Workflow = workflows::from_steps(items, name)?;
    for step in &workflow.steps {
        if let Step::Profile(reference) = step {
            if reference != "default" {
                notes::read_profile(reference, roots).map_err(|err| format!("profile {reference} cannot be used: {err}"))?;
            }
        }
    }
    workflows::save(working, name, &workflow)
}
