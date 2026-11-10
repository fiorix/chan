//! A tracing subscriber that keeps what it formats, for tests that read log lines.

use std::io::Write;
use std::sync::{Arc, Mutex};

/// Plain-text log lines written while a future runs under the returned
/// subscriber; a per-future subscriber keeps parallel tests from reading
/// each other's lines.
pub(crate) fn capture_logs() -> (impl tracing::Subscriber + Send + Sync, Arc<Mutex<Vec<u8>>>) {
    #[derive(Clone)]
    struct Capture(Arc<Mutex<Vec<u8>>>);
    impl Write for Capture {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let output = Arc::new(Mutex::new(Vec::new()));
    let writer = Capture(output.clone());
    let subscriber = tracing_subscriber::fmt()
        .without_time()
        .with_ansi(false)
        .with_writer(move || writer.clone())
        .finish();
    (subscriber, output)
}
