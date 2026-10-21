use crate::tools::{self, Switches};

/// Handles a `/tools`, `/enable <tool>`, or `/disable <tool>` line. Returns the text to show,
/// or `None` if the line is not one of these commands.
pub fn handle(line: &str, switches: &Switches) -> Option<String> {
    let mut words = line.split_whitespace();
    match words.next()? {
        "/tools" => Some(list(switches)),
        "/enable" => Some(set(words.next(), true, switches)),
        "/disable" => Some(set(words.next(), false, switches)),
        _ => None,
    }
}

fn list(switches: &Switches) -> String {
    let disabled = switches.snapshot();
    tools::NAMES
        .iter()
        .map(|name| {
            let state = if disabled.contains(*name) { "off" } else { "on" };
            format!("{name}: {state}")
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn set(name: Option<&str>, enabled: bool, switches: &Switches) -> String {
    match name {
        Some(name) if tools::NAMES.contains(&name) => {
            switches.set(name, enabled);
            let state = if enabled { "enabled" } else { "disabled" };
            format!("{name} {state}")
        }
        Some(name) => format!("error: unknown tool {name}"),
        None => "usage: /enable <tool> or /disable <tool>".to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disable_and_enable_switch_a_tool_off_and_on() {
        let switches = Switches::default();

        assert_eq!(handle("/disable delete_file", &switches).unwrap(), "delete_file disabled");
        assert!(switches.snapshot().contains("delete_file"));
        assert_eq!(handle("/enable delete_file", &switches).unwrap(), "delete_file enabled");
        assert!(!switches.snapshot().contains("delete_file"));
        assert_eq!(handle("hello", &switches), None);
    }
}
