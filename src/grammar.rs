//! The request grammar that keeps the model from generating calls to switched-off tools.
//!
//! Strata applies a GBNF grammar to the output token by token. It does not change the prompt, so the
//! prompt cache still applies. The grammar allows ordinary text and tool calls in the XML format of
//! Strata's chat template, but a call may only name a tool from the enabled list.

/// The grammar for a reply that may contain prose and calls to the `enabled` tools only.
pub fn enabled_calls_only(enabled: &[&str]) -> String {
    let mut rules = Vec::new();
    if enabled.is_empty() {
        rules.push("root ::= prose".to_owned());
    } else {
        rules.push("root ::= prose calls?".to_owned());
        rules.extend(call_rules(enabled));
    }
    rules.extend(avoid_rules("prose", "<tool_call>"));
    rules.extend(avoid_rules("value", "</parameter>"));
    rules.join("\n") + "\n"
}

/// The grammar for a reply that calls the `name` tool, after any prose, and no other tool. The call's arguments are
/// free, so the model fills them in.
pub fn forced_call(name: &str) -> String {
    let mut rules = vec!["root ::= prose calls".to_owned()];
    rules.extend(call_rules(&[name]));
    rules.extend(avoid_rules("prose", "<tool_call>"));
    rules.extend(avoid_rules("value", "</parameter>"));
    rules.join("\n") + "\n"
}

/// The lazy grammar for Strata's `grammar_lazy`: it starts at the `<tool_call>` that triggers it and allows only calls
/// to the `enabled` tools, so prose and reasoning before the first call are not constrained at all. `enabled` must
/// not be empty: with every tool off there is no call to allow, and the full grammar keeps calls out instead.
pub fn enabled_calls_after_trigger(enabled: &[&str]) -> String {
    let mut rules = vec!["root ::= calls".to_owned()];
    rules.extend(call_rules(enabled));
    rules.extend(avoid_rules("value", "</parameter>"));
    rules.join("\n") + "\n"
}

/// The text that starts a call, and the token Strata's lazy grammar is triggered by.
pub const CALL_TRIGGER: &str = "<tool_call>";

/// The rules for one or more calls in the XML format of Strata's chat template, naming only `enabled` tools.
fn call_rules(enabled: &[&str]) -> Vec<String> {
    let names: Vec<String> = enabled.iter().map(|name| literal(name)).collect();
    vec![
        "calls ::= call (ws call)* ws".to_owned(),
        "ws ::= [ \\t\\n]*".to_owned(),
        format!(
            "call ::= {} name {} params {}",
            literal("<tool_call>\n<function="),
            literal(">\n"),
            literal("</function>\n</tool_call>"),
        ),
        format!("name ::= {}", names.join(" | ")),
        format!(
            "params ::= ({} [^>\\n]+ {} value {})*",
            literal("<parameter="),
            literal(">\n"),
            literal("\n</parameter>\n"),
        ),
    ]
}

/// Rules for `name`: any text that never contains `literal`. `literal` must start with `<` and
/// contain no other `<`, so a `<` always restarts the match. State `k` means the first `k`
/// characters of `literal` have just been matched.
fn avoid_rules(name: &str, literal_text: &str) -> Vec<String> {
    let chars: Vec<char> = literal_text.chars().collect();
    let state = |k: usize| if k == 0 { name.to_owned() } else { format!("{name}{k}") };

    let mut rules = Vec::new();
    for k in 0..chars.len() {
        let excluded = if k == 0 {
            "<".to_owned()
        } else {
            format!("<{}", class_escape(chars[k]))
        };
        let mut alternatives = vec![format!("[^{excluded}] {}", state(0))];
        alternatives.push(format!("{} {}", literal("<"), state(1)));
        if k > 0 && k + 1 < chars.len() {
            alternatives.push(format!("{} {}", literal(&chars[k].to_string()), state(k + 1)));
        }
        rules.push(format!("{} ::= ({})?", state(k), alternatives.join(" | ")));
    }
    rules
}

/// A GBNF string literal for `text`.
fn literal(text: &str) -> String {
    let escaped = text
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n");
    format!("\"{escaped}\"")
}

/// A character escaped for use inside a GBNF character class.
fn class_escape(c: char) -> String {
    match c {
        ']' | '\\' | '^' | '-' => format!("\\{c}"),
        _ => c.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grammar_names_only_the_enabled_tools() {
        let text = enabled_calls_only(&["read_file", "list_files"]);

        assert!(text.contains(r#"name ::= "read_file" | "list_files""#));
        assert!(!text.contains("delete_file"));
        assert!(text.starts_with("root ::= prose calls?"));
    }

    #[test]
    fn grammar_with_no_enabled_tools_allows_no_calls() {
        let text = enabled_calls_only(&[]);

        assert!(text.starts_with("root ::= prose\n"));
        assert!(!text.contains("calls"));
    }

    #[test]
    fn lazy_grammar_starts_at_a_call_and_has_no_prose_rule() {
        let text = enabled_calls_after_trigger(&["read_file"]);

        assert!(text.starts_with("root ::= calls
"));
        assert!(text.contains(r#"name ::= "read_file""#));
        assert!(!text.contains("prose"));
        assert!(text.contains(&literal(&format!("{CALL_TRIGGER}
<function="))));
    }

    #[test]
    fn a_forced_call_grammar_names_only_that_tool_after_prose() {
        let text = forced_call("create_file");

        assert!(text.starts_with("root ::= prose calls\n"));
        assert!(text.contains(r#"name ::= "create_file""#));
        assert!(!text.contains("delete_file"));
    }

    #[test]
    fn literals_escape_quotes_backslashes_and_newlines() {
        assert_eq!(literal("a\"b\\c\nd"), r#""a\"b\\c\nd""#);
    }
}
