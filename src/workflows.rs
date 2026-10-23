//! Workflows: named sequences of steps, kept as JSON in `.vise/workflows/<name>.json` in the working directory. A
//! workflow runs when the user sends `/<name> <argument>`. Each step is instructions, a profile, or a tool call. A tool
//! call has fixed arguments, or the model supplies them. Running them is up to `workflow_runner`.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde_json::{Map, Number, Value, json};

use crate::tools;

const WORKFLOWS_DIR: &str = ".vise/workflows";
/// The chat's own commands. A workflow with one of these names could never run, so it is not read.
const COMMANDS: [&str; 5] = ["tools", "enable", "disable", "notes", "profile"];
/// The placeholder that the argument replaces in instructions and in fixed tool arguments.
const ARGUMENT: &str = "{argument}";

pub struct Workflow {
    pub steps: Vec<Step>,
}

pub enum Step {
    Instructions(String),
    /// A profile reference, as `/profile` takes it: `default`, or `<scope>/<category>/<name>`.
    Profile(String),
    /// A tool to run. `None` means the model supplies the arguments.
    Tool { name: String, arguments: Option<Value> },
}

/// The workflow a chat line asks for: its name, and the argument after the name. `None` if the line is not `/<name>`.
pub fn command(line: &str) -> Option<(&str, &str)> {
    let rest = line.strip_prefix('/')?;
    let (name, argument) = rest.split_once(char::is_whitespace).unwrap_or((rest, ""));
    valid_name(name).then_some((name, argument.trim()))
}

/// Reads workflow `name`. `Ok(None)` when there is no such workflow, so the line is sent to the model as text.
pub fn load(working: Option<&Path>, name: &str) -> Result<Option<Workflow>, String> {
    let Some(root) = working else {
        return Ok(None);
    };
    if !valid_name(name) || COMMANDS.contains(&name) {
        return Ok(None);
    }
    let path = root.join(WORKFLOWS_DIR).join(format!("{name}.json"));
    match fs::read_to_string(&path) {
        Ok(text) => parse(&text, name).map(Some),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(format!("could not read workflow {name}: {err}")),
    }
}

fn parse(text: &str, name: &str) -> Result<Workflow, String> {
    let data: Value = serde_json::from_str(text).map_err(|err| format!("workflow {name} is not valid JSON: {err}"))?;
    let items = data["steps"].as_array().ok_or_else(|| format!("workflow {name} needs a steps array"))?;
    from_steps(items, name)
}

/// The steps of workflow `name` from their JSON form, the form a workflow file and the Workflows panel both use.
pub fn from_steps(items: &[Value], name: &str) -> Result<Workflow, String> {
    let steps = items
        .iter()
        .enumerate()
        .map(|(index, item)| step(item).map_err(|err| format!("workflow {name}, step {}: {err}", index + 1)))
        .collect::<Result<Vec<Step>, String>>()?;
    Ok(Workflow { steps })
}

/// The steps with their fixed arguments typed by the tool's parameters. The editor sends each argument as text, and the
/// text is read as the parameter's declared type, so a number is a number and a string stays the text it was. A tool step
/// must give every parameter its tool declares, and no others. A text its parameter cannot hold, or a value outside a
/// parameter's listed choices, is refused with the step and the argument named.
pub fn type_steps(items: &[Value]) -> Result<Vec<Value>, String> {
    items
        .iter()
        .enumerate()
        .map(|(index, item)| {
            let Some(arguments) = item.get("arguments").and_then(Value::as_object) else {
                return Ok(item.clone());
            };
            let tool = item["tool"].as_str().unwrap_or_default();
            let typed = typed_arguments(tool, arguments).map_err(|err| format!("step {}: {err}", index + 1))?;
            let mut step = item.clone();
            step["arguments"] = typed;
            Ok(step)
        })
        .collect()
}

fn typed_arguments(tool: &str, arguments: &Map<String, Value>) -> Result<Value, String> {
    let parameters = parameters(tool).ok_or_else(|| format!("unknown tool {tool}"))?;
    if let Some(missing) = parameters.keys().find(|name| !arguments.contains_key(*name)) {
        return Err(format!("{tool} needs argument {missing}"));
    }
    let mut typed = Map::new();
    for (name, text) in arguments {
        let text = text.as_str().ok_or_else(|| format!("argument {name} must be text"))?;
        let schema = parameters.get(name).ok_or_else(|| format!("{tool} takes no argument {name}"))?;
        let value = typed_value(schema, text).map_err(|err| format!("argument {name} {err}"))?;
        typed.insert(name.clone(), value);
    }
    Ok(Value::Object(typed))
}

/// The value of a text read as a parameter with `schema`. A parameter with a listed set of choices takes one of them;
/// a string parameter keeps the text exactly.
fn typed_value(schema: &Value, text: &str) -> Result<Value, String> {
    if let Some(choices) = schema["enum"].as_array() {
        if choices.iter().any(|choice| choice.as_str() == Some(text)) {
            return Ok(Value::String(text.to_owned()));
        }
        let listed: Vec<&str> = choices.iter().filter_map(Value::as_str).collect();
        return Err(format!("must be one of {}, not {text:?}", listed.join(", ")));
    }
    match schema["type"].as_str().unwrap_or("string") {
        "integer" => {
            let number: i64 = text
                .trim()
                .parse()
                .map_err(|_| format!("must be a whole number, not {text:?}"))?;
            match schema["minimum"].as_i64() {
                Some(minimum) if number < minimum => Err(format!("must be at least {minimum}")),
                _ => Ok(Value::from(number)),
            }
        }
        "number" => text
            .trim()
            .parse::<f64>()
            .ok()
            .and_then(Number::from_f64)
            .map(Value::Number)
            .ok_or_else(|| format!("must be a number, not {text:?}")),
        "boolean" => match text.trim() {
            "true" => Ok(Value::Bool(true)),
            "false" => Ok(Value::Bool(false)),
            _ => Err(format!("must be true or false, not {text:?}")),
        },
        _ => Ok(Value::String(text.to_owned())),
    }
}

/// The parameters `tool` declares, by name, with each one's schema. `None` if there is no such tool.
fn parameters(tool: &str) -> Option<Map<String, Value>> {
    let definitions = tools::definitions();
    let function = definitions
        .as_array()?
        .iter()
        .map(|entry| &entry["function"])
        .find(|function| function["name"] == tool)?;
    function["parameters"]["properties"].as_object().cloned()
}

/// Every tool the chat offers, with its parameters, for the Workflows panel's editor.
pub fn tool_list() -> Value {
    let tools: Vec<Value> = tools::NAMES
        .iter()
        .map(|name| {
            let parameters: Vec<Value> = parameters(name)
                .unwrap_or_default()
                .into_iter()
                .map(|(key, schema)| {
                    json!({
                        "name": key,
                        "type": schema["type"],
                        "enum": schema["enum"],
                        "minimum": schema["minimum"],
                        "description": schema["description"],
                    })
                })
                .collect();
            json!({ "name": name, "parameters": parameters })
        })
        .collect();
    Value::Array(tools)
}

/// The JSON form of a workflow, as a workflow file holds it.
pub fn to_value(workflow: &Workflow) -> Value {
    let steps: Vec<Value> = workflow
        .steps
        .iter()
        .map(|step| match step {
            Step::Instructions(text) => json!({ "instructions": text }),
            Step::Profile(reference) => json!({ "profile": reference }),
            Step::Tool { name, arguments: Some(arguments) } => json!({ "tool": name, "arguments": arguments }),
            Step::Tool { name, arguments: None } => json!({ "tool": name }),
        })
        .collect();
    json!({ "steps": steps })
}

/// The names of the workflows in the folder, sorted. A missing folder means there are none.
pub fn list(working: Option<&Path>) -> Result<Vec<String>, String> {
    let Some(root) = working else {
        return Ok(Vec::new());
    };
    let entries = match fs::read_dir(root.join(WORKFLOWS_DIR)) {
        Ok(entries) => entries,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(format!("could not read {WORKFLOWS_DIR}: {err}")),
    };
    let mut names = Vec::new();
    for entry in entries {
        let file = entry.map_err(|err| format!("could not read {WORKFLOWS_DIR}: {err}"))?;
        let file = file.file_name().to_string_lossy().into_owned();
        if let Some(name) = file.strip_suffix(".json") {
            if check_name(name).is_ok() {
                names.push(name.to_owned());
            }
        }
    }
    names.sort();
    Ok(names)
}

/// Writes workflow `name`, replacing any workflow already saved under that name.
pub fn save(working: Option<&Path>, name: &str, workflow: &Workflow) -> Result<(), String> {
    let path = file(working, name)?;
    let folder = path.parent().ok_or_else(|| format!("cannot save workflow {name}"))?;
    fs::create_dir_all(folder).map_err(|err| format!("could not create {WORKFLOWS_DIR}: {err}"))?;
    let text = serde_json::to_string_pretty(&to_value(workflow)).map_err(|err| format!("workflow {name}: {err}"))?;
    fs::write(&path, text).map_err(|err| format!("could not write workflow {name}: {err}"))
}

/// Deletes workflow `name`.
pub fn delete(working: Option<&Path>, name: &str) -> Result<(), String> {
    let path = file(working, name)?;
    fs::remove_file(&path).map_err(|err| format!("could not delete workflow {name}: {err}"))
}

/// The file a workflow name stands for. The name is checked first, so it cannot leave the folder.
fn file(working: Option<&Path>, name: &str) -> Result<PathBuf, String> {
    check_name(name)?;
    let root = working.ok_or("no working directory is set, so workflows are unavailable")?;
    Ok(root.join(WORKFLOWS_DIR).join(format!("{name}.json")))
}

/// A name a workflow can be saved under: one word, not a chat command.
pub fn check_name(name: &str) -> Result<(), String> {
    if !valid_name(name) {
        return Err(format!("a workflow name may only use letters, digits, '-' and '_': {name:?}"));
    }
    if COMMANDS.contains(&name) {
        return Err(format!("{name} is a chat command, so it cannot name a workflow"));
    }
    Ok(())
}

fn step(item: &Value) -> Result<Step, String> {
    if let Some(text) = item["instructions"].as_str() {
        return Ok(Step::Instructions(text.to_owned()));
    }
    if let Some(reference) = item["profile"].as_str() {
        return Ok(Step::Profile(reference.to_owned()));
    }
    if let Some(name) = item["tool"].as_str() {
        if !tools::NAMES.contains(&name) {
            return Err(format!("unknown tool {name}"));
        }
        let arguments = match item.get("arguments") {
            None | Some(Value::Null) => None,
            Some(arguments) if arguments.is_object() => Some(arguments.clone()),
            Some(_) => return Err("arguments must be an object".to_owned()),
        };
        return Ok(Step::Tool { name: name.to_owned(), arguments });
    }
    Err("a step needs instructions, profile, or tool".to_owned())
}

/// A workflow name is one word of letters, digits, `-` and `_`, the same as a saved session's name.
fn valid_name(name: &str) -> bool {
    !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// The text with the argument in place of each placeholder.
pub fn fill(text: &str, argument: &str) -> String {
    text.replace(ARGUMENT, argument)
}

/// The fixed arguments of a tool step, with the argument filled into every string they hold.
pub fn fill_arguments(value: &Value, argument: &str) -> Value {
    match value {
        Value::String(text) => Value::String(fill(text, argument)),
        Value::Array(items) => Value::Array(items.iter().map(|item| fill_arguments(item, argument)).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(key, item)| (key.clone(), fill_arguments(item, argument))).collect()),
        other => other.clone(),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn steps_parse_in_order_and_unknown_tools_are_refused() {
        let text = r#"{"steps":[
            {"instructions":"Summarize {argument}."},
            {"profile":"local/review/strict"},
            {"tool":"create_file","arguments":{"path":"notes.md"}},
            {"tool":"read_file"}
        ]}"#;
        let workflow = parse(text, "demo").unwrap();

        assert!(matches!(&workflow.steps[0], Step::Instructions(text) if text == "Summarize {argument}."));
        assert!(matches!(&workflow.steps[1], Step::Profile(reference) if reference == "local/review/strict"));
        assert!(matches!(&workflow.steps[2], Step::Tool { name, arguments: Some(_) } if name == "create_file"));
        assert!(matches!(&workflow.steps[3], Step::Tool { name, arguments: None } if name == "read_file"));
        assert!(parse(r#"{"steps":[{"tool":"nope"}]}"#, "demo").is_err());
    }

    #[test]
    fn a_saved_workflow_is_listed_and_loads_back_the_same() {
        let root = std::env::temp_dir().join(format!("vise-workflows-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let workflow = parse(r#"{"steps":[{"instructions":"Hi {argument}."},{"tool":"read_file","arguments":{"path":"a.txt"}}]}"#, "demo").unwrap();
        save(Some(&root), "demo", &workflow).unwrap();
        let listed = list(Some(&root));
        let loaded = load(Some(&root), "demo");
        fs::remove_dir_all(&root).unwrap();

        assert_eq!(listed.unwrap(), ["demo"]);
        assert_eq!(to_value(&loaded.unwrap().unwrap()), to_value(&workflow));
    }

    #[test]
    fn fixed_arguments_are_typed_by_the_tool_and_text_for_text_parameters_is_kept() {
        let items = [
            json!({ "tool": "list_files", "arguments": { "path": "007", "depth": "2" } }),
            json!({ "tool": "read_file", "arguments": { "path": "true", "start": "3", "end": "6" } }),
        ];
        let typed = type_steps(&items).unwrap();

        assert_eq!(typed[0]["arguments"], json!({ "path": "007", "depth": 2 }));
        assert_eq!(typed[1]["arguments"], json!({ "path": "true", "start": 3, "end": 6 }));
        assert!(type_steps(&[json!({ "tool": "list_files", "arguments": { "depth": "deep" } })]).is_err());
        assert!(type_steps(&[json!({ "tool": "list_files", "arguments": { "nope": "x" } })]).is_err());
    }

    #[test]
    fn a_tool_step_gives_every_parameter_and_only_listed_choices() {
        let missing = type_steps(&[json!({ "tool": "create_note", "arguments": { "category": "c", "name": "n", "content": "x" } })]);
        let bad_choice = type_steps(&[json!({ "tool": "create_note", "arguments": { "scope": "nowhere", "category": "c", "name": "n", "content": "x" } })]);
        let good = type_steps(&[json!({ "tool": "create_note", "arguments": { "scope": "global", "category": "c", "name": "n", "content": "x" } })]);

        assert!(missing.unwrap_err().contains("needs argument scope"));
        assert!(bad_choice.unwrap_err().contains("must be one of local, global"));
        assert!(good.is_ok());
    }

    #[test]
    fn the_argument_fills_placeholders_and_the_command_splits_name_and_argument() {
        let filled = fill_arguments(&json!({ "path": "{argument}", "count": 2 }), "a.txt");

        assert_eq!(fill("Read {argument} now.", "a.txt"), "Read a.txt now.");
        assert_eq!(filled, json!({ "path": "a.txt", "count": 2 }));
        assert_eq!(command("/demo  two words "), Some(("demo", "two words")));
        assert_eq!(command("/demo"), Some(("demo", "")));
        assert_eq!(command("hello"), None);
    }
}
