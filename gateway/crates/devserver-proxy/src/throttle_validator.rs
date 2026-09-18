//! Per-token-fingerprint rate limiter for the tunnel's PAT
//! validations, at dial and on lease refresh.
//!
//! Why not a per-IP gate: every internal hop behind nginx sees one
//! peer IP, so a "per-IP" bucket degenerates into a single global
//! one -- a noisy attacker can lock out legitimate handshakes while
//! real source-IP diversity stays invisible.
//!
//! The brute-force surface is the tunnel handshake, but the bucket
//! meters every validation this wrapper forwards: the dial's, and each
//! lease refresh's, because the tunnel driver revalidates a refresh
//! through the same validator. The Hello-name announcement is not
//! metered (`announce_devserver_name` below). We can't easily
//! key on the original client IP here (the listener is raw h2, not
//! axum, and the gateway terminator wraps `chan-tunnel-server` from
//! chan-core; plumbing X-Forwarded-For into the validator means a
//! chan-core surface change). What we can do cheaply is throttle by
//! the candidate token itself: hash the bytes to a 64-bit fingerprint
//! and run a token-bucket per fingerprint. Guessing a specific
//! (possibly leaked) PAT is bounded regardless of the attacker's
//! IP distribution; random-tail brute force still has astronomical
//! odds per fresh prefix, so the cap on map size is fine.
//!
//! Throttled validates surface as `ServerError::InvalidToken`.
//! At dial this is the same 401 an unknown token returns, and on a
//! lease refresh it is the same `Refused` frame an unknown token
//! gets, so an attacker can't oracle "this fingerprint is rate-limited"
//! vs "this token is unknown" by response shape. chan-tunnel-client
//! retries 401 with exponential backoff, so a legit client that
//! somehow burned its burst recovers on the next attempt once the
//! bucket has refilled; it does not lock the client out.
//!
//! The bucket primitive itself lives in
//! `gateway_common::token_bucket`; this module is the trait wrapper
//! that turns it into a `Validator` decorator.

use async_trait::async_trait;
use chan_tunnel_server::{ServerError, Validated, Validator};
use gateway_common::token_bucket::{
    TokenBucket, DEFAULT_CAPACITY, DEFAULT_MAP_CAP, DEFAULT_REFILL_PER_SEC,
};

pub struct ThrottlingValidator<V: Validator> {
    inner: V,
    bucket: TokenBucket,
}

impl<V: Validator> ThrottlingValidator<V> {
    pub fn new(inner: V) -> Self {
        Self {
            inner,
            bucket: TokenBucket::new(DEFAULT_REFILL_PER_SEC, DEFAULT_CAPACITY, DEFAULT_MAP_CAP),
        }
    }

    pub fn with_limits(inner: V, refill_per_sec: f32, capacity: f32, map_cap: usize) -> Self {
        Self {
            inner,
            bucket: TokenBucket::new(refill_per_sec, capacity, map_cap),
        }
    }
}

#[async_trait]
impl<V: Validator> Validator for ThrottlingValidator<V> {
    async fn validate(&self, token: &str) -> Result<Validated, ServerError> {
        self.admit_token(token)?;
        self.inner.validate(token).await
    }

    async fn validate_registration(
        &self,
        token: &str,
        registration_id: uuid::Uuid,
    ) -> Result<Validated, ServerError> {
        self.admit_token(token)?;
        self.inner
            .validate_registration(token, registration_id)
            .await
    }

    // Not throttled here: the announce fires once per ACCEPTED
    // registration (the brute-force surface this bucket guards is the
    // pre-registration validate), and consuming a bucket token for it
    // would double-charge every legitimate dial. identity runs its own
    // defense-in-depth throttle on the shared endpoint.
    async fn announce_devserver_name(&self, token: &str, name: &str) {
        self.inner.announce_devserver_name(token, name).await;
    }
}

impl<V: Validator> ThrottlingValidator<V> {
    fn admit_token(&self, token: &str) -> Result<(), ServerError> {
        let fp = TokenBucket::fingerprint(token);
        if !self.bucket.try_admit_fp(fp, std::time::Instant::now()) {
            tracing::warn!(
                fingerprint = %format!("{fp:016x}"),
                "tunnel validate throttled"
            );
            return Err(ServerError::InvalidToken);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use uuid::Uuid;

    struct CountingValidator {
        calls: Arc<AtomicUsize>,
    }

    #[async_trait]
    impl Validator for CountingValidator {
        async fn validate(&self, _token: &str) -> Result<Validated, ServerError> {
            self.calls.fetch_add(1, Ordering::Relaxed);
            Ok(Validated {
                user_id: Uuid::nil(),
                username: "u".into(),
                devserver_id: "ds-test".into(),
                scopes: vec!["tunnel".into()],
                gateway_assertion_key: None,
                admission_lease: None,
                admission_lease_expires_at: None,
            })
        }
    }

    #[tokio::test]
    async fn fresh_fingerprint_admits_one_then_blocks() {
        // Token-bucket entries start with 1.0 token, not `capacity`,
        // so a fresh fingerprint admits exactly once before refill.
        let calls = Arc::new(AtomicUsize::new(0));
        let v = ThrottlingValidator::with_limits(
            CountingValidator {
                calls: calls.clone(),
            },
            4.0,
            3.0,
            16,
        );
        assert!(v.validate("chan_pat_x").await.is_ok());
        let err = v.validate("chan_pat_x").await.unwrap_err();
        assert!(matches!(err, ServerError::InvalidToken));
        assert_eq!(calls.load(Ordering::Relaxed), 1);
    }

    #[tokio::test]
    async fn rejects_past_burst_for_same_token() {
        // With refill_per_sec = 4.0, two back-to-back calls within the
        // same tick should see 1 admit, then a near-instantaneous
        // throttle until the bucket refills.
        let calls = Arc::new(AtomicUsize::new(0));
        let v = ThrottlingValidator::with_limits(
            CountingValidator {
                calls: calls.clone(),
            },
            4.0,
            2.0,
            16,
        );
        assert!(v.validate("chan_pat_a").await.is_ok());
        let err = v.validate("chan_pat_a").await.unwrap_err();
        assert!(matches!(err, ServerError::InvalidToken));
        // Inner validator never saw the throttled call.
        assert_eq!(calls.load(Ordering::Relaxed), 1);
    }

    #[tokio::test]
    async fn distinct_tokens_have_distinct_buckets() {
        let calls = Arc::new(AtomicUsize::new(0));
        let v = ThrottlingValidator::with_limits(
            CountingValidator {
                calls: calls.clone(),
            },
            4.0,
            1.0,
            16,
        );
        assert!(v.validate("chan_pat_a").await.is_ok());
        // Same fingerprint -> blocked.
        assert!(v.validate("chan_pat_a").await.is_err());
        // Different token -> independent bucket admits one.
        assert!(v.validate("chan_pat_b").await.is_ok());
        assert_eq!(calls.load(Ordering::Relaxed), 2);
    }

    #[tokio::test]
    async fn inner_error_propagates_without_masking() {
        // The throttle must not mask upstream failures (identity-service
        // 502, network blip) as InvalidToken. chan-tunnel-client retries
        // both, but they surface as different log messages on the
        // client and different status codes on the wire; collapsing
        // them would lose useful diagnostic signal.
        struct FailingValidator;
        #[async_trait]
        impl Validator for FailingValidator {
            async fn validate(&self, _t: &str) -> Result<Validated, ServerError> {
                Err(ServerError::Identity("upstream down".into()))
            }
        }
        let v = ThrottlingValidator::new(FailingValidator);
        let err = v.validate("chan_pat_a").await.unwrap_err();
        assert!(matches!(err, ServerError::Identity(_)));
    }
}
