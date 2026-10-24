//! Startup settings for both executables: the Strata URL, the model, and the read timeout. They come from a `.env` file, or
//! from the process environment, where a variable already set wins over the file. The file is the one next to the exe if
//! there is one, else the one in the working folder.

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

use crate::strata::{self, Config};

pub const URL: &str = "VISE_URL";
pub const MODEL: &str = "VISE_MODEL";
pub const READ_TIMEOUT_SECS: &str = "VISE_READ_TIMEOUT_SECS";

/// The config a program starts with. The working directory is the one the program was started in, and Strata's grammar
/// support is read from the server.
pub fn startup_config() -> Config {
    let file = parse_env(&env_file().and_then(|path| std::fs::read_to_string(path).ok()).unwrap_or_default());
    let working_dir = match std::env::current_dir() {
        Ok(dir) => Some(dir.display().to_string()),
        Err(err) => {
            eprintln!("warning: could not read the working directory: {err}");
            None
        }
    };
    let config = config_with(working_dir, |key| std::env::var(key).ok().or_else(|| file.get(key).cloned()));
    // Lazy grammars keep prose unconstrained while a tool is off; older Strata builds get the full grammar.
    let lazy_grammar = strata::supports_lazy_grammar(&config);
    Config { lazy_grammar, ..config }
}

/// The config for the settings `value` gives, with the defaults for any it leaves out. A timeout that is not a whole
/// number of seconds is reported, and the default is used.
pub fn config_with(working_dir: Option<String>, lookup: impl Fn(&str) -> Option<String>) -> Config {
    // A blank setting counts as unset, so an empty URL cannot replace the default.
    let value = |key: &str| lookup(key).filter(|text| !text.trim().is_empty());
    let defaults = Config::default();
    let read_timeout = match value(READ_TIMEOUT_SECS) {
        Some(text) => text.parse::<u64>().map(Duration::from_secs).unwrap_or_else(|_| {
            eprintln!("warning: {READ_TIMEOUT_SECS} must be a whole number of seconds; using the default");
            defaults.read_timeout
        }),
        None => defaults.read_timeout,
    };
    Config {
        url: value(URL).unwrap_or(defaults.url),
        model: value(MODEL).unwrap_or(defaults.model),
        read_timeout,
        working_dir,
        ..defaults
    }
}

/// The `.env` file to read: the one next to the exe if it exists, else the one in the working folder.
fn env_file() -> Option<PathBuf> {
    let beside_exe = std::env::current_exe().ok().and_then(|exe| exe.parent().map(|dir| dir.join(".env")));
    let in_working = std::env::current_dir().ok().map(|dir| dir.join(".env"));
    [beside_exe, in_working].into_iter().flatten().find(|path| path.is_file())
}

/// Reads `KEY=VALUE` lines. Blank lines and lines starting with `#` are skipped, and a value may be wrapped in single or
/// double quotes.
pub fn parse_env(text: &str) -> HashMap<String, String> {
    text.lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                return None;
            }
            let (key, value) = line.split_once('=')?;
            let value = value.trim();
            let unquoted = value
                .strip_prefix('"')
                .and_then(|inner| inner.strip_suffix('"'))
                .or_else(|| value.strip_prefix('\'').and_then(|inner| inner.strip_suffix('\'')))
                .unwrap_or(value);
            Some((key.trim().to_owned(), unquoted.to_owned()))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_lines_are_read_with_comments_blanks_and_quotes_skipped() {
        let text = "# Strata\nVISE_URL=http://10.0.0.5:9000/v1/chat/completions\n\nVISE_MODEL=\"my-model\"\n  VISE_READ_TIMEOUT_SECS = '120' \n";
        let parsed = parse_env(text);

        assert_eq!(parsed.get(URL).map(String::as_str), Some("http://10.0.0.5:9000/v1/chat/completions"));
        assert_eq!(parsed.get(MODEL).map(String::as_str), Some("my-model"));
        assert_eq!(parsed.get(READ_TIMEOUT_SECS).map(String::as_str), Some("120"));
        assert_eq!(parsed.len(), 3);
    }

    #[test]
    fn settings_override_the_defaults_and_a_bad_timeout_keeps_the_default() {
        let set = |key: &str| match key {
            MODEL => Some("other-model".to_owned()),
            READ_TIMEOUT_SECS => Some("soon".to_owned()),
            _ => None,
        };
        let config = config_with(Some("C:\\work".to_owned()), set);
        let defaults = Config::default();

        assert_eq!(config.model, "other-model");
        assert_eq!(config.url, defaults.url);
        assert_eq!(config.read_timeout, defaults.read_timeout);
        assert_eq!(config.working_dir.as_deref(), Some("C:\\work"));
    }

    #[test]
    fn a_blank_url_counts_as_unset() {
        let config = config_with(None, |key| (key == URL).then(String::new));

        assert_eq!(config.url, Config::default().url);
    }
}
