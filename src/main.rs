fn main() -> color_eyre::Result<()> {
    // A missing .env is the normal case; surface a parse failure in one that exists.
    let env_path = std::path::Path::new(".env");
    if env_path.exists()
        && let Err(e) = dotenvy::dotenv()
    {
        eprintln!("warning: failed to load .env: {e}");
    }
    color_eyre::install()?;
    let rt = tokio::runtime::Runtime::new()?;
    rt.block_on(async {
        vise::run().await
    })
}
