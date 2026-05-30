use serde::Serialize;

pub const MCP_PROXY_PRELUDE_PREFIX: &str = "CHAN-MCP-PROXY ";
pub const MCP_PROXY_PRELUDE_VERSION: &str = "1";

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct TeamWorkIdentity {
    pub team: Option<String>,
    pub agent: Option<String>,
}

impl TeamWorkIdentity {
    pub fn new(team: Option<String>, agent: Option<String>) -> Self {
        Self { team, agent }
    }

    pub fn validated(team: &str, agent: &str) -> Result<Self, String> {
        Ok(Self {
            team: Some(canonical_team_name(team)?),
            agent: Some(canonical_agent_handle(agent)?),
        })
    }
}

#[derive(Debug, Serialize)]
struct ProxyPreludePayload<'a> {
    team: &'a str,
    agent: &'a str,
}

pub fn canonical_agent_handle(value: &str) -> Result<String, String> {
    let Some(rest) = value.strip_prefix("@@") else {
        return Err("agent handle must start with @@".into());
    };
    if rest.is_empty() {
        return Err("agent handle name must be non-empty".into());
    }
    if !rest.bytes().all(is_identity_byte) {
        return Err("agent handle must match @@[A-Za-z0-9_-]+".into());
    }
    Ok(value.to_string())
}

pub fn canonical_team_name(value: &str) -> Result<String, String> {
    if value.is_empty() {
        return Err("team name must be non-empty".into());
    }
    if !value.bytes().all(is_identity_byte) {
        return Err("team name must match [A-Za-z0-9_-]+".into());
    }
    Ok(value.to_string())
}

pub fn proxy_prelude_line(team: &str, agent: &str) -> Result<String, String> {
    let team = canonical_team_name(team)?;
    let agent = canonical_agent_handle(agent)?;
    let payload = serde_json::to_string(&ProxyPreludePayload {
        team: &team,
        agent: &agent,
    })
    .map_err(|e| format!("serialize proxy prelude: {e}"))?;
    Ok(format!(
        "{MCP_PROXY_PRELUDE_PREFIX}{MCP_PROXY_PRELUDE_VERSION} {payload}\n"
    ))
}

pub fn parse_proxy_prelude(line: &str) -> Result<TeamWorkIdentity, String> {
    let line = line.trim_end_matches(['\r', '\n']);
    let Some(rest) = line.strip_prefix(MCP_PROXY_PRELUDE_PREFIX) else {
        return Err("missing proxy prelude prefix".into());
    };
    let Some(payload) = rest.strip_prefix("1 ") else {
        return Err("unsupported proxy prelude version".into());
    };
    let value: serde_json::Value =
        serde_json::from_str(payload).map_err(|e| format!("invalid proxy prelude json: {e}"))?;
    let object = value
        .as_object()
        .ok_or_else(|| "proxy prelude payload must be an object".to_string())?;
    if object.len() != 2 || !object.contains_key("team") || !object.contains_key("agent") {
        return Err("proxy prelude payload must contain only team and agent".into());
    }
    let team = object
        .get("team")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "proxy prelude team must be a string".to_string())?;
    let agent = object
        .get("agent")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "proxy prelude agent must be a string".to_string())?;
    TeamWorkIdentity::validated(team, agent)
}

pub fn is_proxy_prelude_attempt(line: &str) -> bool {
    line.starts_with(MCP_PROXY_PRELUDE_PREFIX)
}

fn is_identity_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-'
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_agent_handles_are_strict() {
        assert_eq!(
            canonical_agent_handle("@@FullStackA").unwrap(),
            "@@FullStackA"
        );
        assert_eq!(
            canonical_agent_handle("@@worker_1-2").unwrap(),
            "@@worker_1-2"
        );

        for value in [
            "",
            "FullStackA",
            "@@",
            "@@Full Stack",
            "@@Full/Stack",
            "@@\nA",
        ] {
            assert!(
                canonical_agent_handle(value).is_err(),
                "{value:?} should fail"
            );
        }
    }

    #[test]
    fn team_names_are_case_sensitive_ascii_ids() {
        assert_eq!(canonical_team_name("alpha").unwrap(), "alpha");
        assert_eq!(canonical_team_name("Alpha_1-2").unwrap(), "Alpha_1-2");
        assert_ne!(
            canonical_team_name("alpha").unwrap(),
            canonical_team_name("Alpha").unwrap()
        );

        for value in ["", "team alpha", "team/alpha", "alpha\n", "å"] {
            assert!(canonical_team_name(value).is_err(), "{value:?} should fail");
        }
    }

    #[test]
    fn proxy_prelude_round_trips_strict_schema() {
        let line = proxy_prelude_line("alpha", "@@FullStackA").unwrap();
        assert_eq!(
            line,
            "CHAN-MCP-PROXY 1 {\"team\":\"alpha\",\"agent\":\"@@FullStackA\"}\n"
        );

        let identity = parse_proxy_prelude(&line).unwrap();
        assert_eq!(identity.team.as_deref(), Some("alpha"));
        assert_eq!(identity.agent.as_deref(), Some("@@FullStackA"));

        for line in [
            "CHAN-MCP-PROXY 2 {\"team\":\"alpha\",\"agent\":\"@@FullStackA\"}\n",
            "CHAN-MCP-PROXY 1 {\"team\":\"alpha\",\"agent\":\"@@FullStackA\",\"x\":1}\n",
            "CHAN-MCP-PROXY 1 {\"team\":\"bad team\",\"agent\":\"@@FullStackA\"}\n",
            "CHAN-MCP-PROXY 1 {\"team\":\"alpha\",\"agent\":\"FullStackA\"}\n",
        ] {
            assert!(parse_proxy_prelude(line).is_err(), "{line:?} should fail");
        }
    }
}
