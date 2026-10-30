pub const HELP: &str = "\
/compact              summarize the conversation to free up context space
/context              show the working directory and the tokens used out of the context size
/exit                 end the session
/help                 show this list
/tools                list each tool and whether the model may call it
/tools enable NAME    let the model call a tool
/tools disable NAME   stop the model calling a tool
/profile              list the profiles: notes with the category profile
/profile NAME         use a profile's instructions from the next message on
/model               list the models the server offers, and the one in use
/model NAME          use a model the server offers, and keep it as the default
/notes [CATEGORY]     list the notes, all or in one category
/note show NAME       show a note
/note create CATEGORY NAME   create a note with a placeholder summary
/note delete NAME     delete a note
/save NAME            save the conversation as a session in the sessions folder
/load NAME            replace the conversation with a saved session
/new                  start an empty conversation, saved as a new session
/sessions             list the saved sessions";

pub enum Command {
    Compact,
    Exit,
    Context,
    Help,
    Tools,
    Enable(String),
    Disable(String),
    Profiles,
    Profile(String),
    /// Lists the notes in a category; an empty category lists all.
    ListNotes(String),
    ShowNote(String),
    CreateNote(String, String),
    DeleteNote(String),
    Save(String),
    Load(String),
    Sessions,
    /// Empties the conversation; the next turn starts a new session.
    New,
    /// Lists the models the server offers, marking the one in use.
    Models,
    /// Makes the named model the one in use, if the server offers it.
    UseModel(String),
}

/// Slash commands are handled here and never sent to the model. Any other line, including an unknown
/// slash command, is sent as a message.
pub fn command(line: &str) -> Option<Command> {
    let line = line.trim();
    if let Some(rest) = whole_word(line, "/notes") {
        return match rest.split_whitespace().collect::<Vec<_>>().as_slice() {
            [] => Some(Command::ListNotes(String::new())),
            [category] => Some(Command::ListNotes(category.to_string())),
            _ => None,
        };
    }
    if let Some(rest) = whole_word(line, "/save") {
        return match rest.split_whitespace().collect::<Vec<_>>().as_slice() {
            [name] => Some(Command::Save(name.to_string())),
            _ => None,
        };
    }
    if let Some(rest) = whole_word(line, "/load") {
        return match rest.split_whitespace().collect::<Vec<_>>().as_slice() {
            [name] => Some(Command::Load(name.to_string())),
            _ => None,
        };
    }
    if let Some(rest) = whole_word(line, "/note") {
        return match rest.split_whitespace().collect::<Vec<_>>().as_slice() {
            ["show", name] => Some(Command::ShowNote(name.to_string())),
            ["create", category, name] => Some(Command::CreateNote(name.to_string(), category.to_string())),
            ["delete", name] => Some(Command::DeleteNote(name.to_string())),
            _ => None,
        };
    }
    if let Some(rest) = whole_word(line, "/model") {
        return match rest.split_whitespace().collect::<Vec<_>>().as_slice() {
            [] => Some(Command::Models),
            [name] => Some(Command::UseModel(name.to_string())),
            _ => None,
        };
    }
    if let Some(rest) = line.strip_prefix("/profile").filter(|rest| rest.is_empty() || rest.starts_with(' ')) {
        return match rest.split_whitespace().collect::<Vec<_>>().as_slice() {
            [] => Some(Command::Profiles),
            [name] => Some(Command::Profile(name.to_string())),
            _ => None,
        };
    }
    if let Some(rest) = line.strip_prefix("/tools") {
        return match rest.split_whitespace().collect::<Vec<_>>().as_slice() {
            [] => Some(Command::Tools),
            ["enable", name] => Some(Command::Enable(name.to_string())),
            ["disable", name] => Some(Command::Disable(name.to_string())),
            _ => None,
        };
    }
    match line {
        "/exit" => Some(Command::Exit),
        "/context" => Some(Command::Context),
        "/help" => Some(Command::Help),
        "/compact" => Some(Command::Compact),
        "/sessions" => Some(Command::Sessions),
        "/new" => Some(Command::New),
        _ => None,
    }
}

/// The rest of `line` after `command`, when `command` is the line's first word.
fn whole_word<'a>(line: &'a str, command: &str) -> Option<&'a str> {
    line.strip_prefix(command).filter(|rest| rest.is_empty() || rest.starts_with(' '))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_note_takes_the_category_before_the_name() {
        assert!(matches!(
            command("/note create profile a"),
            Some(Command::CreateNote(name, category)) if name == "a" && category == "profile"
        ));
    }

    #[test]
    fn new_command_takes_no_arguments() {
        assert!(matches!(command("/new"), Some(Command::New)));
        assert!(command("/new x").is_none());
    }

    #[test]
    fn model_command_takes_an_optional_name() {
        assert!(matches!(command("/model"), Some(Command::Models)));
        assert!(matches!(command("/model a/b"), Some(Command::UseModel(name)) if name == "a/b"));
        assert!(command("/models").is_none());
    }
}
