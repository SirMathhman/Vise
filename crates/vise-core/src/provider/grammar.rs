//! The grammar that constrains each reply. It is built from the enabled tools, so a disabled tool has no
//! rule and cannot be generated. It is sent with no `tools` array: the server refuses a custom grammar
//! when tools are present, so the grammar is the only thing that shapes the output.
//!
//! A call must name every parameter of its tool, in the order the tool's spec lists them. The values are any JSON
//! value: the grammar does not check their type or range, which `tools::call` does after the reply is parsed.

use crate::tools::specs;
use crate::tools::types::ToolSpec;

const THINK_END: &str = "</think>";
const TOOL_OPEN: &str = "<tool_call>";

/// Builds the grammar for one request: a thinking block, then plain text or, when any tool is enabled, a
/// call to one of them.
pub fn build(enabled: &[&str]) -> String {
    let reply = if enabled.is_empty() { "answer" } else { "(call | answer)" };
    let mut rules = vec![
        format!("root ::= think \"{THINK_END}\" ws {reply}"),
        "think ::= think0".to_string(),
        "answer ::= answer0".to_string(),
    ];
    rules.extend(avoiding("think", THINK_END));
    rules.extend(avoiding("answer", TOOL_OPEN));
    if !enabled.is_empty() {
        let tools: Vec<&ToolSpec> = specs().iter().filter(|spec| enabled.contains(&spec.name)).collect();
        let calls: Vec<String> = tools.iter().map(|spec| rule_name("call", spec.name)).collect();
        rules.push(CALL.replace("CALLS", &calls.join(" | ")));
        for spec in tools {
            rules.push(call_rule(spec));
            rules.push(args_rule(spec));
        }
    }
    rules.push(JSON_RULES.into());
    rules.join("\n")
}

const CALL: &str = r#"call ::= "<tool_call>\n{\"name\": " (CALLS) "}\n</tool_call>""#;

/// The rule name for a tool. A grammar rule name takes letters, digits and `-` only, so `_` becomes `-`.
fn rule_name(prefix: &str, tool: &str) -> String {
    format!("{prefix}-{}", tool.replace('_', "-"))
}

/// The rule for one tool's call: its name, then its arguments.
fn call_rule(spec: &ToolSpec) -> String {
    let (call, args) = (rule_name("call", spec.name), rule_name("args", spec.name));
    format!(r#"{call} ::= "\"{}\"" ", \"arguments\": " {args}"#, spec.name)
}

/// The rule for one tool's arguments: an object holding each parameter's name once, in the spec's order, each with any
/// JSON value. A tool with no parameters takes an empty object.
fn args_rule(spec: &ToolSpec) -> String {
    let fields: Vec<String> =
        spec.params.iter().map(|param| format!(r#""\"{}\"" ws ":" ws value"#, param.name)).collect();
    let inner = if fields.is_empty() { String::new() } else { format!("{} ws ", fields.join(r#" ws "," ws "#)) };
    format!(r#"{} ::= "{{" ws {inner}"}}""#, rule_name("args", spec.name))
}

/// Rules for text that may contain anything except `marker`. Rule `{name}{k}` has matched the first `k`
/// characters of the marker, and it may end there, so the text can stop anywhere.
fn avoiding(name: &str, marker: &str) -> Vec<String> {
    let marker: Vec<char> = marker.chars().collect();
    let mut distinct = marker.clone();
    distinct.sort_unstable();
    distinct.dedup();
    let excluded: String = distinct.iter().map(|&c| escape_class(c)).collect();
    (0..marker.len())
        .map(|matched| {
            let mut alternatives = vec![format!("[^{excluded}] {name}0")];
            for &c in &distinct {
                let next = next_state(&marker[..matched], c, &marker);
                if next < marker.len() {
                    alternatives.push(format!("\"{}\" {name}{next}", escape_literal(c)));
                }
            }
            alternatives.push("\"\"".into());
            format!("{name}{matched} ::= {}", alternatives.join(" | "))
        })
        .collect()
}

/// The number of marker characters matched after `c` follows `matched`: the longest suffix of the
/// text read so far that is a prefix of `marker`. A result equal to `marker.len()` means the marker is
/// complete, which the grammar forbids.
fn next_state(matched: &[char], c: char, marker: &[char]) -> usize {
    let mut seen = matched.to_vec();
    seen.push(c);
    (0..=seen.len().min(marker.len())).rev().find(|&len| seen.ends_with(&marker[..len])).unwrap_or(0)
}

fn escape_class(c: char) -> String {
    match c {
        ']' | '\\' | '^' | '-' => format!("\\{c}"),
        _ => c.to_string(),
    }
}

fn escape_literal(c: char) -> String {
    match c {
        '"' | '\\' => format!("\\{c}"),
        _ => c.to_string(),
    }
}

const JSON_RULES: &str = r#"ws ::= [ \t\n]*
object ::= "{" ws ( string ws ":" ws value ( ws "," ws string ws ":" ws value )* )? ws "}"
value ::= object | array | string | number | "true" | "false" | "null"
array ::= "[" ws ( value ( ws "," ws value )* )? ws "]"
string ::= "\"" ( [^"\\\x00-\x1F] | "\\" ( ["\\/bfnrt] | "u" [0-9a-fA-F] [0-9a-fA-F] [0-9a-fA-F] [0-9a-fA-F] ) )* "\""
number ::= "-"? ( "0" | [1-9] [0-9]* ) ( "." [0-9]+ )? ( [eE] [-+]? [0-9]+ )?"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disabled_tool_has_no_rule() {
        let grammar = build(&["read_file"]);
        assert!(grammar.contains("\"\\\"read_file\\\"\""));
        assert!(!grammar.contains("list_directory"));
    }

    #[test]
    fn a_call_names_every_parameter_in_the_specs_order() {
        let grammar = build(&["run_powershell"]);
        let args = grammar.lines().find(|line| line.starts_with("args-run-powershell ::=")).expect("the arguments rule");
        let positions: Vec<usize> = ["command", "timeout_seconds", "background"]
            .iter()
            .map(|name| args.find(&format!("\"\\\"{name}\\\"\"")).expect("a required name"))
            .collect();
        assert!(positions.windows(2).all(|pair| pair[0] < pair[1]), "{args}");
        assert!(args.contains("ws \":\" ws value"));
    }

    #[test]
    fn another_tools_parameters_have_no_rule() {
        let grammar = build(&["read_file"]);
        assert!(grammar.contains("args-read-file"));
        assert!(!grammar.contains("timeout_seconds"));
    }

    #[test]
    fn every_tool_gets_a_call_and_an_arguments_rule() {
        for spec in specs() {
            let grammar = build(&[spec.name]);
            assert!(grammar.contains(&format!("{} ::= ", rule_name("call", spec.name))), "{}", spec.name);
            assert!(grammar.contains(&format!("{} ::= ", rule_name("args", spec.name))), "{}", spec.name);
        }
    }

    #[test]
    fn no_enabled_tool_means_no_call_rule() {
        let grammar = build(&[]);
        assert!(!grammar.contains("call"));
        assert!(grammar.starts_with("root ::= think \"</think>\" ws answer\n"));
    }

    #[test]
    fn completing_the_marker_is_forbidden() {
        let marker: Vec<char> = TOOL_OPEN.chars().collect();
        let n = marker.len();
        assert_eq!(next_state(&marker[..n - 1], '>', &marker), n);
        assert_eq!(next_state(&marker[..1], '<', &marker), 1);
        assert_eq!(next_state(&[], 'x', &marker), 0);
    }
}
