#[tokio::main]
async fn main() {
    if let Err(error) = quote_service::run().await {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
