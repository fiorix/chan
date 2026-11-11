//! Keep proxy policy at the shared HTTP client boundary.

use std::path::Path;

fn scan(root: &Path, dir: &Path, violations: &mut Vec<String>) {
    for entry in std::fs::read_dir(dir).expect("read CLI source directory") {
        let entry = entry.expect("read CLI source entry");
        let path = entry.path();
        if path.is_dir() {
            scan(root, &path, violations);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            let relative = path.strip_prefix(root).unwrap();
            let allowed = [
                // Owns the local-devserver and explicit-URL proxy policies.
                "http_client.rs",
                // Self-upgrade downloads use the user's remote proxy settings.
                "update.rs",
            ];
            if allowed.iter().any(|allowed| relative == Path::new(allowed)) {
                continue;
            }
            let source = std::fs::read_to_string(&path).expect("read CLI source");
            for (line, text) in source.lines().enumerate() {
                if text.contains("reqwest::Client::new(")
                    || text.contains("reqwest::Client::builder(")
                {
                    violations.push(format!(
                        "{}:{}: {}",
                        relative.display(),
                        line + 1,
                        text.trim()
                    ));
                }
            }
        }
    }
}

#[test]
fn clients_use_the_shared_proxy_policy() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut violations = Vec::new();
    scan(&root, &root, &mut violations);
    violations.sort();
    assert!(
        violations.is_empty(),
        "HTTP clients must use http_client's explicit proxy policy:\n{}",
        violations.join("\n")
    );
}
