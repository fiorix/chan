//! Async helpers for Hello/HelloAck and admission-lease refresh control frames.
//!
//! The wire codec in `frame.rs` is sync and operates on a
//! `BytesMut` so callers can drive it from any I/O loop. In
//! practice both sides of the tunnel run on tokio, so a pair of
//! tiny `read_frame` / `write_frame` helpers is enough; nothing in
//! the protocol needs streaming control frames.

use bytes::BytesMut;
use serde::{de::DeserializeOwned, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use crate::frame::{decode_frame, encode_frame, FrameError};
use crate::MAX_CONTROL_FRAME_BYTES;

#[derive(Debug, thiserror::Error)]
pub enum IoFrameError {
    #[error("frame: {0}")]
    Frame(#[from] FrameError),

    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

/// Read one length-prefixed JSON frame from `r`. Used for the initial
/// Hello/HelloAck exchange before yamux and for admission-lease refresh
/// frames on yamux substreams. A declared payload above
/// `MAX_CONTROL_FRAME_BYTES` is rejected before reading the payload.
pub async fn read_frame<R, T>(r: &mut R) -> Result<T, IoFrameError>
where
    R: AsyncRead + Unpin,
    T: DeserializeOwned,
{
    let mut len_buf = [0u8; 4];
    r.read_exact(&mut len_buf).await?;
    let len = u32::from_be_bytes(len_buf) as usize;
    if len > MAX_CONTROL_FRAME_BYTES {
        return Err(FrameError::TooLarge(len as u32).into());
    }
    let mut buf = BytesMut::with_capacity(4 + len);
    buf.extend_from_slice(&len_buf);
    buf.resize(4 + len, 0);
    r.read_exact(&mut buf[4..]).await?;
    Ok(decode_frame(&mut buf)?)
}

/// Write one length-prefixed JSON frame to `w` and flush.
pub async fn write_frame<W, T>(w: &mut W, value: &T) -> Result<(), IoFrameError>
where
    W: AsyncWrite + Unpin,
    T: Serialize,
{
    let mut buf = BytesMut::new();
    encode_frame(value, &mut buf)?;
    w.write_all(&buf).await?;
    w.flush().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Hello, ProtocolVersion};

    #[tokio::test]
    async fn roundtrip_over_duplex() {
        let (mut a, mut b) = tokio::io::duplex(1024);
        let h = Hello {
            protocol: ProtocolVersion::V1,
            client_version: "chan/test".into(),
            workspace: "notes".into(),
            name: None,
        };
        write_frame(&mut a, &h).await.unwrap();
        let got: Hello = read_frame(&mut b).await.unwrap();
        assert_eq!(got.client_version, "chan/test");
        assert_eq!(got.workspace, "notes");
    }
}
