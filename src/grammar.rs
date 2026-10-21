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
        let names: Vec<String> = enabled.iter().map(|name| literal(name)).collect();
        rules.push("root ::= prose calls?".to_owned());
        rules.push("calls ::= call+".to_owned());
        rules.push(format!(
            "call ::= {} name {} params {}",
            literal("<tool_call>\n<function="),
            literal(">\n"),
            literal("</function>\n</tool_call>"),
        ));
        rules.push(format!("name ::= {}", names.join(" | ")));
        rules.push(format!(
            "params ::= ({} [^>\\n]+ {} value {})*",
            literal("<parameter="),
            literal(">\n"),
            literal("\n</parameter>\n"),
        ));
    }
    rules.extend(avoid_rules("prose", "<tool_call>"));
    rules.extend(avoid_rules("value", "</parameter>"));
    rules.join("\n") + "\n"
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
