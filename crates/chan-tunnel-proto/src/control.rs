//! Control frames exchanged once before yamux takes over.

use serde::{Deserialize, Serialize};

/// Wire-format protocol version. Bumped only on incompatible
/// changes; additive fields are tolerated via `#[serde(default)]`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ProtocolVersion(pub u16);

impl ProtocolVersion {
    pub const V1: ProtocolVersion = ProtocolVersion(1);
}

/// First frame, client -> server. Sent right after the HTTP/2
/// stream opens. The token in the `Authorization` header
/// authenticates the caller. This frame also carries a workspace
/// name, but the production gateway resolves the devserver identity
/// from the token and ignores the value: `chan devserver` sends the
/// fixed placeholder `"devserver"`, and one registration carries the
/// caller's whole library. The field stays in the wire type so the
/// protocol itself is workspace-agnostic.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Hello {
    pub protocol: ProtocolVersion,
    /// chan version string (e.g. "chan/0.4.0"). Server-side logs
    /// only; not used for routing.
    pub client_version: String,
    /// Workspace name to register under. Devserver registrations send
    /// a fixed placeholder; the gateway keys the registration on the
    /// token-resolved devserver identity, not this value.
    pub workspace: String,
    /// Display name the devserver announces for the gateway roster
    /// (`--tunnel-devserver-name`, defaulting to the client host's
    /// hostname). Additive field: old clients omit it (decodes as
    /// `None` via the default) and old servers ignore it, so there is
    /// no protocol bump. The gateway persists it as the devserver's
    /// label, deduped per owner; it never affects routing.
    #[serde(default)]
    pub name: Option<String>,
}

/// First frame, server -> client. Either confirms the
/// registration and tells the client where on the public host its
/// workspace will be served, or refuses the handshake with a
/// structured reason so the client can render something better
/// than "transport closed".
///
/// Pre-audit the refusal case was a bare transport disconnect
/// after the 200 response; clients could not distinguish
/// "TooManyWorkspaces" from "TLS reset". The tagged enum gives the
/// server one place to write a structured refusal in the same
/// stream the success ack would have used.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum HelloAck {
    /// Registration accepted; carries the assigned public path
    /// prefix the client uses to wire its router.
    Ok(HelloAckOk),
    /// Registration refused after the token + Hello were
    /// validated; carries a stable `code` for client-side matching
    /// plus a human-readable `message`.
    Refused(HelloAckErr),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HelloAckOk {
    pub protocol: ProtocolVersion,
    /// Public path prefix on the gateway's wildcard subdomain.
    /// Shape: `/{devserver_id}` (one leading slash, no trailing
    /// slash). The owner lives in the tenant host
    /// (`{owner}--{disc}.{proxy}.usr.{domain}`), not in the path;
    /// the devserver client ignores this value (each tenant
    /// self-prefixes at its keyed pathspec).
    pub prefix: String,
    pub user: String,
    pub workspace: String,
    /// Immutable owner id resolved from the validated tunnel PAT.
    pub owner_user_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HelloAckErr {
    pub protocol: ProtocolVersion,
    /// Stable, machine-readable refusal code. Clients match on
    /// these to produce specific UI; see `error_code` constants.
    pub code: String,
    /// Human-readable, operator-visible. Safe to log and surface
    /// to the user.
    pub message: String,
}

/// Stable refusal codes emitted by the server in `HelloAckErr.code`.
/// Add new codes here when introducing new pre-ack-stage failure
/// shapes; clients should fall back to a generic surface for codes
/// they do not recognise so the protocol stays additive.
pub mod error_code {
    /// The authoritative fleet admission service is unavailable or warming.
    pub const CONTROL_UNAVAILABLE: &str = "control_unavailable";
    /// Registering this workspace would exceed the per-user cap.
    pub const TOO_MANY_WORKSPACES: &str = "too_many_workspaces";
    /// `Hello.workspace` failed `is_valid_workspace_name`.
    pub const INVALID_WORKSPACE_NAME: &str = "invalid_workspace_name";
    /// `Hello.protocol` did not match the server's supported
    /// version; written in-band before the stream closes.
    pub const UNSUPPORTED_PROTOCOL: &str = "unsupported_protocol";
    /// Catch-all for refusals the client doesn't have a specific
    /// branch for. Treat the `message` as the only useful payload.
    pub const INTERNAL: &str = "internal";
}

#[cfg(test)]
mod wire_tests {
    use super::*;
    use serde_json::json;

    // Control frames cross the wire as JSON (`frame::encode_frame` uses
    // serde_json), so `to_value` pins the EXACT on-wire bytes. A field
    // add/drop/rename is caught here -- the gate-blind-wire hazard the
    // always-authenticated cut had to clear. The load-bearing pin is that
    // `Hello` carries NO `public` key after the cut.
    #[test]
    fn hello_wire_has_no_public_field() {
        let hello = Hello {
            protocol: ProtocolVersion::V1,
            client_version: "chan/test".into(),
            workspace: "notes".into(),
            name: Some("office-box".into()),
        };
        assert_eq!(
            serde_json::to_value(&hello).unwrap(),
            json!({
                "protocol": 1,
                "client_version": "chan/test",
                "workspace": "notes",
                "name": "office-box",
            })
        );
    }

    // A legacy client that still sends `public` must not break the post-drop
    // server: serde ignores the now-unknown field and the rest decodes. (Pre-
    // release there are no mixed-version peers, but this pins the tolerance so
    // the cut can never wedge a handshake on a stray field.)
    #[test]
    fn hello_decode_ignores_legacy_public_field() {
        let legacy = json!({
            "protocol": 1,
            "client_version": "chan/old",
            "workspace": "notes",
            "public": true,
        });
        let hello: Hello = serde_json::from_value(legacy).unwrap();
        assert_eq!(hello.workspace, "notes");
        assert_eq!(hello.client_version, "chan/old");
    }

    // A pre-name client's Hello (no `name` key) decodes with `name: None`
    // on a new server -- the additive-field tolerance the name feature
    // rides on (no protocol bump).
    #[test]
    fn hello_decode_without_name_is_none() {
        let old = json!({
            "protocol": 1,
            "client_version": "chan/old",
            "workspace": "notes",
        });
        let hello: Hello = serde_json::from_value(old).unwrap();
        assert_eq!(hello.name, None);
        assert_eq!(hello.workspace, "notes");
    }

    // Full round-trip with a name: what a new client encodes, a new
    // server decodes verbatim.
    #[test]
    fn hello_name_round_trips() {
        let hello = Hello {
            protocol: ProtocolVersion::V1,
            client_version: "chan/test".into(),
            workspace: "notes".into(),
            name: Some("my box".into()),
        };
        let decoded: Hello = serde_json::from_value(serde_json::to_value(&hello).unwrap()).unwrap();
        assert_eq!(decoded.name.as_deref(), Some("my box"));
    }

    #[test]
    fn hello_ack_ok_wire() {
        let ack = HelloAck::Ok(HelloAckOk {
            protocol: ProtocolVersion::V1,
            prefix: "/notes".into(),
            user: "alice".into(),
            workspace: "notes".into(),
            owner_user_id: "11111111-1111-4111-8111-111111111111".into(),
        });
        assert_eq!(
            serde_json::to_value(&ack).unwrap(),
            json!({
                "kind": "ok",
                "protocol": 1,
                "prefix": "/notes",
                "user": "alice",
                "workspace": "notes",
                "owner_user_id": "11111111-1111-4111-8111-111111111111",
            })
        );
    }

    #[test]
    fn hello_ack_refused_wire() {
        let ack = HelloAck::Refused(HelloAckErr {
            protocol: ProtocolVersion::V1,
            code: error_code::TOO_MANY_WORKSPACES.into(),
            message: "user alice reached max concurrent workspaces (1)".into(),
        });
        assert_eq!(
            serde_json::to_value(&ack).unwrap(),
            json!({
                "kind": "refused",
                "protocol": 1,
                "code": "too_many_workspaces",
                "message": "user alice reached max concurrent workspaces (1)",
            })
        );
    }
}
