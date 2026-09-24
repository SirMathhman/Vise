use crossterm::event::Event;
use ratatui::DefaultTerminal;
use tokio::sync::mpsc;

use crate::event;
use crate::llm;
use crate::state::App;
use crate::ui;

/// Runs the TUI, streaming a single message to the local llama.cpp server.
pub async fn run() -> color_eyre::Result<()> {
    let mut terminal = ratatui::try_init()?;
    let mut app = App::new();
    let client = reqwest::Client::new();
    let mut ev_rx = event::start_reader();

    let result = app_loop(&mut terminal, &mut app, &client, &mut ev_rx).await;
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
        terminal.draw(|f| ui::render(f, app))?;

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
            if !app.handle_key(&key)
                && key.modifiers.contains(crossterm::event::KeyModifiers::CONTROL)
                && key.code == crossterm::event::KeyCode::Enter
                && let Some(prompt) = app.send()
            {
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
