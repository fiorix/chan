//! Google OAuth2 (OIDC) provider.
//!
//! Standard OIDC: authorize -> token exchange -> userinfo. We pull
//! `sub` (the stable Google account id), email + verified flag, and
//! optional `name`, passed through as the display name without an email fallback.

use async_trait::async_trait;
use oauth2::basic::BasicClient;
use oauth2::reqwest::async_http_client;
use oauth2::{
    AuthUrl, AuthorizationCode, ClientId, ClientSecret, CsrfToken, PkceCodeChallenge,
    PkceCodeVerifier, RedirectUrl, Scope, TokenResponse, TokenUrl,
};
use reqwest::header;
use serde::Deserialize;
use url::Url;

use crate::error::{Error, Result};
use crate::providers::{Provider, UserInfo, OAUTH_EXCHANGE_TIMEOUT};

const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const USERINFO_URL: &str = "https://openidconnect.googleapis.com/v1/userinfo";

#[derive(Clone)]
pub struct GoogleEndpoints {
    pub auth: String,
    pub token: String,
    pub userinfo: String,
}

impl Default for GoogleEndpoints {
    fn default() -> Self {
        Self {
            auth: AUTH_URL.into(),
            token: TOKEN_URL.into(),
            userinfo: USERINFO_URL.into(),
        }
    }
}

#[derive(Clone)]
pub struct GoogleProvider {
    client_id: ClientId,
    client_secret: ClientSecret,
    endpoints: GoogleEndpoints,
    http: reqwest::Client,
}

impl GoogleProvider {
    pub fn new(client_id: String, client_secret: String) -> anyhow::Result<Self> {
        Self::with_endpoints(client_id, client_secret, GoogleEndpoints::default())
    }

    pub fn with_endpoints(
        client_id: String,
        client_secret: String,
        endpoints: GoogleEndpoints,
    ) -> anyhow::Result<Self> {
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .connect_timeout(std::time::Duration::from_secs(2))
            .build()?;
        Ok(Self {
            client_id: ClientId::new(client_id),
            client_secret: ClientSecret::new(client_secret),
            endpoints,
            http,
        })
    }

    fn oauth_client(&self, redirect_uri: &Url) -> anyhow::Result<BasicClient> {
        Ok(BasicClient::new(
            self.client_id.clone(),
            Some(self.client_secret.clone()),
            AuthUrl::new(self.endpoints.auth.clone())?,
            Some(TokenUrl::new(self.endpoints.token.clone())?),
        )
        .set_redirect_uri(RedirectUrl::new(redirect_uri.to_string())?))
    }
}

#[async_trait]
impl Provider for GoogleProvider {
    fn name(&self) -> &'static str {
        "google"
    }

    fn authorize_url(&self, redirect_uri: &Url) -> Result<(Url, CsrfToken, PkceCodeVerifier)> {
        let client = self.oauth_client(redirect_uri).map_err(Error::Anyhow)?;
        let (challenge, verifier) = PkceCodeChallenge::new_random_sha256();
        let (url, csrf) = client
            .authorize_url(CsrfToken::new_random)
            .add_scope(Scope::new("openid".into()))
            .add_scope(Scope::new("email".into()))
            .add_scope(Scope::new("profile".into()))
            .set_pkce_challenge(challenge)
            .url();
        Ok((url, csrf, verifier))
    }

    async fn exchange(
        &self,
        code: &str,
        verifier: PkceCodeVerifier,
        redirect_uri: &Url,
    ) -> Result<UserInfo> {
        let client = self.oauth_client(redirect_uri).map_err(Error::Anyhow)?;
        let exchange = client
            .exchange_code(AuthorizationCode::new(code.to_string()))
            .set_pkce_verifier(verifier)
            .request_async(async_http_client);
        let token = tokio::time::timeout(OAUTH_EXCHANGE_TIMEOUT, exchange)
            .await
            .map_err(|_| {
                tracing::warn!("google token exchange timed out");
                Error::Upstream("oauth token exchange".to_string())
            })?
            .map_err(|e| {
                tracing::warn!(error = ?e, "google token exchange failed");
                Error::Upstream("oauth token exchange".to_string())
            })?;
        let access = token.access_token().secret();

        let info: GUserInfo = self
            .http
            .get(&self.endpoints.userinfo)
            .header(header::AUTHORIZATION, format!("Bearer {access}"))
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;

        // Ignore unverified emails: we treat email as the join key
        // for identity-linking. Without verification we can't trust it.
        let email = info
            .email_verified
            .unwrap_or(false)
            .then_some(info.email)
            .flatten();

        Ok(UserInfo {
            provider_subject: info.sub,
            email,
            display_name: info.name,
            picture_url: info.picture,
        })
    }
}

#[derive(Debug, Deserialize)]
struct GUserInfo {
    sub: String,
    email: Option<String>,
    email_verified: Option<bool>,
    name: Option<String>,
    picture: Option<String>,
}
