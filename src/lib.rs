pub mod llm;
pub mod state;
pub mod ui;
pub mod app;

/// Runs the TUI, streaming a single message to the local llama.cpp server.
pub async fn run() -> color_eyre::Result<()> {
    color_eyre::install()?;

    let mut terminal = ratatui::try_init()?;
    let mut app = state::App::new();
    let client = reqwest::Client::new();

    // Forward crossterm events to the async loop.
    let (ev_tx, mut ev_rx) = tokio::sync::mpsc::unbounded_channel::<crossterm::event::Event>();
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

    let result = app::app_loop(&mut terminal, &mut app, &client, &mut ev_rx).await;
    reader.abort();
    ratatui::restore();
    result
}

