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

    pub(crate) fn handle_key(&mut self, key: &KeyEvent) {
        if key.kind != KeyEventKind::Press {
            return;
        }
        if key.modifiers.contains(KeyModifiers::CONTROL) {
            // Ctrl+Enter is handled by app_loop; swallow here.
            return;
        }
        match key.code {
            KeyCode::Backspace => self.backspace(),
            KeyCode::Delete => self.delete(),
            KeyCode::Left => self.move_left(),
            KeyCode::Right => self.move_right(),
            KeyCode::Home => self.cursor = 0,
            KeyCode::End => self.cursor = self.input.chars().count(),
            KeyCode::Enter => self.input.push('\n'),
            c => self.insert(c.to_string()),
        }
    }

    fn insert(&mut self, s: String) {
        let start = self.cursor;
        self.input.insert_str(start, &s);
        self.cursor = start + s.chars().count();
    }

    fn backspace(&mut self) {
        if self.cursor == 0 {
            return;
        }
        let start = self.cursor;
        let start_byte = self.input.char_indices().find(|(i, _)| *i == start).unwrap().0;
        let prev = self
            .input
            .char_indices()
            .rev()
            .find(|(i, _)| *i < start_byte)
            .map(|(i, _)| i)
            .unwrap_or(0);
        self.input.replace_range(prev..start, "");
        self.cursor = prev;
    }

    fn delete(&mut self) {
        let start = self.cursor;
        if start >= self.input.len() {
            return;
        }
        let end = self
            .input
            .char_indices()
            .find(|(i, _)| *i > start)
            .map(|(i, _)| i)
            .unwrap_or(self.input.len());
        self.input.replace_range(start..end, "");
    }

    fn move_left(&mut self) {
        if self.cursor == 0 {
            return;
        }
        let start = self.cursor;
        let prev = self
            .input
            .char_indices()
            .rev()
            .find(|(i, _)| *i < start)
            .map(|(i, _)| i)
            .unwrap_or(0);
        self.cursor = prev;
    }

    fn move_right(&mut self) {
        let start = self.cursor;
        let next = self
            .input
            .char_indices()
            .find(|(i, _)| *i > start)
            .map(|(i, _)| i)
            .unwrap_or(self.input.len());
        self.cursor = next;
    }
}
