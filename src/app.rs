use crossterm::event::Event;
use ratatui::DefaultTerminal;
use tokio::sync::mpsc;

use crate::llm;
use crate::state::App;
use crate::ui;

pub(crate) async fn app_loop(
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
