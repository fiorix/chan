//! The tunnel dial's TLS config under an empty system store. `SSL_CERT_FILE`
//! naming an empty file makes rustls-native-certs read that file instead of
//! the platform's bundle, which is how a machine without ca-certificates
//! looks. macOS and Windows read no bundle: the platform verifier decides
//! there.
#![cfg(not(any(target_os = "macos", target_os = "windows")))]

#[test]
fn an_empty_system_store_still_dials_through_the_bundled_roots() {
    let empty = std::env::temp_dir().join(format!(
        "chan-tunnel-empty-store-{}.pem",
        std::process::id()
    ));
    std::fs::write(&empty, b"").unwrap();
    // The only test in this binary, so nothing else reads the environment
    // while it changes.
    std::env::set_var("SSL_CERT_FILE", &empty);
    std::env::remove_var("SSL_CERT_DIR");
    let config = chan_tunnel_client::build_tls_config();
    let _ = std::fs::remove_file(&empty);
    let config = config.expect("the bundled roots are the floor under an empty store");
    assert_eq!(config.alpn_protocols, [b"h2".to_vec()]);
}
