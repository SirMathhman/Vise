use crate::strata::Config;
use crate::tools;

/// Handles a `/tools`, `/enable <tool>`, or `/disable <tool>` line. Returns the text to show,
/// or `None` if the line is not one of these commands.
pub fn handle(line: &str, config: &Config) -> Option<String> {
    let mut words = line.split_whitespace();
    match words.next()? {
        "/tools" => Some(list(config)),
        "/enable" => Some(set(words.next(), true, config)),
        "/disable" => Some(set(words.next(), false, config)),
        _ => None,
    }
}

fn list(config: &Config) -> String {
    tools::NAMES
        .iter()
        .map(|name| {
            let state = if config.tool_enabled(name) { "on" } else { "off" };
            format!("{name}: {state}")
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn set(name: Option<&str>, enabled: bool, config: &Config) -> String {
    match name {
        Some(name) if tools::NAMES.contains(&name) => {
            config.set_tool_enabled(name, enabled);
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
        let config = Config::default();

        assert_eq!(handle("/disable delete_file", &config).unwrap(), "delete_file disabled");
        assert!(!config.tool_enabled("delete_file"));
        assert_eq!(handle("/enable delete_file", &config).unwrap(), "delete_file enabled");
        assert!(config.tool_enabled("delete_file"));
        assert_eq!(handle("hello", &config), None);
    }
}
