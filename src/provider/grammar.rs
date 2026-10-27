//! The grammar that constrains each reply. It is built from the enabled tools, so a disabled tool has no
//! rule and cannot be generated. It is sent with no `tools` array: the server refuses a custom grammar
//! when tools are present, so the grammar is the only thing that shapes the output.

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
        rules.push(r#"call ::= "<tool_call>\n{\"name\": " name ", \"arguments\": " object "}\n</tool_call>""#.into());
        let names: Vec<String> = enabled.iter().map(|name| format!("\"\\\"{name}\\\"\"")).collect();
        rules.push(format!("name ::= {}", names.join(" | ")));
    }
    rules.push(JSON_RULES.into());
    rules.join("\n")
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
