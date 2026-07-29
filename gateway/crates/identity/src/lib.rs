//! identity-service: OAuth2 sign-in and session for the gateway identity origin (gw.{domain}).
//!
//! Owns the auth-artifact tables in Postgres directly
//! (`tower_sessions`, `api_tokens` and their audit log). User /
//! identity / workspace data goes through profile-service over HTTP.
//! The SPA at `web/` is embedded at build time and served by the
//! same binary.

pub mod api_tokens;
pub mod config;
pub mod desktop_authorize;
pub mod desktop_roster;
pub mod devserver_authority;
pub mod devserver_control_client;
pub mod error;
pub mod http;
pub mod pages;
pub mod profile_client;
pub mod providers;
pub mod static_files;
pub mod token_throttle;

pub use config::Config;
pub use error::{Error, Result};
