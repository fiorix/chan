use std::process::Command;

const CHILD: &str = "UPDATE_CLIENT_LOG_TEST_CHILD";
const EMPTY_STORE: &str = "the system certificate store gave no trust anchors";
const UNREADABLE_STORE: &str = "the system certificate store did not read cleanly";
const OUTSIDE: &str = "update client test: outer subscriber restored";

fn check_client(name: &str, probe: bool) {
    if std::env::var(CHILD).as_deref() == Ok(name) {
        // The process's first trust-store read must happen with WARN enabled.
        tracing::subscriber::set_global_default(
            tracing_subscriber::fmt()
                .with_max_level(tracing::Level::WARN)
                .without_time()
                .with_ansi(false)
                .with_target(false)
                .with_writer(std::io::stderr)
                .finish(),
        )
        .unwrap();
        if probe {
            super::probe_http_client().unwrap();
        } else {
            super::http_client(super::PROBE_CONNECT_TIMEOUT, super::PROBE_TOTAL_TIMEOUT).unwrap();
        }
        tracing::warn!("update client test: outer subscriber restored");
        println!("client construction completed: {name}");
        return;
    }

    for missing in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let bundle = directory.path().join("empty.pem");
        if !missing {
            std::fs::write(&bundle, "").unwrap();
        }
        let roots = directory.path().join("roots");
        std::fs::create_dir(&roots).unwrap();
        // A fresh process cannot inherit a verifier cached by another test.
        let output = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", name, "--nocapture", "--test-threads=1"])
            .env_clear()
            .env("HOME", directory.path())
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .env("TMPDIR", directory.path())
            .env("SSL_CERT_FILE", &bundle)
            .env("SSL_CERT_DIR", &roots)
            .env(CHILD, name)
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(output.status.success(), "{stdout}{stderr}");
        assert!(
            stdout.contains(&format!("client construction completed: {name}")),
            "the child must execute its construction case: {stdout}{stderr}"
        );
        assert_eq!(stderr.matches(OUTSIDE).count(), 1, "{stderr}");
        if probe {
            assert!(
                !stderr.contains(EMPTY_STORE) && !stderr.contains(UNREADABLE_STORE),
                "background probe construction must not warn about the trust store: {stderr}"
            );
            assert_eq!(stderr.lines().count(), 1, "{stderr}");
        } else {
            assert!(
                stderr.contains(EMPTY_STORE),
                "direct client construction must warn about the empty trust store: {stderr}"
            );
            assert_eq!(stderr.contains(UNREADABLE_STORE), missing, "{stderr}");
        }
        println!("missing={missing}: {stdout}{stderr}");
    }
}

#[test]
fn direct_client_reports_native_store_warnings() {
    check_client(
        "update::probe_tests::direct_client_reports_native_store_warnings",
        false,
    );
}

#[test]
fn probe_client_keeps_native_store_warnings_silent() {
    check_client(
        "update::probe_tests::probe_client_keeps_native_store_warnings_silent",
        true,
    );
}
