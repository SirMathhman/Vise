//! The web UI and its server, in one executable. The page is compiled into the binary, so the only file it reads beside
//! itself is an optional `.env` file.

fn main() -> std::io::Result<()> {
    vise::web::serve(vise::web::DEFAULT_PORT, vise::config::startup_config())
}
