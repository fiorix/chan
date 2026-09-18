//! profile-service: internal HTTP API in front of Postgres.
//!
//! Owns the canonical user record, linked OAuth identities, devservers
//! and sharing grants, durable per-user and fleet devserver policy,
//! feature flags, and the auth audit log. Called only by
//! identity-service and the operator CLI; not exposed publicly. Auth is
//! a shared bearer token (`PROFILE_AUTH_TOKEN` for the service tier,
//! `PROFILE_ADMIN_TOKEN` for `/v1/admin/*`).

pub mod config;
pub mod db;
pub mod error;
pub mod http;
pub mod models;
pub mod revocation;
pub mod sweeper;

pub use config::Config;
pub use error::{Error, Result};
