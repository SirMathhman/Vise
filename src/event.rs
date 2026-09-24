use crossterm::event::Event;
use tokio::sync::mpsc;

/// Spawns a blocking crossterm event reader and returns the receiver.
pub(crate) fn start_reader() -> mpsc::UnboundedReceiver<Event> {
    let (tx, rx) = mpsc::unbounded_channel::<Event>();
    tokio::task::spawn_blocking(move || {
        loop {
            match crossterm::event::read() {
                Ok(ev) => {
                    let _ = tx.send(ev);
                }
                Err(_) => return,
            }
        }
    });
    rx
}
