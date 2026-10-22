//! Profiles: notes marked `profile: true` that tell the model how to behave. This module reads them. Applying a
//! profile to the tool switches and to the conversation is up to `commands`.

use std::fs;

use super::store::{Roots, SCOPES, note_path, split_frontmatter};

/// A profile that has been read: where it lives, the tools it allows (`None` when it has no tools line), and its
/// instructions.
pub struct Profile {
    pub label: String,
    pub tools: Option<Vec<String>>,
    pub instructions: String,
}

/// The tool list and instructions of a note marked as a profile. `None` when the note is not one.
pub(super) fn profile_of(text: &str) -> Option<(Option<Vec<String>>, String)> {
    let (fields, body) = split_frontmatter(text)?;
    if fields.get("profile").map(String::as_str) != Some("true") {
        return None;
    }
    let tools = fields
        .get("tools")
        .map(|list| list.split(',').map(str::trim).filter(|tool| !tool.is_empty()).map(str::to_owned).collect());
    Some((tools, body.trim().to_owned()))
}

/// Reads `/profile <scope>/<category>/<name>`. Returns `None` if the line is not this command.
pub fn command(line: &str, roots: Roots) -> Option<Result<Profile, String>> {
    let mut words = line.split_whitespace();
    if words.next()? != "/profile" {
        return None;
    }
    let note = words.next().unwrap_or_default();
    let parts: Vec<&str> = note.split('/').collect();
    Some(match parts.as_slice() {
        [scope, category, name] if SCOPES.contains(scope) => load(scope, category, name, roots),
        _ => Err("usage: /profile <local|global>/<category>/<name>".to_owned()),
    })
}

fn load(scope: &str, category: &str, name: &str, roots: Roots) -> Result<Profile, String> {
    let target = note_path(scope, roots, category, name)?;
    let text = fs::read_to_string(&target).map_err(|err| format!("could not read {category}/{name}: {err}"))?;
    let (tools, instructions) =
        profile_of(&text).ok_or_else(|| format!("{scope} {category}/{name} is not a profile"))?;
    Ok(Profile { label: format!("{scope} {category}/{name}"), tools, instructions })
}
