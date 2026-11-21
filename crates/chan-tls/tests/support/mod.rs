//! The library's CA and leaf generator, `chan_tls::testing::pki`, built
//! into each integration test: those link the library without its
//! test-support feature.

#![allow(dead_code)]

#[path = "../../src/testing/pki.rs"]
mod pki;

pub use pki::*;
