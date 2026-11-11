//! A CA and a leaf it signs, made at test time, and an in-memory rustls
//! handshake against a server presenting that leaf. The keys live in memory
//! for the test's life only; nothing here is written to the tree.
//!
//! The certificates are assembled as DER by hand and signed with ring, which
//! rustls already links, so the tests need no certificate-generation crate.
//! Each carries what WebPKI checks: X.509 v3, ECDSA P-256 with SHA-256, a
//! CA with `basicConstraints` and `keyCertSign`, and a leaf for `localhost`
//! and `127.0.0.1` with the `serverAuth` key purpose.

#![allow(dead_code)]

use std::sync::Arc;

use ring::rand::SystemRandom;
use ring::signature::{EcdsaKeyPair, KeyPair, ECDSA_P256_SHA256_ASN1_SIGNING};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer, ServerName};

/// A certificate and the PKCS#8 key it was issued for.
pub struct Issued {
    pub cert: CertificateDer<'static>,
    pub key: PrivateKeyDer<'static>,
    pair: EcdsaKeyPair,
    subject: Vec<u8>,
}

impl Issued {
    /// The certificate as one PEM block, the shape a CA bundle holds.
    pub fn pem(&self) -> String {
        let body = base64(self.cert.as_ref());
        let mut pem = String::from("-----BEGIN CERTIFICATE-----\n");
        for line in body.as_bytes().chunks(64) {
            pem.push_str(std::str::from_utf8(line).unwrap());
            pem.push('\n');
        }
        pem.push_str("-----END CERTIFICATE-----\n");
        pem
    }
}

/// A self-signed CA no trust store holds.
pub fn ca(name: &str) -> Issued {
    let (pair, pkcs8) = key_pair();
    let subject = common_name(name);
    let extensions = [
        // basicConstraints, critical: cA TRUE.
        extension(OID_BASIC_CONSTRAINTS, true, &seq(&tlv(0x01, &[0xff]))),
        // keyUsage, critical: keyCertSign and cRLSign.
        extension(OID_KEY_USAGE, true, &tlv(0x03, &[0x01, 0x06])),
    ]
    .concat();
    let cert = sign(&pair, &tbs(1, &subject, &subject, &pair, &extensions));
    finish(cert, pair, pkcs8, subject)
}

/// A leaf for `localhost` and `127.0.0.1`, signed by `ca`.
pub fn leaf(ca: &Issued) -> Issued {
    let (pair, pkcs8) = key_pair();
    let subject = common_name("localhost");
    let names = [tlv(0x82, b"localhost"), tlv(0x87, &[127, 0, 0, 1])].concat();
    let extensions = [
        // basicConstraints, critical: not a CA.
        extension(OID_BASIC_CONSTRAINTS, true, &seq(&[])),
        // keyUsage, critical: digitalSignature.
        extension(OID_KEY_USAGE, true, &tlv(0x03, &[0x07, 0x80])),
        extension(OID_EXT_KEY_USAGE, false, &seq(&oid(OID_SERVER_AUTH))),
        extension(OID_SUBJECT_ALT_NAME, false, &seq(&names)),
    ]
    .concat();
    let cert = sign(&ca.pair, &tbs(2, &ca.subject, &subject, &pair, &extensions));
    finish(cert, pair, pkcs8, subject)
}

/// Run a full handshake in memory between a client on `client` and a server
/// presenting `leaf`, for `localhost`. `Err` is the client's error; a server
/// error panics, since the server side here is fixed.
pub fn handshake(client: rustls::ClientConfig, leaf: &Issued) -> Result<(), rustls::Error> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let server = rustls::ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(vec![leaf.cert.clone()], leaf.key.clone_key())
        .expect("the server takes the leaf and its key");
    let name = ServerName::try_from("localhost").unwrap();
    let mut client =
        rustls::Connection::from(rustls::ClientConnection::new(Arc::new(client), name).unwrap());
    let mut server =
        rustls::Connection::from(rustls::ServerConnection::new(Arc::new(server)).unwrap());
    for _ in 0..16 {
        let to_server = take_tls(&mut client);
        if !to_server.is_empty() {
            give_tls(&mut server, &to_server);
            server
                .process_new_packets()
                .expect("the server accepts the client");
        }
        let to_client = take_tls(&mut server);
        if !to_client.is_empty() {
            give_tls(&mut client, &to_client);
            client.process_new_packets()?;
        }
        if !client.is_handshaking() && !server.is_handshaking() {
            return Ok(());
        }
    }
    panic!("the handshake made no progress");
}

fn take_tls(conn: &mut rustls::Connection) -> Vec<u8> {
    let mut out = Vec::new();
    while conn.wants_write() {
        conn.write_tls(&mut out).unwrap();
    }
    out
}

fn give_tls(conn: &mut rustls::Connection, mut bytes: &[u8]) {
    while !bytes.is_empty() {
        conn.read_tls(&mut bytes).unwrap();
    }
}

/// A fresh P-256 key pair and the PKCS#8 document it was parsed from, which
/// the server side loads.
fn key_pair() -> (EcdsaKeyPair, Vec<u8>) {
    let rng = SystemRandom::new();
    let pkcs8 = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, &rng).unwrap();
    let pair =
        EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, pkcs8.as_ref(), &rng).unwrap();
    (pair, pkcs8.as_ref().to_vec())
}

fn finish(cert: Vec<u8>, pair: EcdsaKeyPair, pkcs8: Vec<u8>, subject: Vec<u8>) -> Issued {
    Issued {
        cert: CertificateDer::from(cert),
        key: PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(pkcs8)),
        pair,
        subject,
    }
}

// DER encodings of the object identifiers used here.
const OID_ECDSA_SHA256: &[u8] = &[0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02];
const OID_EC_PUBLIC_KEY: &[u8] = &[0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01];
const OID_P256: &[u8] = &[0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07];
const OID_COMMON_NAME: &[u8] = &[0x55, 0x04, 0x03];
const OID_BASIC_CONSTRAINTS: &[u8] = &[0x55, 0x1d, 0x13];
const OID_KEY_USAGE: &[u8] = &[0x55, 0x1d, 0x0f];
const OID_EXT_KEY_USAGE: &[u8] = &[0x55, 0x1d, 0x25];
const OID_SUBJECT_ALT_NAME: &[u8] = &[0x55, 0x1d, 0x11];
const OID_SERVER_AUTH: &[u8] = &[0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x01];

/// TBSCertificate (RFC 5280 section 4.1).
fn tbs(
    serial: u8,
    issuer: &[u8],
    subject: &[u8],
    pair: &EcdsaKeyPair,
    extensions: &[u8],
) -> Vec<u8> {
    let public_key = [&[0u8][..], pair.public_key().as_ref()].concat();
    let spki = seq(&[
        seq(&[oid(OID_EC_PUBLIC_KEY), oid(OID_P256)].concat()),
        tlv(0x03, &public_key),
    ]
    .concat());
    // UTCTime before 2050, GeneralizedTime after, as RFC 5280 asks.
    let validity = seq(&[tlv(0x17, b"250101000000Z"), tlv(0x18, b"20991231235959Z")].concat());
    seq(&[
        tlv(0xa0, &tlv(0x02, &[0x02])), // version v3
        tlv(0x02, &[serial]),
        seq(&oid(OID_ECDSA_SHA256)),
        issuer.to_vec(),
        validity,
        subject.to_vec(),
        spki,
        tlv(0xa3, &seq(extensions)),
    ]
    .concat())
}

fn sign(by: &EcdsaKeyPair, tbs: &[u8]) -> Vec<u8> {
    let signature = by.sign(&SystemRandom::new(), tbs).unwrap();
    let bits = [&[0u8][..], signature.as_ref()].concat();
    seq(&[tbs.to_vec(), seq(&oid(OID_ECDSA_SHA256)), tlv(0x03, &bits)].concat())
}

fn common_name(name: &str) -> Vec<u8> {
    seq(&tlv(
        0x31,
        &seq(&[oid(OID_COMMON_NAME), tlv(0x0c, name.as_bytes())].concat()),
    ))
}

fn extension(id: &[u8], critical: bool, value: &[u8]) -> Vec<u8> {
    let mut body = oid(id);
    if critical {
        body.extend(tlv(0x01, &[0xff]));
    }
    body.extend(tlv(0x04, value));
    seq(&body)
}

fn oid(id: &[u8]) -> Vec<u8> {
    tlv(0x06, id)
}

fn seq(content: &[u8]) -> Vec<u8> {
    tlv(0x30, content)
}

fn tlv(tag: u8, content: &[u8]) -> Vec<u8> {
    let mut out = vec![tag];
    match content.len() {
        n if n < 0x80 => out.push(n as u8),
        n if n < 0x100 => out.extend([0x81, n as u8]),
        n => out.extend([0x82, (n >> 8) as u8, n as u8]),
    }
    out.extend_from_slice(content);
    out
}

fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(ALPHABET[(n >> (18 - 6 * i)) as usize & 63] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}
