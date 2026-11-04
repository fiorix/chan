// Copyright (c) 2019 Cloudflare, Inc. All rights reserved.
// SPDX-License-Identifier: BSD-3-Clause

use std::fmt;

/// A protocol-level failure: a packet that does not authenticate, does not
/// parse, or arrives in a state that cannot use it, or a tunnel that has
/// given up on its peer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WireGuardError {
    DestinationBufferTooSmall,
    IncorrectPacketLength,
    UnexpectedPacket,
    WrongPacketType,
    WrongIndex,
    WrongKey,
    InvalidTai64nTimestamp,
    WrongTai64nTimestamp,
    InvalidMac,
    InvalidAeadTag,
    InvalidCounter,
    DuplicateCounter,
    InvalidPacket,
    NoCurrentSession,
    LockFailed,
    ConnectionExpired,
    UnderLoad,
}

impl fmt::Display for WireGuardError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let text = match self {
            Self::DestinationBufferTooSmall => "destination buffer too small",
            Self::IncorrectPacketLength => "incorrect packet length",
            Self::UnexpectedPacket => "unexpected packet for the handshake state",
            Self::WrongPacketType => "wrong packet type",
            Self::WrongIndex => "packet names an index this tunnel does not hold",
            Self::WrongKey => "the peer's static key is not the configured one",
            Self::InvalidTai64nTimestamp => "invalid TAI64N timestamp",
            Self::WrongTai64nTimestamp => "handshake timestamp is not newer than the last",
            Self::InvalidMac => "invalid mac1",
            Self::InvalidAeadTag => "AEAD authentication failed",
            Self::InvalidCounter => "counter outside the replay window",
            Self::DuplicateCounter => "counter already received",
            Self::InvalidPacket => "invalid packet",
            Self::NoCurrentSession => "no session for this packet",
            Self::LockFailed => "lock failed",
            Self::ConnectionExpired => "the connection expired",
            Self::UnderLoad => "under load and the source address is unknown",
        };
        f.write_str(text)
    }
}

impl std::error::Error for WireGuardError {}
