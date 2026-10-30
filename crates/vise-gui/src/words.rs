//! English wording for the engine's typed events: the query results and the state changes. The terminal words them the same
//! way in `vise-cli`; the two copies should become one (see the frontend-boundary notes in ARCHITECTURE.md).

use vise_core::frontend::{Change, DropCause, UiEvent};

/// The text for a typed event, or `None` for an event that is not a query result or a change.
pub fn describe(event: &UiEvent) -> Option<String> {
    Some(match event {
        UiEvent::Changed(change) => changed(change),
        UiEvent::Note { summary, category, content, .. } => format!("summary: {summary}\ncategory: {category}\n\n{content}"),
        UiEvent::Tools(tools) => lines(tools.iter().map(|tool| format!("{}: {}", tool.name, state(tool.enabled)))),
        UiEvent::Profiles(names) if names.is_empty() => "no profiles: a profile is a note with the category profile".to_string(),
        UiEvent::Profiles(names) => names.join("\n"),
        UiEvent::Models { ids, .. } if ids.is_empty() => "no models".to_string(),
        UiEvent::Models { current, ids } => {
            lines(ids.iter().map(|id| format!("{}{id}", if id == current { "* " } else { "  " })))
        }
        UiEvent::Sessions(names) if names.is_empty() => "no sessions: /save NAME stores the conversation".to_string(),
        UiEvent::Sessions(names) => names.join("\n"),
        UiEvent::Notes(notes) if notes.is_empty() => "no notes".to_string(),
        UiEvent::Notes(notes) => {
            lines(notes.iter().map(|note| format!("{} [{}]: {}", note.name, note.category, note.summary)))
        }
        UiEvent::Context { text, prompt_tokens, size } => match size {
            Some(size) => format!("{text}\n{prompt_tokens} / {size}"),
            None => text.clone(),
        },
        UiEvent::Notice(_) | UiEvent::Status(_) | UiEvent::Error(_) | UiEvent::Reply(_) | UiEvent::Stream { .. } | UiEvent::TurnEnded => {
            return None;
        }
    })
}

fn changed(change: &Change) -> String {
    match change {
        Change::ToolToggled { name, enabled } => format!("{name}: {}", state(*enabled)),
        Change::ProfileApplied { name, tool_changes, new_hooks } => {
            let mut out: Vec<String> =
                tool_changes.iter().map(|tool| format!("{}: {}", tool.name, state(tool.enabled))).collect();
            if !new_hooks.is_empty() {
                out.push(format!(
                    "profile {name}: these hook lines are new or changed since the run started, and run without a prompt:"
                ));
                out.extend(new_hooks.iter().map(|line| format!("  {line}")));
            }
            out.join("\n")
        }
        Change::ProfileSelected { name } => format!("profile {name} selected; its instructions go with your next message"),
        Change::SessionSaved { name } => format!("session {name} saved"),
        Change::SessionLoaded { name } => format!("session {name} loaded"),
        Change::ModelSet { name, default_saved: true } => format!("model set to {name}, and kept as the default"),
        Change::ModelSet { name, default_saved: false } => format!("model set to {name}"),
        Change::Compacted => "conversation compacted".to_string(),
        Change::OldestTurnDropped { removed, cause: DropCause::SummaryDidNotFit } => {
            format!("the summary did not fit, so the oldest turn was dropped ({removed} messages removed)")
        }
        Change::OldestTurnDropped { removed, cause: DropCause::ContextFull } => {
            format!("the context was full, so the oldest turn was dropped ({removed} messages removed)")
        }
        Change::Reset => "started a new conversation".to_string(),
        Change::NoteCreated { name } => format!("created note '{name}'"),
        Change::NoteDeleted { name } => format!("deleted note '{name}'"),
    }
}

fn lines(items: impl Iterator<Item = String>) -> String {
    items.collect::<Vec<_>>().join("\n")
}

fn state(enabled: bool) -> &'static str {
    if enabled { "enabled" } else { "disabled" }
}

#[cfg(test)]
mod tests {
    use super::*;
    use vise_core::frontend::{NoteLine, ToolState};

    #[test]
    fn queries_and_changes_are_worded_like_the_terminal() {
        assert_eq!(
            describe(&UiEvent::Tools(vec![ToolState { name: "read_file".into(), enabled: false }])).as_deref(),
            Some("read_file: disabled")
        );
        assert_eq!(
            describe(&UiEvent::Models { current: "b".into(), ids: vec!["a".into(), "b".into()] }).as_deref(),
            Some("  a\n* b")
        );
        assert_eq!(
            describe(&UiEvent::Notes(vec![NoteLine { name: "plan".into(), category: "memory".into(), summary: "s".into() }]))
                .as_deref(),
            Some("plan [memory]: s")
        );
        assert_eq!(
            describe(&UiEvent::Context { text: "context".into(), prompt_tokens: 3, size: Some(10) }).as_deref(),
            Some("context\n3 / 10")
        );
        assert_eq!(describe(&UiEvent::Changed(Change::Reset)).as_deref(), Some("started a new conversation"));
        assert_eq!(
            describe(&UiEvent::Changed(Change::ProfileApplied {
                name: "explore".into(),
                tool_changes: vec![ToolState { name: "create_file".into(), enabled: false }],
                new_hooks: vec!["before-turn: Get-Date".into()],
            }))
            .as_deref(),
            Some(
                "create_file: disabled\nprofile explore: these hook lines are new or changed since the run started, and run without a prompt:\n  before-turn: Get-Date"
            )
        );
    }

    #[test]
    fn empty_lists_say_so() {
        assert_eq!(describe(&UiEvent::Sessions(Vec::new())).as_deref(), Some("no sessions: /save NAME stores the conversation"));
        assert_eq!(describe(&UiEvent::Notes(Vec::new())).as_deref(), Some("no notes"));
        assert_eq!(describe(&UiEvent::Models { current: String::new(), ids: Vec::new() }).as_deref(), Some("no models"));
    }

    #[test]
    fn plain_events_have_no_wording_of_their_own() {
        assert_eq!(describe(&UiEvent::Notice("x".into())), None);
        assert_eq!(describe(&UiEvent::TurnEnded), None);
    }
}
