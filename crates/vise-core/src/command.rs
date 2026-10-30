//! The commands a frontend can send the engine. How they are typed is the frontend's business: the terminal parses
//! slash commands into these, and another frontend can build them from buttons or menus.

/// `Exit` ends the run and `Help` is the frontend's own to answer; the engine does nothing for `Help`.
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
