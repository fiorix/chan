use chrono::Utc;
use devserver_control_proto::{AdmissionLease, AdmissionLeaseVerifier};
use gateway_common::devserver_control_client::TunnelView;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum AuthorityError {
    #[error("controller tunnel admission lease is invalid")]
    InvalidLease,
    #[error("controller tunnel row does not match its signed admission lease")]
    BindingMismatch,
}

/// Independently authenticate one controller row before identity uses it for
/// entry authorization or roster output. Controller admin authentication is
/// transport authority only; the identity-signed lease is the row authority.
pub fn verify_tunnel(
    verifier: &AdmissionLeaseVerifier,
    row: &TunnelView,
) -> Result<(), AuthorityError> {
    let lease = AdmissionLease::parse(row.admission_lease.clone())
        .map_err(|_| AuthorityError::InvalidLease)?;
    let claims = verifier
        .verify(&lease, Utc::now())
        .map_err(|_| AuthorityError::InvalidLease)?;
    let binding = claims.binding;
    if binding.owner_user_id != row.owner_user_id
        || binding.registration_id != row.registration_id
        || binding.user != row.user
        || binding.devserver_id != row.devserver_id
        || binding.proxy_id.as_str() != row.proxy_id
        || claims.max_connected_devservers != row.max_connected_devservers
        || claims.expires_at != row.admission_lease_expires_at.timestamp()
    {
        return Err(AuthorityError::BindingMismatch);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration;
    use devserver_control_proto::{AdmissionLeaseBinding, AdmissionLeaseSigner, ProxyId};
    use uuid::Uuid;

    fn fixture() -> (AdmissionLeaseVerifier, TunnelView) {
        let signer =
            AdmissionLeaseSigner::from_base64("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
                .unwrap();
        let verifier = AdmissionLeaseVerifier::from_base64(&signer.verifying_key_base64()).unwrap();
        let now = Utc::now();
        let owner_user_id = Uuid::new_v4();
        let registration_id = Uuid::new_v4();
        let binding = AdmissionLeaseBinding {
            owner_user_id,
            user: "alice".into(),
            devserver_id: "a".repeat(64),
            registration_id,
            proxy_id: ProxyId::parse("p1").unwrap(),
        };
        let lease = signer.sign(binding, 3, now, 120).unwrap();
        (
            verifier,
            TunnelView {
                registration_id,
                owner_user_id,
                user: "alice".into(),
                devserver_id: "a".repeat(64),
                max_connected_devservers: 3,
                peer_addr: None,
                connected_at: now,
                proxy_id: "p1".into(),
                proxy_base_url: "https://p1.proxy.chan.app".into(),
                admission_lease: lease.as_str().into(),
                admission_lease_expires_at: now + Duration::seconds(120),
            },
        )
    }

    #[test]
    fn exact_signed_row_verifies() {
        let (verifier, row) = fixture();
        verify_tunnel(&verifier, &row).unwrap();
    }

    #[test]
    fn tampered_lease_and_wrong_owner_fail_closed() {
        let (verifier, mut row) = fixture();
        row.admission_lease.push('x');
        assert_eq!(
            verify_tunnel(&verifier, &row).unwrap_err(),
            AuthorityError::InvalidLease
        );

        let (verifier, mut row) = fixture();
        row.owner_user_id = Uuid::new_v4();
        assert_eq!(
            verify_tunnel(&verifier, &row).unwrap_err(),
            AuthorityError::BindingMismatch
        );
    }

    #[test]
    fn wrong_registration_user_devserver_proxy_or_expiry_fails_closed() {
        let (verifier, row) = fixture();
        for mutate in [
            |row: &mut TunnelView| row.registration_id = Uuid::new_v4(),
            |row: &mut TunnelView| row.user = "mallory".into(),
            |row: &mut TunnelView| row.devserver_id = "b".repeat(64),
            |row: &mut TunnelView| row.proxy_id = "p2".into(),
            |row: &mut TunnelView| row.admission_lease_expires_at += Duration::seconds(1),
        ] {
            let mut candidate = row.clone();
            mutate(&mut candidate);
            assert_eq!(
                verify_tunnel(&verifier, &candidate).unwrap_err(),
                AuthorityError::BindingMismatch
            );
        }
    }
}
