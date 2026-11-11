//! A CA in the system store verifies through the public path: the bundle
//! `SSL_CERT_FILE` names holds a CA made for this run, `client_config()`
//! reads it as the system store, and a full handshake with a server under
//! that CA completes. macOS and Windows read no bundle: the platform
//! verifier decides there.
#![cfg(not(any(target_os = "macos", target_os = "windows")))]

mod support;

#[test]
fn a_ca_in_the_system_store_verifies_through_client_config() {
    let ca = support::ca("chan-tls system store test CA");
    let leaf = support::leaf(&ca);
    let bundle =
        std::env::temp_dir().join(format!("chan-tls-system-ca-{}.pem", std::process::id()));
    std::fs::write(&bundle, ca.pem()).unwrap();
    // The only test in this binary, so nothing else reads the environment
    // while it changes.
    std::env::set_var("SSL_CERT_FILE", &bundle);
    std::env::remove_var("SSL_CERT_DIR");
    let config = chan_tls::client_config();
    let _ = std::fs::remove_file(&bundle);
    let config = config.expect("the trust decision builds over the bundle");
    support::handshake(config, &leaf).expect("a CA the system store holds verifies its leaf");
}
