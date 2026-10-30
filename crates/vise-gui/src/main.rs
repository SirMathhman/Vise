mod app;
mod transcript;
mod words;
mod worker;

use app::ViseApp;
use eframe::egui_wgpu::{WgpuConfiguration, WgpuSetup, WgpuSetupCreateNew};
use eframe::wgpu::PowerPreference;
use vise_core::environment;
use vise_core::parts::Parts;
use vise_core::stop::Stop;
use worker::Worker;

fn main() -> eframe::Result {
    dotenvy::dotenv().ok();
    let api_key = std::env::var("LLAMA_API_KEY").unwrap_or_else(|_| fail("LLAMA_API_KEY is not set; add it to .env"));
    let env = environment::gather().unwrap_or_else(|err| fail(&format!("cannot read current directory: {err}")));
    // A fresh session by default: the window cannot show the history of a resumed one.
    let resume = std::env::args().skip(1).any(|arg| arg == "--resume");
    let stop = Stop::new();

    let options = eframe::NativeOptions {
        viewport: eframe::egui::ViewportBuilder::default().with_title("Vise").with_inner_size([900.0, 700.0]),
        wgpu_options: WgpuConfiguration {
            // The display adapter, so drawing does not compete with the model for the big GPU. WGPU_POWER_PREF overrides it.
            wgpu_setup: WgpuSetup::CreateNew(WgpuSetupCreateNew {
                power_preference: PowerPreference::from_env().unwrap_or(PowerPreference::LowPower),
                ..WgpuSetupCreateNew::without_display_handle()
            }),
            ..Default::default()
        },
        ..Default::default()
    };
    eframe::run_native(
        "Vise",
        options,
        Box::new(move |creation| {
            let ctx = creation.egui_ctx.clone();
            let for_parts = stop.clone();
            let worker = Worker::spawn(stop.clone(), resume, move || ctx.request_repaint(), move || {
                Parts::for_directory(api_key, &env, for_parts)
            });
            Ok(Box::new(ViseApp::new(worker, stop)))
        }),
    )
}

/// Writes a fatal message to stderr and exits with status 1.
fn fail(message: &str) -> ! {
    eprintln!("error: {message}");
    std::process::exit(1)
}
