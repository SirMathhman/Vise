use ratatui::{
    Frame,
    layout::{Constraint, Direction, Layout},
    text::Line,
    widgets::{Block, Paragraph, Wrap},
};

use crate::state::App;

pub(crate) fn render(f: &mut Frame, app: &App) {
    let area = f.area();
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Length(3), Constraint::Min(3)])
        .split(area);

    // Input block.
    let input_label = if app.streaming {
        "streaming…"
    } else {
        "input (Ctrl+Enter to send, q to quit)"
    };
    let input_block = Block::default()
        .borders(ratatui::widgets::Borders::ALL)
        .title(input_label);
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
    let resp_block = Block::default()
        .borders(ratatui::widgets::Borders::ALL)
        .title(resp_label);
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
