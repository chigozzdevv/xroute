#[tokio::main]
async fn main() {
    if let Err(error) = executor_relayer::run().await {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
