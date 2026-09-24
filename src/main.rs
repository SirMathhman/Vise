fn main() -> color_eyre::Result<()> {
    let rt = tokio::runtime::Runtime::new()?;
    rt.block_on(async {
        vise::run().await
    })
}
