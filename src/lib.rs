use crossterm::event::{Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use ratatui::{
    DefaultTerminal, Frame,
    layout::{Constraint, Direction, Layout},
    text::Line,
    widgets::{Block, Paragraph, Wrap},
};
use tokio::sync::mpsc;

pub mod llm;

/// One message: a user prompt plus the streamed assistant response.
struct Message {
    prompt: String,
    response: String,
}

/// Application state shared by the event loop and the renderer.
struct App {
    input: String,
    cursor: usize,
    streaming: bool,
    message: Option<Message>,
    error: Option<String>,
}

impl App {
    fn new() -> Self {
        Self {
            input: String::new(),
            cursor: 0,
            streaming: false,
            message: None,
            error: None,
        }
    }

    fn is_quit(&self, event: &Event) -> bool {
        if let Event::Key(key) = event {
            if key.kind == KeyEventKind::Press {
                if key.code == KeyCode::Char('q') && self.input.is_empty() {
                    return true;
                }
                if key.code == KeyCode::Esc && self.input.is_empty() && self.message.is_none() {
                    return true;
                }
            }
        }
        false
    }


    fn send(&mut self) -> Option<String> {
        let prompt = self.input.trim().to_string();
        if prompt.is_empty() || self.streaming {
            return None;
        }
        self.input.clear();
        self.cursor = 0;
        self.message = Some(Message { prompt: prompt.clone(), response: String::new() });
        self.error = None;
        self.streaming = true;
        Some(prompt)
    }

    fn handle_key(&mut self, key: &KeyEvent) {
        if key.kind != KeyEventKind::Press {
            return;
        }
        if key.modifiers.contains(KeyModifiers::CONTROL) {
            if key.code == KeyCode::Enter {
                let _ = self.send();
            }
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
        let prev = self.input.char_indices().rev().find(|(i, _)| *i < start_byte).map(|(i, _)| i).unwrap_or(0);
        self.input.replace_range(prev..start, "");
        self.cursor = prev;
    }

    fn delete(&mut self) {
        let start = self.cursor;
        if start >= self.input.len() {
            return;
        }
        let end = self.input.char_indices().find(|(i, _)| *i > start).map(|(i, _)| i).unwrap_or(self.input.len());
        self.input.replace_range(start..end, "");
    }

    fn move_left(&mut self) {
        if self.cursor == 0 {
            return;
        }
        let start = self.cursor;
        let prev = self.input.char_indices().rev().find(|(i, _)| *i < start).map(|(i, _)| i).unwrap_or(0);
        self.cursor = prev;
    }

    fn move_right(&mut self) {
        let start = self.cursor;
        let next = self.input.char_indices().find(|(i, _)| *i > start).map(|(i, _)| i).unwrap_or(self.input.len());
        self.cursor = next;
    }
}

/// Runs the TUI, streaming a single message to the local llama.cpp server.
pub async fn run() -> color_eyre::Result<()> {
    color_eyre::install()?;

    let mut terminal = ratatui::try_init()?;
    let mut app = App::new();
    let client = reqwest::Client::new();

    // Forward crossterm events to the async loop.
    let (ev_tx, mut ev_rx) = mpsc::unbounded_channel::<Event>();
    let reader = tokio::task::spawn_blocking(move || {
        loop {
            match crossterm::event::read() {
                Ok(ev) => {
                    let _ = ev_tx.send(ev);
                }
                Err(_) => return,
            }
        }
    });

    let result = app_loop(&mut terminal, &mut app, &client, &mut ev_rx).await;
    reader.abort();
    ratatui::restore();
    result
}

async fn app_loop(
    terminal: &mut DefaultTerminal,
    app: &mut App,
    client: &reqwest::Client,
    ev_rx: &mut mpsc::UnboundedReceiver<Event>,
) -> color_eyre::Result<()> {
    loop {
        terminal.draw(|f| render(f, app))?;

        let ev = match ev_rx.recv().await {
            Some(ev) => ev,
            None => break Ok(()),
        };

        if app.is_quit(&ev) {
            break Ok(());
        }

        if let Event::Key(key) = ev {
            if app.streaming {
                continue;
            }
            app.handle_key(&key);
            if let Some(prompt) = app.send() {
                let (tx, mut rx) = mpsc::channel::<String>(64);
                let client = client.clone();
                tokio::spawn(async move {
                    let _ = llm::send_streaming(&client, prompt, tx).await;
                });
                app.streaming = true;
                drain_tokens(app, &mut rx).await;
            }
        }
    }
}

async fn drain_tokens(app: &mut App, rx: &mut mpsc::Receiver<String>) {
    while let Some(token) = rx.recv().await {
        if let Some(msg) = app.message.as_mut() {
            msg.response.push_str(&token);
        }
    }
    app.streaming = false;
}

fn render(f: &mut Frame, app: &mut App) {
    let area = f.area();
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Length(3), Constraint::Min(3)])
        .split(area);

    // Input block.
    let input_label = if app.streaming { "streaming…" } else { "input (Ctrl+Enter to send, q to quit)" };
    let input_block = Block::default().borders(ratatui::widgets::Borders::ALL).title(input_label);
    let input_lines: Vec<Line> = app
        .input
        .lines()
        .map(|line| Line::from(line.to_string()))
        .collect();
    let input = Paragraph::new(input_lines).wrap(Wrap { trim: false });
    let input_inner = input_block.inner(chunks[0]);
    f.render_widget(input_block, chunks[0]);
    f.render_widget(input, input_inner);

    // Response block.
    let resp_label = match &app.message {
        Some(m) => format!("response: {}", m.prompt),
        None => "response".to_string(),
    };
    let resp_block = Block::default().borders(ratatui::widgets::Borders::ALL).title(resp_label);
    let resp_text = match &app.message {
        Some(m) if m.response.is_empty() => "waiting…".to_string(),
        Some(m) => m.response.clone(),
        None => match &app.error {
            Some(err) => format!("error: {err}"),
            None => "no response yet".to_string(),
        },
    };
    let resp = Paragraph::new(resp_text).wrap(Wrap { trim: true });
    let resp_inner = resp_block.inner(chunks[1]);
    f.render_widget(resp_block, chunks[1]);
    f.render_widget(resp, resp_inner);
}

