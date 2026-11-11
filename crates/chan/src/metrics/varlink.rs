use anyhow::{Context, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};

use super::{Source, Subscription};

const INTERFACE: &str = "io.chan.Metrics";
const IDL: &str = include_str!("io.chan.Metrics.varlink");
const SERVICE_IDL: &str = "interface org.varlink.service\n\
    method GetInfo() -> (vendor: string, product: string, version: string, \
    url: string, interfaces: []string)\n\
    method GetInterfaceDescription(interface: string) -> (description: string)\n\
    error InterfaceNotFound(interface: string)\n\
    error MethodNotFound(method: string)\n\
    error MethodNotImplemented(method: string)\n\
    error InvalidParameter(parameter: string)\n";
const MAX_FRAME: u64 = 65536;
/// How long a connection may wait for its client's next call.
const IDLE: Duration = Duration::from_secs(60);
/// How long one reply may wait on a client that is not reading.
const STALLED: Duration = Duration::from_secs(10);

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

/// Whether an I/O error says the client closed or lost its connection.
fn client_left(error: &std::io::Error) -> bool {
    use std::io::ErrorKind::{BrokenPipe, ConnectionAborted, ConnectionReset};
    matches!(
        error.kind(),
        BrokenPipe | ConnectionAborted | ConnectionReset
    )
}

/// Write one reply. False when the client is not there to read it: it
/// stalled past the write bound, or its connection is gone.
async fn write_frame(output: &mut (impl AsyncWrite + Unpin), value: &Value) -> Result<bool> {
    let mut frame = serde_json::to_vec(value)?;
    frame.push(0);
    let written = tokio::time::timeout(STALLED, async {
        output.write_all(&frame).await?;
        output.flush().await
    })
    .await;
    match written {
        Ok(Ok(())) => Ok(true),
        Err(_stalled) => {
            tracing::debug!("Varlink client stopped reading");
            Ok(false)
        }
        Ok(Err(error)) if client_left(&error) => Ok(false),
        Ok(Err(error)) => Err(error).context("cannot write the Varlink reply"),
    }
}

/// Serve one client's connection until it ends. How a client leaves is not
/// a failure of the adapter: closing, going quiet past the idle bound, and
/// no longer reading replies all end the connection with success, so an
/// activated instance exits 0. An error is a frame that breaks the protocol
/// or an I/O failure that is not the client's leaving.
pub(super) async fn serve(
    source: &impl Source,
    input: impl AsyncRead + Unpin,
    mut output: impl AsyncWrite + Unpin,
) -> Result<()> {
    let mut input = BufReader::new(input);
    loop {
        let mut frame = Vec::new();
        let read = tokio::time::timeout(
            IDLE,
            (&mut input).take(MAX_FRAME + 1).read_until(0, &mut frame),
        )
        .await;
        let size = match read {
            Err(_idle) => {
                tracing::debug!("Varlink client idle; closing its connection");
                return Ok(());
            }
            Ok(Err(error)) if client_left(&error) => return Ok(()),
            Ok(read) => read?,
        };
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
            if !write_frame(&mut output, &reply).await? {
                return Ok(());
            }
            continue;
        }
        let get = get.context("missing Get parameters")?;
        let mut stream = Subscription::new(get.history.unwrap_or(false), get.since);
        loop {
            let reply = match stream.next(source).await {
                Ok(Some(metrics)) => {
                    let mut reply = json!({"parameters": {"metrics": metrics}});
                    if call.more {
                        reply["continues"] = true.into();
                    }
                    Some(reply)
                }
                Ok(None) => None,
                Err(error) => {
                    tracing::debug!(%error, "Varlink metrics source unavailable");
                    let unavailable = self::error("io.chan.Metrics.Unavailable", json!({}));
                    if !write_frame(&mut output, &unavailable).await? {
                        return Ok(());
                    }
                    break;
                }
            };
            if let Some(reply) = reply {
                if !write_frame(&mut output, &reply).await? {
                    return Ok(());
                }
            }
            if !call.more {
                break;
            }
            // EOF during a streaming call should release the activated service
            // immediately, rather than waiting for a write timeout.
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(1)) => {},
                incoming = input.fill_buf() => match incoming {
                    Ok([]) => return Ok(()),
                    Ok(_) => anyhow::bail!("another call arrived during a streaming call"),
                    Err(error) if client_left(&error) => return Ok(()),
                    Err(error) => return Err(error.into()),
                },
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
    use chan_server::metrics::{Runtime, View};
    use std::sync::Arc;

    /// The runtime behind `/api/metrics`, read in process: its `since`
    /// filter is the route's.
    impl Source for Arc<Runtime> {
        async fn read(&self, history: bool, since: Option<u64>) -> Result<View> {
            Ok(self.view(history, since))
        }
    }

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

    /// Each type an interface description declares, with its fields' names
    /// and types in order.
    fn idl_types(idl: &str) -> std::collections::HashMap<String, Vec<(String, String)>> {
        let code: Vec<&str> = idl
            .lines()
            .filter(|line| !line.trim_start().starts_with('#'))
            .collect();
        let code = code.join("\n");
        code.split("\ntype ")
            .skip(1)
            .map(|declaration| {
                let (head, _) = declaration.split_once(')').expect("a closed field list");
                let (name, fields) = head.split_once('(').expect("an opened field list");
                let fields = fields
                    .split(',')
                    .map(|field| {
                        let (name, kind) = field.split_once(':').expect("name: type");
                        (name.trim().to_string(), kind.trim().to_string())
                    })
                    .collect();
                (name.trim().to_string(), fields)
            })
            .collect()
    }

    /// Where `value`, serialized by the server, and the type `name` the
    /// description declares for it differ, through every nested type.
    fn differences(
        types: &std::collections::HashMap<String, Vec<(String, String)>>,
        name: &str,
        value: &Value,
        out: &mut std::collections::BTreeSet<String>,
    ) {
        let fields = &types[name];
        let object = value.as_object().expect("a serialized struct");
        for key in object.keys() {
            if !fields.iter().any(|(field, _)| field == key) {
                out.insert(format!("{name}.{key} is serialized but not declared"));
            }
        }
        for (field, kind) in fields {
            let Some(value) = object.get(field) else {
                out.insert(format!("{name}.{field} is declared but not serialized"));
                continue;
            };
            let inner = kind.trim_start_matches('?').trim_start_matches("[]");
            let fits = match (inner, value) {
                (_, Value::Null) => {
                    out.insert(format!("{name}.{field} is null in the fixture"));
                    continue;
                }
                (_, Value::Array(items)) if kind.starts_with("[]") => {
                    assert!(!items.is_empty(), "{name}.{field} is empty in the fixture");
                    for item in items {
                        differences(types, inner, item, out);
                    }
                    continue;
                }
                (inner, value) if types.contains_key(inner) => {
                    differences(types, inner, value, out);
                    continue;
                }
                ("int", value) => value.is_u64() || value.is_i64(),
                ("float", value) => value.is_number(),
                ("string", value) => value.is_string(),
                ("bool", value) => value.is_boolean(),
                _ => false,
            };
            if !fits {
                out.insert(format!("{name}.{field} is declared {kind} but is {value}"));
            }
        }
    }

    #[test]
    fn the_interface_description_declares_what_the_server_serializes() {
        // Every optional part present, so every value is on the wire.
        let mut view = super::super::full_view();
        view.storage.error = Some("storage scan exceeded its bound".into());
        let view = serde_json::to_value(view).unwrap();
        let against = |idl: &str| {
            let mut out = std::collections::BTreeSet::new();
            differences(&idl_types(idl), "View", &view, &mut out);
            out.into_iter().collect::<Vec<_>>()
        };
        assert_eq!(against(IDL), Vec::<String>::new());
        // The comparison sees a field the description lacks, one it has and
        // the server does not send, and one declared as another type.
        let lacking = IDL.replace("tunnelDialFailures: int, ", "");
        let renamed = IDL.replace("scanMs: ?int", "scanMillis: ?int");
        let retyped = IDL.replace("cpuPercent: ?float", "cpuPercent: ?int");
        assert_eq!(
            [against(&lacking), against(&renamed), against(&retyped)],
            [
                vec!["Sample.tunnelDialFailures is serialized but not declared".to_string()],
                vec![
                    "Storage.scanMillis is declared but not serialized".to_string(),
                    "Storage.scanMs is serialized but not declared".to_string(),
                ],
                vec!["Process.cpuPercent is declared ?int but is 1.5".to_string()],
            ]
        );
    }

    /// A source for connections that end before any read.
    struct Unread;

    impl Source for Unread {
        async fn read(&self, _history: bool, _since: Option<u64>) -> Result<View> {
            panic!("no metrics read is expected")
        }
    }

    const GET_INFO: &[u8] = b"{\"method\":\"org.varlink.service.GetInfo\"}\0";

    #[tokio::test(start_paused = true)]
    async fn an_idle_client_ends_its_connection_without_an_error() {
        // Connected and silent: the client end stays open, so only the idle
        // bound can end the connection.
        let (client, server) = tokio::io::duplex(1024);
        let (input, output) = tokio::io::split(server);
        let started = tokio::time::Instant::now();
        let ended = serve(&Unread, input, output).await;
        assert!(
            ended.is_ok(),
            "an idle client ended the adapter as a failure: {ended:?}"
        );
        assert_eq!(started.elapsed(), Duration::from_secs(60));
        drop(client);
    }

    #[tokio::test(start_paused = true)]
    async fn a_client_that_stops_reading_ends_its_connection_without_an_error() {
        // A pipe smaller than one reply, and a client that never reads it:
        // the reply stalls until the write bound.
        let (mut client, server) = tokio::io::duplex(16);
        let (input, output) = tokio::io::split(server);
        let serving = tokio::spawn(async move { serve(&Unread, input, output).await });
        client.write_all(GET_INFO).await.unwrap();
        let ended = serving.await.unwrap();
        assert!(
            ended.is_ok(),
            "a client that stopped reading ended the adapter as a failure: {ended:?}"
        );
        drop(client);
    }

    #[tokio::test]
    async fn a_client_that_left_ends_its_connection_without_an_error() {
        // Gone before its reply could be written.
        let (mut client, server) = tokio::io::duplex(1024);
        client.write_all(GET_INFO).await.unwrap();
        drop(client);
        let (input, output) = tokio::io::split(server);
        let ended = serve(&Unread, input, output).await;
        assert!(
            ended.is_ok(),
            "a client that left ended the adapter as a failure: {ended:?}"
        );
        // Gone with its connection reset, as a killed client leaves it.
        struct Reset;
        impl AsyncRead for Reset {
            fn poll_read(
                self: std::pin::Pin<&mut Self>,
                _: &mut std::task::Context<'_>,
                _: &mut tokio::io::ReadBuf<'_>,
            ) -> std::task::Poll<std::io::Result<()>> {
                std::task::Poll::Ready(Err(std::io::ErrorKind::ConnectionReset.into()))
            }
        }
        let ended = serve(&Unread, Reset, tokio::io::sink()).await;
        assert!(
            ended.is_ok(),
            "a reset connection ended the adapter as a failure: {ended:?}"
        );
    }

    #[tokio::test]
    async fn a_malformed_frame_is_an_error() {
        for (frame, problem) in [
            (b"{\0".as_slice(), "invalid Varlink call"),
            // A frame cut off by the end of the connection.
            (b"{\"method\"".as_slice(), "invalid Varlink frame length"),
        ] {
            let (mut client, server) = tokio::io::duplex(1024);
            client.write_all(frame).await.unwrap();
            drop(client);
            let (input, output) = tokio::io::split(server);
            let error = serve(&Unread, input, output).await.unwrap_err();
            assert!(format!("{error:#}").contains(problem), "{error:#}");
        }
    }

    #[tokio::test]
    async fn a_stream_sends_its_history_once_and_then_only_newer_samples() {
        let home = tempfile::tempdir().unwrap();
        let runtime = Runtime::start(home.path().into()).unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while runtime.view(true, None).history.len() < 3 {
            assert!(std::time::Instant::now() < deadline, "no samples");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let (mut client, server) = tokio::io::duplex(1 << 20);
        let serving = tokio::spawn(async move {
            let (input, output) = tokio::io::split(server);
            serve(&runtime, input, output).await
        });
        client
            .write_all(
                b"{\"method\":\"io.chan.Metrics.Get\",\
                \"parameters\":{\"history\":true},\"more\":true}\0",
            )
            .await
            .unwrap();
        let mut input = BufReader::new(client);
        let mut replies = Vec::new();
        for _ in 0..3 {
            let mut frame = Vec::new();
            tokio::time::timeout(Duration::from_secs(10), input.read_until(0, &mut frame))
                .await
                .expect("a reply each second")
                .unwrap();
            frame.pop();
            let reply: Value = serde_json::from_slice(&frame).unwrap();
            assert_eq!(reply["continues"], true, "{reply}");
            let view: View =
                serde_json::from_value(reply["parameters"]["metrics"].clone()).unwrap();
            replies.push(view);
        }
        drop(input);
        serving.await.unwrap().unwrap();
        let sequences = |view: &View| view.history.iter().map(|s| s.sequence).collect::<Vec<_>>();
        let first = sequences(&replies[0]);
        assert!(
            first.len() >= 3,
            "the first reply carries the history: {first:?}"
        );
        let mut sent = *first.last().unwrap();
        for view in &replies[1..] {
            let newer = sequences(view);
            assert!(!newer.is_empty(), "a later reply with nothing new");
            assert!(
                newer.iter().all(|sequence| *sequence > sent),
                "repeated {newer:?} after {sent}"
            );
            let latest = view.latest.as_ref().unwrap().sequence;
            assert_eq!(newer.last(), Some(&latest), "latest is the newest sample");
            sent = latest;
        }
    }
}
