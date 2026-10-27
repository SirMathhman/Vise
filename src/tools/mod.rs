pub mod create_directory;
pub mod create_file;
pub mod edit_file;
pub mod jobs;
pub mod kill_background;
pub mod list_directory;
pub mod path;
pub mod read_background;
pub mod read_file;
pub mod run_powershell;
pub mod runner;
pub mod types;

use std::collections::HashMap;
use types::{Arguments, Invocation, ToolError, ToolSpec, Value};

/// Looks up the named tool, checks the argument values against its spec, and returns the typed invocation.
pub fn call(name: &str, values: HashMap<String, Value>) -> Result<Invocation, ToolError> {
    let spec = SPECS
        .iter()
        .find(|spec| spec.name == name)
        .ok_or_else(|| ToolError::UnknownTool(name.to_string()))?;
    let args = Arguments::validated(spec, values)?;
    (spec.bind)(&args)
}

const SPECS: &[ToolSpec] = &[
    list_directory::SPEC,
    read_file::SPEC,
    create_file::SPEC,
    create_directory::SPEC,
    edit_file::SPEC,
    run_powershell::SPEC,
    read_background::SPEC,
    kill_background::SPEC,
];

pub fn specs() -> &'static [ToolSpec] {
    SPECS
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn values(pairs: Vec<(&str, Value)>) -> HashMap<String, Value> {
        pairs.into_iter().map(|(name, value)| (name.to_string(), value)).collect()
    }

    fn rejection(spec: &ToolSpec, pairs: Vec<(&str, Value)>) -> String {
        Arguments::validated(spec, values(pairs)).err().expect("expected the arguments to be rejected").to_string()
    }

    #[test]
    fn list_directory_rejects_missing_path() {
        let message = rejection(&list_directory::SPEC, vec![("depth", Value::Integer(1))]);
        assert!(message.contains("missing 'path'"));
    }

    #[test]
    fn list_directory_rejects_text_depth() {
        let message = rejection(
            &list_directory::SPEC,
            vec![("path", Value::Text(".".into())), ("depth", Value::Text("1".into()))],
        );
        assert!(message.contains("'depth' has the wrong type"));
    }

    #[test]
    fn list_directory_rejects_depth_above_five() {
        let message = rejection(
            &list_directory::SPEC,
            vec![("path", Value::Text(".".into())), ("depth", Value::Integer(6))],
        );
        assert!(message.contains("'depth' is out of range"));
    }

    #[test]
    fn read_file_rejects_missing_end() {
        let message = rejection(
            &read_file::SPEC,
            vec![("path", Value::Text("a.txt".into())), ("start", Value::Integer(1))],
        );
        assert!(message.contains("missing 'end'"));
    }

    #[test]
    fn read_file_rejects_text_start() {
        let message = rejection(
            &read_file::SPEC,
            vec![
                ("path", Value::Text("a.txt".into())),
                ("start", Value::Text("1".into())),
                ("end", Value::Integer(3)),
            ],
        );
        assert!(message.contains("'start' has the wrong type"));
    }

    #[test]
    fn read_file_rejects_start_below_one() {
        let message = rejection(
            &read_file::SPEC,
            vec![
                ("path", Value::Text("a.txt".into())),
                ("start", Value::Integer(0)),
                ("end", Value::Integer(3)),
            ],
        );
        assert!(message.contains("'start' is out of range"));
    }

    #[test]
    fn unknown_tool_name_is_rejected() {
        let error = call("delete_everything", HashMap::new()).err().expect("expected an unknown tool error");
        assert!(matches!(error, ToolError::UnknownTool(name) if name == "delete_everything"));
    }

    #[test]
    fn extra_field_is_rejected_by_name() {
        let message = rejection(
            &list_directory::SPEC,
            vec![
                ("path", Value::Text(".".into())),
                ("depth", Value::Integer(1)),
                ("recursive", Value::Integer(1)),
            ],
        );
        assert!(message.contains("unknown field 'recursive'"));
    }

    #[test]
    fn unsupported_json_type_is_wrong_type_not_missing() {
        let message = rejection(
            &list_directory::SPEC,
            vec![("path", Value::Text(".".into())), ("depth", Value::Unsupported)],
        );
        assert!(message.contains("'depth' has the wrong type"));
    }
}
