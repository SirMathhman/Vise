//! Ctrl+C on the terminal. The handler never ends the process on its own: the first press asks the running work to stop,
//! through the `Stop` switch the engine and the provider share. Any other press quits, with status 130.

use crate::stop::Stop;

/// Installs the Ctrl+C handler. With work running, the first press only asks it to stop; every other press quits.
pub fn install(stop: Stop) -> Result<(), ctrlc::Error> {
    ctrlc::set_handler(move || {
        if stop.request() {
            eprintln!("\ninterrupting; press Ctrl+C again to quit");
        } else {
            std::process::exit(130);
        }
    })
}
