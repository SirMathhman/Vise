use crossterm::event::{Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};

/// One message: a user prompt plus the streamed assistant response.
pub(crate) struct Message {
    pub(crate) prompt: String,
    pub(crate) response: String,
}

/// Application state shared by the event loop and the renderer.
pub(crate) struct App {
    pub(crate) input: String,
    pub(crate) cursor: usize,
    pub(crate) streaming: bool,
    pub(crate) message: Option<Message>,
    pub(crate) error: Option<String>,
}

impl App {
    pub(crate) fn new() -> Self {
        Self {
            input: String::new(),
            cursor: 0,
            streaming: false,
            message: None,
            error: None,
        }
    }

    pub(crate) fn is_quit(&self, event: &Event) -> bool {
        matches!(event, Event::Key(key) if key.kind == KeyEventKind::Press
            && ((key.code == KeyCode::Char('q') && self.input.is_empty())
                || (key.code == KeyCode::Esc && self.input.is_empty() && self.message.is_none())))
    }

    pub(crate) fn send(&mut self) -> Option<String> {
        let prompt = self.input.trim().to_string();
        if prompt.is_empty() || self.streaming {
            return None;
        }
        self.input.clear();
        self.cursor = 0;
        self.message = Some(Message {
            prompt: prompt.clone(),
            response: String::new(),
        });
        self.error = None;
        self.streaming = true;
        Some(prompt)
    }

    /// Returns `true` if this is an editing key the app consumed.
    /// Returns `false` for command keys (e.g. Ctrl+Enter) so the caller
    /// can decide what to do with them.
    pub(crate) fn handle_key(&mut self, key: &KeyEvent) -> bool {
        if key.kind != KeyEventKind::Press {
            return false;
        }
        if key.modifiers.contains(KeyModifiers::CONTROL) {
            return false;
        }
        match key.code {
            KeyCode::Backspace => { self.backspace(); true }
            KeyCode::Delete => { self.delete(); true }
            KeyCode::Left => { self.move_left(); true }
            KeyCode::Right => { self.move_right(); true }
            KeyCode::Home => { self.cursor = 0; true }
            KeyCode::End => { self.cursor = self.input.chars().count(); true }
            KeyCode::Enter => { self.input.push('\n'); true }
            c => { self.insert(c.to_string()); true }
        }
    }

    /// Convert the char-count cursor to the byte index into `input`.
    fn cursor_byte_index(&self) -> usize {
        self.input
            .char_indices()
            .nth(self.cursor)
            .map(|(i, _)| i)
            .unwrap_or(self.input.len())
    }

    fn insert(&mut self, s: String) {
        let start = self.cursor;
        let start_byte = self.cursor_byte_index();
        self.input.insert_str(start_byte, &s);
        self.cursor = start + s.chars().count();
    }

    fn backspace(&mut self) {
        if self.cursor == 0 {
            return;
        }
        let start_byte = self.cursor_byte_index();
        let prev = self
            .input
            .char_indices()
            .rev()
            .find(|(i, _)| *i < start_byte)
            .map(|(i, _)| i)
            .unwrap_or(0);
        self.input.replace_range(prev..start_byte, "");
        self.cursor -= 1;
    }

    fn delete(&mut self) {
        let start_byte = self.cursor_byte_index();
        if self.cursor >= self.input.chars().count() {
            return;
        }
        let end = self
            .input
            .char_indices()
            .find(|(i, _)| *i > start_byte)
            .map(|(i, _)| i)
            .unwrap_or(self.input.len());
        self.input.replace_range(start_byte..end, "");
    }

    fn move_left(&mut self) {
        if self.cursor == 0 {
            return;
        }
        self.cursor -= 1;
    }

    fn move_right(&mut self) {
        if self.cursor >= self.input.chars().count() {
            return;
        }
        self.cursor += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Helper: build a Press KeyEvent with the given code and no modifiers.
    fn key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }

    /// Helper: build an Event wrapping a Press key.
    fn event(code: KeyCode) -> Event {
        Event::Key(key(code))
    }

    // -- handle_key: consumption contract --

    #[test]
    fn handle_key_consumes_char() {
        let mut app = App::new();
        assert!(app.handle_key(&key(KeyCode::Char('h'))));
        assert_eq!(app.input, "h");
        assert_eq!(app.cursor, 1);
    }

    #[test]
    fn handle_key_consumes_backspace_at_start() {
        let mut app = App::new();
        assert!(app.handle_key(&key(KeyCode::Backspace)));
        assert!(app.input.is_empty());
        assert_eq!(app.cursor, 0);
    }

    #[test]
    fn handle_key_consumes_delete_at_end() {
        let mut app = App::new();
        app.input = "ab".into();
        app.cursor = 2;
        assert!(app.handle_key(&key(KeyCode::Delete)));
        assert_eq!(app.input, "ab");
    }

    #[test]
    fn handle_key_returns_false_for_ctrl_key() {
        let mut app = App::new();
        let ctrl = KeyEvent::new(KeyCode::Enter, KeyModifiers::CONTROL);
        assert!(!app.handle_key(&ctrl));
    }

    #[test]
    fn handle_key_returns_false_for_release() {
        let mut app = App::new();
        let mut release = key(KeyCode::Char('h'));
        release.kind = KeyEventKind::Release;
        assert!(!app.handle_key(&release));
    }

    #[test]
    fn handle_key_multibyte_cursor() {
        let mut app = App::new();
        // "é" is 2 bytes in UTF-8; cursor must track char count, not bytes.
        app.handle_key(&key(KeyCode::Char('é')));
        app.handle_key(&key(KeyCode::Char('a')));
        assert_eq!(app.input, "éa");
        assert_eq!(app.cursor, 2);
        // Backspace from end removes 'a'.
        app.handle_key(&key(KeyCode::Backspace));
        assert_eq!(app.input, "é");
        assert_eq!(app.cursor, 1);
    }

    // -- send --

    #[test]
    fn send_returns_none_when_empty() {
        let mut app = App::new();
        assert!(app.send().is_none());
    }

    #[test]
    fn send_returns_none_when_streaming() {
        let mut app = App::new();
        app.input = "hi".into();
        app.streaming = true;
        assert!(app.send().is_none());
    }

    #[test]
    fn send_clears_input_and_sets_streaming() {
        let mut app = App::new();
        app.input = "  hello  ".into();
        app.cursor = 9;
        let prompt = app.send().unwrap();
        assert_eq!(prompt, "hello");
        assert!(app.input.is_empty());
        assert_eq!(app.cursor, 0);
        assert!(app.streaming);
        assert_eq!(app.message.unwrap().prompt, "hello");
    }

    #[test]
    fn send_returns_prompt() {
        let mut app = App::new();
        app.input = "hi".into();
        assert_eq!(app.send().unwrap(), "hi");
    }

    // -- is_quit --

    #[test]
    fn is_quit_q_with_empty_input() {
        let app = App::new();
        assert!(app.is_quit(&event(KeyCode::Char('q'))));
    }

    #[test]
    fn is_quit_q_with_nonempty_input() {
        let mut app = App::new();
        app.input = "x".into();
        assert!(!app.is_quit(&event(KeyCode::Char('q'))));
    }

    #[test]
    fn is_quit_esc_with_no_message() {
        let app = App::new();
        assert!(app.is_quit(&event(KeyCode::Esc)));
    }

    #[test]
    fn is_quit_esc_with_message() {
        let mut app = App::new();
        app.message = Some(Message {
            prompt: "hi".into(),
            response: String::new(),
        });
        assert!(!app.is_quit(&event(KeyCode::Esc)));
    }
}
