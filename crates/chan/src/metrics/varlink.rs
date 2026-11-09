use anyhow::{Context, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};

use super::Client;

const INTERFACE: &str = "io.chan.Metrics";
const IDL: &str = include_str!("io.chan.Metrics.varlink");
const SERVICE_IDL: &str = "interface org.varlink.service\nmethod GetInfo() -> (vendor: string, product: string, version: string, url: string, interfaces: []string)\nmethod GetInterfaceDescription(interface: string) -> (description: string)\nerror InterfaceNotFound(interface: string)\nerror MethodNotFound(method: string)\nerror MethodNotImplemented(method: string)\nerror InvalidParameter(parameter: string)\n";
const MAX_FRAME: u64 = 65536;

#[derive(Deserialize)]
struct Call {
    method: String,
    #[serde(default = "empty_object")]
    parameters: Value,
    #[serde(default)]
    more: bool,
    #[serde(default)]
    oneway: bool,
    #[serde(default)]
    upgrade: bool,
}
fn empty_object() -> Value {
    json!({})
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct Get {
    history: Option<bool>,
    since: Option<u64>,
}

fn error(name: &str, parameters: Value) -> Value {
    json!({"error": name, "parameters": parameters})
}
fn invalid(parameter: &str) -> Value {
    error(
        "org.varlink.service.InvalidParameter",
        json!({"parameter": parameter}),
    )
}

async fn write_frame(output: &mut (impl AsyncWrite + Unpin), value: &Value) -> Result<()> {
    let mut frame = serde_json::to_vec(value)?;
    frame.push(0);
    tokio::time::timeout(Duration::from_secs(10), async {
        output.write_all(&frame).await?;
        output.flush().await
    })
    .await
    .context("Varlink client stopped reading")??;
    Ok(())
}

pub(super) async fn serve(
    client: Client,
    input: impl AsyncRead + Unpin,
    mut output: impl AsyncWrite + Unpin,
) -> Result<()> {
    let mut input = BufReader::new(input);
    loop {
        let mut frame = Vec::new();
        let size = tokio::time::timeout(
            Duration::from_secs(60),
            (&mut input).take(MAX_FRAME + 1).read_until(0, &mut frame),
        )
        .await
        .context("Varlink client idle timeout")??;
        if size == 0 {
            return Ok(());
        }
        anyhow::ensure!(
            size as u64 <= MAX_FRAME && frame.last() == Some(&0),
            "invalid Varlink frame length"
        );
        let call: Call =
            serde_json::from_slice(&frame[..size - 1]).context("invalid Varlink call")?;
        let (reply, get) = dispatch(&call);
        if call.oneway {
            continue;
        }
        if let Some(reply) = reply {
            write_frame(&mut output, &reply).await?;
            continue;
        }
        let get = get.context("missing Get parameters")?;
        loop {
            let reply = match client.read(get.history.unwrap_or(false), get.since).await {
                Ok(metrics) => {
                    let mut reply = json!({"parameters": {"metrics": metrics}});
                    if call.more {
                        reply["continues"] = true.into();
                    }
                    reply
                }
                Err(error) => {
                    tracing::debug!(%error, "Varlink metrics source unavailable");
                    write_frame(
                        &mut output,
                        &self::error("io.chan.Metrics.Unavailable", json!({})),
                    )
                    .await?;
                    break;
                }
            };
            write_frame(&mut output, &reply).await?;
            if !call.more {
                break;
            }
            // EOF during a streaming call should release the activated service
            // immediately, rather than waiting for a write timeout.
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(1)) => {},
                incoming = input.fill_buf() => {
                    if incoming?.is_empty() { return Ok(()); }
                    anyhow::bail!("another call arrived during a streaming call");
                }
            }
        }
    }
}

fn dispatch(call: &Call) -> (Option<Value>, Option<Get>) {
    let reply = if call.upgrade {
        invalid("upgrade")
    } else if !call.parameters.is_object() {
        invalid("parameters")
    } else {
        match call.method.as_str() {
            "org.varlink.service.GetInfo"
                if call.parameters.as_object().is_some_and(|p| p.is_empty()) =>
            {
                json!({"parameters": {
                    "vendor": "chan", "product": "chan metrics", "version": env!("CARGO_PKG_VERSION"),
                    "url": "https://chan.app", "interfaces": [INTERFACE]
                }})
            }
            "org.varlink.service.GetInterfaceDescription" => {
                let interface = call.parameters.get("interface").and_then(Value::as_str);
                match interface {
                    Some(INTERFACE) => json!({"parameters": {"description": IDL}}),
                    Some("org.varlink.service") => {
                        json!({"parameters": {"description": SERVICE_IDL}})
                    }
                    Some(name) => error(
                        "org.varlink.service.InterfaceNotFound",
                        json!({"interface": name}),
                    ),
                    None => invalid("interface"),
                }
            }
            "io.chan.Metrics.Get" => match serde_json::from_value(call.parameters.clone()) {
                Ok(get) => return (None, Some(get)),
                Err(_) => invalid("parameters"),
            },
            "org.varlink.service.GetInfo" => invalid("parameters"),
            method => {
                let (interface, name) = method.rsplit_once('.').unwrap_or((method, ""));
                if matches!(interface, INTERFACE | "org.varlink.service") {
                    error(
                        "org.varlink.service.MethodNotFound",
                        json!({"method": name}),
                    )
                } else {
                    error(
                        "org.varlink.service.InterfaceNotFound",
                        json!({"interface": interface}),
                    )
                }
            }
        }
    };
    (Some(reply), None)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn call(method: &str, parameters: Value) -> Call {
        Call {
            method: method.into(),
            parameters,
            more: false,
            oneway: false,
            upgrade: false,
        }
    }
    #[test]
    fn introspection_and_errors_follow_the_varlink_contract() {
        assert_eq!(
            dispatch(&call("org.varlink.service.GetInfo", json!({})))
                .0
                .unwrap()["parameters"]["interfaces"],
            json!([INTERFACE])
        );
        assert_eq!(
            dispatch(&call(
                "org.varlink.service.GetInterfaceDescription",
                json!({"interface":INTERFACE})
            ))
            .0
            .unwrap()["parameters"]["description"],
            IDL
        );
        assert!(dispatch(&call(
            "io.chan.Metrics.Get",
            json!({"history":true,"since":2})
        ))
        .1
        .is_some());
        assert_eq!(
            dispatch(&call("io.chan.Metrics.Get", json!({"since":-1})))
                .0
                .unwrap()["error"],
            "org.varlink.service.InvalidParameter"
        );
        assert_eq!(
            dispatch(&call("io.chan.Metrics.Nope", json!({})))
                .0
                .unwrap()["error"],
            "org.varlink.service.MethodNotFound"
        );
    }
}
