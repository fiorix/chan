//! Identity configuration defaults shared by its integration-test fixtures.

use identity::config::Config;
use identity::profile_client::ProfileClient;

pub(crate) fn test_config(database_url: &str, profile_client: ProfileClient) -> Config {
    Config {
        bind_addr: "127.0.0.1:0".parse().unwrap(),
        internal_bind_addr: "127.0.0.1:0".parse().unwrap(),
        base_url: "http://localhost:7000/".parse().unwrap(),
        devserver_proxy_origin: "https://proxy.example.test".parse().unwrap(),
        devserver_tunnel_origin: "https://tunnel.example.test".parse().unwrap(),
        database_url: database_url.to_string(),
        cookie_secure: true,
        profile_client,
        internal_auth_token: "test-internal".to_string(),
        session_internal_auth_token: "test-session-internal".to_string(),
        identity_admin_token: String::new(),
        account_admin_token: String::new(),
        workspace_admin: gateway_common::devserver_control_client::DevserverControlClient::new(
            "http://127.0.0.1:7002".parse().unwrap(),
            "test-identity-admin-token".into(),
        )
        .unwrap(),
        admission_lease_verifier: {
            let signer = devserver_control_proto::AdmissionLeaseSigner::from_base64(
                "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            )
            .unwrap();
            devserver_control_proto::AdmissionLeaseVerifier::from_base64(
                &signer.verifying_key_base64(),
            )
            .unwrap()
        },
        entry_signer: gateway_common::devserver_gate::EntrySigner::from_base64(
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        )
        .unwrap(),
        providers: vec![],
    }
}
