pub const HELP: &str = "\
/compact              summarize the conversation to free up context space
/context              show the working directory and the tokens used out of the context size
/exit                 end the session
/help                 show this list
/tools                list each tool and whether the model may call it
/tools enable NAME    let the model call a tool
/tools disable NAME   stop the model calling a tool
/profile              list the profiles in the profiles folder
/profile NAME         use a profile's instructions from the next message on
/notes [CATEGORY]     list the notes, all or in one category
/note show NAME       show a note
/note create NAME CATEGORY   create a note with a placeholder summary
/note delete NAME     delete a note
/save NAME            save the conversation as a session in the sessions folder
/load NAME            replace the conversation with a saved session
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
            ["create", name, category] => Some(Command::CreateNote(name.to_string(), category.to_string())),
            ["delete", name] => Some(Command::DeleteNote(name.to_string())),
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
        _ => None,
    }
}

/// The rest of `line` after `command`, when `command` is the line's first word.
fn whole_word<'a>(line: &'a str, command: &str) -> Option<&'a str> {
    line.strip_prefix(command).filter(|rest| rest.is_empty() || rest.starts_with(' '))
}
