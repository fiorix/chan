//! One transfer-error helper the gateway and devserver legs share.

/// A transfer request's error as the page may show and keep it: what
/// failed, down to the cause the system gave, without the request URL.
/// The page builds that URL, and on the loopback surface it carries
/// the tenant's bearer token in its `t` query, while reqwest's own
/// Display names the URL and stops before the cause.
pub fn reason_without_url(error: reqwest::Error) -> String {
    let error = error.without_url();
    let mut reason = error.to_string();
    let mut cause = std::error::Error::source(&error);
    while let Some(next) = cause {
        reason.push_str(": ");
        reason.push_str(&next.to_string());
        cause = next.source();
    }
    reason
}
