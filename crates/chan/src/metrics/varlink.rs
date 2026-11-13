//! The devserver as a systemd-report source: systemd's metrics interface,
//! `io.systemd.Metrics`, served to one connected client on stdin and stdout.
//!
//! systemd-report finds its sources by listing the sockets in its report
//! directory, calls `List` (or `Describe`) on each with `more` set and no
//! parameters, and keeps a metric only when its name is a valid family name
//! under the socket's own file name. So the socket is named [`SOURCE`] and
//! every family is `SOURCE.<Name>`, from one table that both methods read.

use anyhow::{Context, Result};
use chan_server::metrics::{Process, Sample, Traffic, View};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};

use super::Source;

const INTERFACE: &str = "io.systemd.Metrics";
const SERVICE: &str = "org.varlink.service";
/// The source's name: the socket's file name, which systemd-report requires
/// as the prefix of every metric the source sends.
const SOURCE: &str = "io.chan.Devserver";
/// systemd's own descriptions of the two interfaces, as its sources answer
/// `GetInterfaceDescription` for them.
const IDL: &str = include_str!("io.systemd.Metrics.varlink");
const SERVICE_IDL: &str = include_str!("org.varlink.service.varlink");
/// How a call with nothing to send ends. systemd's providers set it as the
/// stream's sentinel, and systemd-report reads it as "no more metrics".
const NO_SUCH_METRIC: &str = "io.systemd.Metrics.NoSuchMetric";
const MAX_FRAME: u64 = 65536;
/// How long a connection may wait for its client's next call.
const IDLE: Duration = Duration::from_secs(60);
/// How long one reply may wait on a client that is not reading.
const STALLED: Duration = Duration::from_secs(10);

#[derive(Deserialize)]
struct Call {
    method: String,
    /// Absent and null both mean no parameters, as sd-varlink reads them.
    #[serde(default)]
    parameters: Option<Value>,
    #[serde(default)]
    more: bool,
    #[serde(default)]
    oneway: bool,
    #[serde(default)]
    upgrade: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Type {
    Counter,
    Gauge,
    String,
}

impl Type {
    /// The `MetricFamilyType` value that names it.
    fn name(self) -> &'static str {
        match self {
            Type::Counter => "counter",
            Type::Gauge => "gauge",
            Type::String => "string",
        }
    }
}

/// One metric of a family: the fields that tell it from the family's other
/// metrics, where the family has more than one, and its value.
type Reading = (Option<Value>, Value);

struct Family {
    /// The name under [`SOURCE`].
    name: &'static str,
    kind: Type,
    description: &'static str,
    /// The family's metrics in a view. A reading the view has as null is
    /// not a metric, so it yields nothing.
    read: fn(&View) -> Vec<Reading>,
}

impl Family {
    fn full_name(&self) -> String {
        format!("{SOURCE}.{}", self.name)
    }
}

/// The families, in the order `Describe` and `List` send them. Each value is
/// one the view holds, never derived from two readings: a report is a
/// snapshot, and two reports give the rates.
const FAMILIES: &[Family] = &[
    Family {
        name: "Version",
        kind: Type::String,
        description: "chan version of the devserver",
        read: |view| plain(view.identity.version.as_str()),
    },
    Family {
        name: "Build",
        kind: Type::String,
        description: "Build of the devserver binary",
        read: |view| plain(view.identity.build.as_str()),
    },
    Family {
        name: "InstanceId",
        kind: Type::String,
        description:
            "Identifier of the devserver process; it changes on every restart, when every \
            counter starts over",
        read: |view| plain(view.identity.instance_id.as_str()),
    },
    Family {
        name: "PID",
        kind: Type::Gauge,
        description: "Process id of the devserver",
        read: |view| plain(view.identity.pid),
    },
    Family {
        name: "UptimeSec",
        kind: Type::Counter,
        description: "Time since the devserver process started, in seconds",
        read: |view| process(view, |process| Some(process.uptime_seconds)),
    },
    Family {
        name: "CPUUsageNSec",
        kind: Type::Counter,
        description: "CPU time the devserver process has used, in nanoseconds; its shells and \
            other child processes are not counted",
        read: |view| process(view, |process| process.cpu_time_ms.checked_mul(1_000_000)),
    },
    Family {
        name: "MemoryResidentBytes",
        kind: Type::Gauge,
        description: "Resident memory of the devserver process, in bytes",
        read: |view| process(view, |process| Some(process.resident_bytes)),
    },
    Family {
        name: "IOReadBytes",
        kind: Type::Counter,
        description: "Bytes the devserver process has read, by scope: storage counts storage I/O, \
            process all of the process's I/O",
        read: |view| io(view, |process| process.read_bytes),
    },
    Family {
        name: "IOWriteBytes",
        kind: Type::Counter,
        description: "Bytes the devserver process has written, by scope: storage counts storage \
            I/O, process all of the process's I/O",
        read: |view| io(view, |process| process.written_bytes),
    },
    Family {
        name: "TrafficReceivedBytes",
        kind: Type::Counter,
        description: "Payload bytes chan has received, by layer; the layers overlap and must not \
            be summed",
        read: |view| layers(view, |traffic| traffic.totals.received_bytes),
    },
    Family {
        name: "TrafficSentBytes",
        kind: Type::Counter,
        description: "Payload bytes chan has sent, by layer; the layers overlap and must not be \
            summed",
        read: |view| layers(view, |traffic| traffic.totals.sent_bytes),
    },
    Family {
        name: "TrafficOpened",
        kind: Type::Counter,
        description: "Connections, streams or transfer requests chan has opened, by layer; the \
            layers overlap and must not be summed",
        read: |view| layers(view, |traffic| traffic.totals.opened),
    },
    Family {
        name: "TrafficActive",
        kind: Type::Gauge,
        description: "Connections, streams or transfer requests open now, by layer; the layers \
            overlap and must not be summed",
        read: |view| layers(view, |traffic| traffic.totals.active),
    },
    Family {
        name: "TransfersQueued",
        kind: Type::Gauge,
        description: "File transfer jobs waiting for a worker",
        read: |view| sample(view, |sample| sample.transfers.queued),
    },
    Family {
        name: "TransfersRunning",
        kind: Type::Gauge,
        description: "File transfer jobs a worker is running",
        read: |view| sample(view, |sample| sample.transfers.running),
    },
    Family {
        name: "TransfersWorkerCapacity",
        kind: Type::Gauge,
        description: "File transfer workers",
        read: |view| sample(view, |sample| sample.transfers.worker_capacity as u64),
    },
    Family {
        name: "TransfersQueueCapacity",
        kind: Type::Gauge,
        description: "File transfer jobs the queue holds at most",
        read: |view| sample(view, |sample| sample.transfers.queue_capacity as u64),
    },
    Family {
        name: "TransferJobs",
        kind: Type::Counter,
        description: "File transfer jobs that ended, by outcome; finished counts jobs that \
            returned, an application error included, and refused counts jobs the queue had no room \
            for",
        read: outcomes,
    },
    Family {
        name: "GatewayTunnels",
        kind: Type::Gauge,
        description: "Gateway tunnel sessions connected",
        read: |view| sample(view, |sample| sample.gateway_tunnels),
    },
    Family {
        name: "ReverseListeners",
        kind: Type::Gauge,
        description: "Reverse-forward listeners ready",
        read: |view| sample(view, |sample| sample.reverse_listeners),
    },
    Family {
        name: "YamuxWaiting",
        kind: Type::Gauge,
        description: "Gateway streams waiting for a handler",
        read: |view| sample(view, |sample| sample.yamux_waiting),
    },
    Family {
        name: "YamuxServing",
        kind: Type::Gauge,
        description: "Gateway streams a handler is serving",
        read: |view| sample(view, |sample| sample.yamux_serving),
    },
    Family {
        name: "YamuxServiceCapacity",
        kind: Type::Gauge,
        description: "Handlers available across the connected gateway sessions",
        read: |view| sample(view, |sample| sample.yamux_service_capacity),
    },
    Family {
        name: "YamuxStreamLimit",
        kind: Type::Gauge,
        description: "Streams one gateway session may hold open",
        read: |view| sample(view, |sample| sample.yamux_stream_limit as u64),
    },
    Family {
        name: "TunnelDialFailures",
        kind: Type::Counter,
        description: "Gateway dial attempts that failed, timed-out attempts included",
        read: |view| sample(view, |sample| sample.tunnel_dial_failures),
    },
    Family {
        name: "HomeLogicalBytes",
        kind: Type::Gauge,
        description: "Logical size of the regular files in the chan home, in bytes, from the last \
            completed scan",
        read: |view| view.storage.logical_bytes.map(plain).unwrap_or_default(),
    },
    Family {
        name: "HomeAllocatedBytes",
        kind: Type::Gauge,
        description: "Disk space allocated to the regular files in the chan home, in bytes, from \
            the last completed scan",
        read: |view| view.storage.allocated_bytes.map(plain).unwrap_or_default(),
    },
    Family {
        name: "HomeFiles",
        kind: Type::Gauge,
        description: "Regular files in the chan home, from the last completed scan",
        read: |view| view.storage.files.map(plain).unwrap_or_default(),
    },
];

/// A family's one metric, with no fields.
fn plain(value: impl Into<Value>) -> Vec<Reading> {
    vec![(None, value.into())]
}

/// A reading of the latest sample; none before the first sample.
fn sample(view: &View, value: impl Fn(&Sample) -> u64) -> Vec<Reading> {
    view.latest
        .as_ref()
        .map(value)
        .map(plain)
        .unwrap_or_default()
}

/// A reading of the latest sample's process; none without one.
fn process(view: &View, value: impl Fn(&Process) -> Option<u64>) -> Vec<Reading> {
    view.latest
        .as_ref()
        .and_then(|sample| sample.process.as_ref())
        .and_then(value)
        .map(plain)
        .unwrap_or_default()
}

/// A process I/O counter, with the scope it counts; none where the platform
/// cannot count it.
fn io(view: &View, bytes: impl Fn(&Process) -> Option<u64>) -> Vec<Reading> {
    let Some(process) = view
        .latest
        .as_ref()
        .and_then(|sample| sample.process.as_ref())
    else {
        return Vec::new();
    };
    let scope = match process.io_scope.as_str() {
        "storage_io" => "storage",
        "process_io" => "process",
        _ => return Vec::new(),
    };
    bytes(process)
        .map(|bytes| vec![(Some(json!({ "scope": scope })), bytes.into())])
        .unwrap_or_default()
}

/// One counter of every traffic layer, a metric per layer.
fn layers(view: &View, value: impl Fn(&Traffic) -> u64) -> Vec<Reading> {
    let Some(sample) = &view.latest else {
        return Vec::new();
    };
    [
        ("network", &sample.network),
        ("http2", &sample.http2),
        ("yamux", &sample.yamux),
        ("reverseConnections", &sample.reverse_connections),
        ("transferPayload", &sample.transfer_payload),
    ]
    .into_iter()
    .map(|(layer, traffic)| (Some(json!({ "layer": layer })), value(traffic).into()))
    .collect()
}

/// The transfer jobs that ended, a metric per outcome.
fn outcomes(view: &View) -> Vec<Reading> {
    let Some(sample) = &view.latest else {
        return Vec::new();
    };
    let transfers = &sample.transfers;
    [
        ("finished", transfers.finished),
        ("cancelled", transfers.cancelled),
        ("stalled", transfers.stalled),
        ("panicked", transfers.panicked),
        ("refused", transfers.refused),
    ]
    .into_iter()
    .map(|(outcome, jobs)| (Some(json!({ "outcome": outcome })), jobs.into()))
    .collect()
}

/// Every metric a view holds, as `List` sends them.
fn list(view: &View) -> Vec<Value> {
    FAMILIES
        .iter()
        .flat_map(|family| {
            (family.read)(view).into_iter().map(|(fields, value)| {
                let mut metric = json!({ "name": family.full_name(), "value": value });
                if let Some(fields) = fields {
                    metric["fields"] = fields;
                }
                metric
            })
        })
        .collect()
}

/// Every family, as `Describe` sends them.
fn describe() -> Vec<Value> {
    FAMILIES
        .iter()
        .map(|family| {
            json!({
                "name": family.full_name(),
                "description": family.description,
                "type": family.kind.name(),
            })
        })
        .collect()
}

/// The replies of a `more` call that sends `items`, the way sd-varlink sends
/// a method that set a sentinel: one reply each, every one but the last
/// marked as continuing, or the sentinel error when there is none.
fn stream(items: Vec<Value>) -> Vec<Value> {
    let count = items.len();
    if count == 0 {
        return vec![error(NO_SUCH_METRIC, json!({}))];
    }
    items
        .into_iter()
        .enumerate()
        .map(|(index, parameters)| {
            let mut reply = json!({ "parameters": parameters });
            if index + 1 < count {
                reply["continues"] = true.into();
            }
            reply
        })
        .collect()
}

fn error(name: &str, parameters: Value) -> Value {
    json!({"error": name, "parameters": parameters})
}
fn invalid(parameter: &str) -> Value {
    error(
        "org.varlink.service.InvalidParameter",
        json!({ "parameter": parameter }),
    )
}

/// What a call asks for.
#[derive(Debug, PartialEq)]
enum Answer {
    /// One reply, or an error.
    Reply(Value),
    /// The metrics of one read of the devserver.
    List,
    /// The families.
    Describe,
}

fn dispatch(call: &Call) -> Answer {
    if call.upgrade {
        return Answer::Reply(invalid("upgrade"));
    }
    let none = Map::new();
    let parameters = match &call.parameters {
        None | Some(Value::Null) => &none,
        Some(Value::Object(parameters)) => parameters,
        Some(_) => return Answer::Reply(invalid("parameters")),
    };
    // The first parameter a method that takes `allowed` does not know.
    let unknown = |allowed: &[&str]| {
        parameters
            .keys()
            .find(|name| !allowed.contains(&name.as_str()))
            .map(|name| Answer::Reply(invalid(name)))
    };
    match call.method.as_str() {
        "io.systemd.Metrics.List" | "io.systemd.Metrics.Describe" => {
            // sd-varlink checks the flag before the parameters.
            if !call.more {
                return Answer::Reply(error("org.varlink.service.ExpectedMore", json!({})));
            }
            if let Some(refusal) = unknown(&[]) {
                return refusal;
            }
            if call.method.ends_with(".List") {
                Answer::List
            } else {
                Answer::Describe
            }
        }
        "org.varlink.service.GetInfo" => unknown(&[]).unwrap_or_else(|| {
            Answer::Reply(json!({"parameters": {
                "vendor": "chan",
                "product": "chan metrics",
                "version": env!("CARGO_PKG_VERSION"),
                "url": "https://chan.app",
                "interfaces": [INTERFACE, SERVICE],
            }}))
        }),
        "org.varlink.service.GetInterfaceDescription" => {
            if let Some(refusal) = unknown(&["interface"]) {
                return refusal;
            }
            Answer::Reply(match parameters.get("interface").and_then(Value::as_str) {
                Some(INTERFACE) => json!({"parameters": {"description": IDL}}),
                Some(SERVICE) => json!({"parameters": {"description": SERVICE_IDL}}),
                Some(name) => error(
                    "org.varlink.service.InterfaceNotFound",
                    json!({ "interface": name }),
                ),
                None => invalid("interface"),
            })
        }
        method => {
            let (interface, _) = method.rsplit_once('.').unwrap_or((method, ""));
            Answer::Reply(if matches!(interface, INTERFACE | SERVICE) {
                error(
                    "org.varlink.service.MethodNotFound",
                    json!({ "method": method }),
                )
            } else {
                error(
                    "org.varlink.service.InterfaceNotFound",
                    json!({ "interface": interface }),
                )
            })
        }
    }
}

/// One read of the devserver, without history. A failed read is told to
/// `journal` in one line: systemd-report logs the `NoSuchMetric` that follows
/// at debug level only, so this line is the one place the reason shows.
async fn read(source: &impl Source, journal: &mut impl std::io::Write) -> Option<View> {
    match source.read(false, None).await {
        Ok(view) => Some(view),
        Err(error) => {
            let _ = writeln!(
                journal,
                "chan metrics: no devserver metrics to report: {error:#}"
            );
            None
        }
    }
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

/// Serve one client's connection until it ends, one call after another. How
/// a client leaves is not a failure of the source: closing, going quiet past
/// the idle bound, and no longer reading replies all end the connection with
/// success, so an activated instance exits 0. An error is a frame that
/// breaks the protocol or an I/O failure that is not the client's leaving.
/// A failed devserver read is not an error either: the call answers
/// `NoSuchMetric` and the reason goes to `journal`.
pub(super) async fn serve(
    source: &impl Source,
    input: impl AsyncRead + Unpin,
    mut output: impl AsyncWrite + Unpin,
    mut journal: impl std::io::Write,
) -> Result<()> {
    let mut input = BufReader::new(input);
    loop {
        let mut frame = Vec::new();
        let read_call = tokio::time::timeout(
            IDLE,
            (&mut input).take(MAX_FRAME + 1).read_until(0, &mut frame),
        )
        .await;
        let size = match read_call {
            Err(_idle) => {
                tracing::debug!("Varlink client idle; closing its connection");
                return Ok(());
            }
            Ok(Err(error)) if client_left(&error) => return Ok(()),
            Ok(read_call) => read_call?,
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
        if call.oneway {
            continue;
        }
        let replies = match dispatch(&call) {
            Answer::Reply(reply) => vec![reply],
            Answer::Describe => stream(describe()),
            Answer::List => stream(match read(source, &mut journal).await {
                Some(view) => list(&view),
                None => Vec::new(),
            }),
        };
        for reply in &replies {
            if !write_frame(&mut output, reply).await? {
                return Ok(());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chan_server::metrics::Runtime;
    use std::sync::Arc;

    /// The runtime behind `/api/metrics`, read in process.
    impl Source for Arc<Runtime> {
        async fn read(&self, history: bool, since: Option<u64>) -> Result<View> {
            Ok(self.view(history, since))
        }
    }

    /// A source that answers every read with one canned outcome and records
    /// what each read asked for.
    struct Canned {
        answer: std::result::Result<View, String>,
        asked: std::sync::Mutex<Vec<(bool, Option<u64>)>>,
    }

    impl Canned {
        fn view(view: View) -> Self {
            Self {
                answer: Ok(view),
                asked: Default::default(),
            }
        }
        fn failing(error: &str) -> Self {
            Self {
                answer: Err(error.into()),
                asked: Default::default(),
            }
        }
    }

    impl Source for Canned {
        async fn read(&self, history: bool, since: Option<u64>) -> Result<View> {
            self.asked.lock().unwrap().push((history, since));
            self.answer.clone().map_err(anyhow::Error::msg)
        }
    }

    /// A source that answers with a response body as the HTTP client decodes
    /// it, schema check first.
    struct Body(&'static str);

    impl Source for Body {
        async fn read(&self, _history: bool, _since: Option<u64>) -> Result<View> {
            super::super::decode(self.0.as_bytes())
        }
    }

    /// A source for connections that end before any read.
    struct Unread;

    impl Source for Unread {
        async fn read(&self, _history: bool, _since: Option<u64>) -> Result<View> {
            panic!("no metrics read is expected")
        }
    }

    fn call(method: &str, parameters: Option<Value>, more: bool) -> Call {
        Call {
            method: method.into(),
            parameters,
            more,
            oneway: false,
            upgrade: false,
        }
    }

    /// The frames a client sends, NUL-terminated and concatenated.
    fn frames(calls: &[Value]) -> Vec<u8> {
        let mut bytes = Vec::new();
        for call in calls {
            bytes.extend(serde_json::to_vec(call).unwrap());
            bytes.push(0);
        }
        bytes
    }

    /// Send `calls` on one connection, close it, and collect every reply and
    /// what the source told its journal. The connection must end cleanly.
    async fn exchange(source: &impl Source, calls: &[Value]) -> (Vec<Value>, String) {
        let (mut client, server) = tokio::io::duplex(1 << 20);
        client.write_all(&frames(calls)).await.unwrap();
        client.shutdown().await.unwrap();
        let (input, output) = tokio::io::split(server);
        let mut journal = Vec::new();
        serve(source, input, output, &mut journal).await.unwrap();
        let mut replies = Vec::new();
        let mut client = BufReader::new(client);
        loop {
            let mut frame = Vec::new();
            if client.read_until(0, &mut frame).await.unwrap() == 0 {
                break;
            }
            assert_eq!(frame.pop(), Some(0), "an unterminated reply");
            replies.push(serde_json::from_slice(&frame).unwrap());
        }
        (replies, String::from_utf8(journal).unwrap())
    }

    fn list_call() -> Value {
        json!({"method": "io.systemd.Metrics.List", "more": true})
    }

    /// Each metric of a `List` reply as (family, fields, value).
    fn metrics(replies: &[Value]) -> Vec<(String, Value, Value)> {
        replies
            .iter()
            .map(|reply| {
                let metric = &reply["parameters"];
                let name = metric["name"].as_str().unwrap();
                let family = name.strip_prefix("io.chan.Devserver.").unwrap();
                (
                    family.to_string(),
                    metric["fields"].clone(),
                    metric["value"].clone(),
                )
            })
            .collect()
    }

    /// Each traffic layer's readings in [`distinct_view`], by its wire name:
    /// received and sent bytes, opened, active.
    const LAYERS: [(&str, [u64; 4]); 5] = [
        ("network", [10_001, 10_002, 10_003, 10_004]),
        ("http2", [20_001, 20_002, 20_003, 20_004]),
        ("yamux", [30_001, 30_002, 30_003, 30_004]),
        ("reverseConnections", [40_001, 40_002, 40_003, 40_004]),
        ("transferPayload", [50_001, 50_002, 50_003, 50_004]),
    ];

    /// [`super::super::full_view`] with a value of its own in every number a
    /// family reads, so a family that reads another field, or a layer that
    /// reads another layer, sends a value [`distinct_view_metrics`] does not
    /// expect there.
    fn distinct_view() -> View {
        let mut view = super::super::full_view();
        let sample = view.latest.as_mut().unwrap();
        let layers = [
            &mut sample.network,
            &mut sample.http2,
            &mut sample.yamux,
            &mut sample.reverse_connections,
            &mut sample.transfer_payload,
        ];
        for (traffic, (_, [received, sent, opened, active])) in layers.into_iter().zip(LAYERS) {
            traffic.totals.received_bytes = received;
            traffic.totals.sent_bytes = sent;
            traffic.totals.opened = opened;
            traffic.totals.active = active;
        }
        sample.transfers.queued = 1;
        sample.transfers.running = 2;
        sample.transfers.worker_capacity = 4;
        sample.transfers.queue_capacity = 16;
        sample.transfers.finished = 9;
        sample.transfers.cancelled = 3;
        sample.transfers.stalled = 5;
        sample.transfers.panicked = 6;
        sample.transfers.refused = 8;
        sample.gateway_tunnels = 7;
        sample.reverse_listeners = 10;
        sample.yamux_waiting = 12;
        sample.yamux_serving = 13;
        sample.yamux_service_capacity = 14;
        sample.yamux_stream_limit = 256;
        sample.tunnel_dial_failures = 11;
        view.storage.logical_bytes = Some(1536);
        view.storage.allocated_bytes = Some(4096);
        view.storage.files = Some(17);
        view
    }

    /// What `List` sends for [`distinct_view`], family by family.
    fn distinct_view_metrics() -> Vec<(String, Value, Value)> {
        let layer = |name| json!({ "layer": name });
        let mut expected = vec![
            ("Version", Value::Null, json!("0.127.0")),
            ("Build", Value::Null, json!("git-0123456789ab")),
            (
                "InstanceId",
                Value::Null,
                json!("0123456789abcdef0123456789abcdef"),
            ),
            ("PID", Value::Null, json!(184_223)),
            ("UptimeSec", Value::Null, json!(3_600)),
            ("CPUUsageNSec", Value::Null, json!(1_250_000_000u64)),
            ("MemoryResidentBytes", Value::Null, json!(12 * 1024 * 1024)),
            ("IOReadBytes", json!({"scope": "storage"}), json!(512)),
            (
                "IOWriteBytes",
                json!({"scope": "storage"}),
                json!(3 * 1024 * 1024),
            ),
        ];
        for (family, pick) in [
            ("TrafficReceivedBytes", 0),
            ("TrafficSentBytes", 1),
            ("TrafficOpened", 2),
            ("TrafficActive", 3),
        ] {
            for (name, readings) in LAYERS {
                expected.push((family, layer(name), json!(readings[pick])));
            }
        }
        expected.extend([
            ("TransfersQueued", Value::Null, json!(1)),
            ("TransfersRunning", Value::Null, json!(2)),
            ("TransfersWorkerCapacity", Value::Null, json!(4)),
            ("TransfersQueueCapacity", Value::Null, json!(16)),
        ]);
        for (outcome, jobs) in [
            ("finished", 9),
            ("cancelled", 3),
            ("stalled", 5),
            ("panicked", 6),
            ("refused", 8),
        ] {
            expected.push(("TransferJobs", json!({ "outcome": outcome }), json!(jobs)));
        }
        expected.extend([
            ("GatewayTunnels", Value::Null, json!(7)),
            ("ReverseListeners", Value::Null, json!(10)),
            ("YamuxWaiting", Value::Null, json!(12)),
            ("YamuxServing", Value::Null, json!(13)),
            ("YamuxServiceCapacity", Value::Null, json!(14)),
            ("YamuxStreamLimit", Value::Null, json!(256)),
            ("TunnelDialFailures", Value::Null, json!(11)),
            ("HomeLogicalBytes", Value::Null, json!(1536)),
            ("HomeAllocatedBytes", Value::Null, json!(4096)),
            ("HomeFiles", Value::Null, json!(17)),
        ]);
        expected
            .into_iter()
            .map(|(family, fields, value)| (family.to_string(), fields, value))
            .collect()
    }

    #[test]
    fn every_canned_number_is_its_own() {
        // Two families expecting one number would let a family that reads
        // the other's field pass.
        let expected = distinct_view_metrics();
        let numbers: Vec<u64> = expected
            .iter()
            .filter(|(_, _, value)| !value.is_string())
            .map(|(_, _, value)| value.as_u64().unwrap())
            .collect();
        let mut unique = numbers.clone();
        unique.sort_unstable();
        unique.dedup();
        assert_eq!(unique.len(), numbers.len(), "{numbers:?}");
    }

    #[tokio::test]
    async fn list_sends_every_family_with_its_fields_and_values() {
        let source = Canned::view(distinct_view());
        let (replies, journal) = exchange(&source, &[list_call()]).await;
        assert_eq!(metrics(&replies), distinct_view_metrics());
        // A stream: every reply but the last continues, and each carries
        // only the List outputs, all of them whole numbers or strings.
        let (last, rest) = replies.split_last().unwrap();
        assert!(rest.iter().all(|reply| reply["continues"] == true));
        assert_eq!(last.get("continues"), None);
        for reply in &replies {
            let keys: Vec<&str> = reply["parameters"]
                .as_object()
                .unwrap()
                .keys()
                .map(String::as_str)
                .collect();
            assert!(
                keys.iter()
                    .all(|key| ["name", "fields", "value"].contains(key)),
                "{reply}"
            );
            let value = &reply["parameters"]["value"];
            assert!(value.is_u64() || value.is_string(), "{reply}");
        }
        // One read, without history, and nothing for the journal.
        assert_eq!(*source.asked.lock().unwrap(), [(false, None)]);
        assert_eq!(journal, "");
    }

    #[test]
    fn null_readings_are_not_sent() {
        let families = |view: &View| {
            let mut names: Vec<String> = list(view)
                .iter()
                .map(|metric| {
                    metric["name"].as_str().unwrap()["io.chan.Devserver.".len()..].to_string()
                })
                .collect();
            names.dedup();
            names
        };
        let identity = ["Version", "Build", "InstanceId", "PID"];
        let home = ["HomeLogicalBytes", "HomeAllocatedBytes", "HomeFiles"];
        // No sample yet and the first scan still pending: the identity alone.
        let mut view = super::super::full_view();
        view.latest = None;
        view.storage.logical_bytes = None;
        view.storage.allocated_bytes = None;
        view.storage.files = None;
        view.storage.sampled_at_ms = None;
        assert_eq!(families(&view), identity);
        // The first scan failed: still no totals to send.
        view.storage.error = Some("storage scan exceeded its bound".into());
        assert_eq!(families(&view), identity);
        // A later scan failed: the totals of the last completed scan stand.
        let mut refreshed = super::super::full_view();
        refreshed.latest = None;
        refreshed.storage.error = Some("storage scan exceeded its bound".into());
        assert_eq!(families(&refreshed), [&identity[..], &home[..]].concat());
        // A sample without process readings: no process families.
        let mut view = super::super::full_view();
        view.latest.as_mut().unwrap().process = None;
        let sent = families(&view);
        for family in [
            "UptimeSec",
            "CPUUsageNSec",
            "MemoryResidentBytes",
            "IOReadBytes",
            "IOWriteBytes",
        ] {
            assert!(
                !sent.iter().any(|name| name == family),
                "{family} in {sent:?}"
            );
        }
        assert!(sent.iter().any(|name| name == "TrafficActive"), "{sent:?}");
        // I/O the platform cannot count, as FreeBSD reports it.
        let mut view = super::super::full_view();
        let process = view.latest.as_mut().unwrap().process.as_mut().unwrap();
        process.io_scope = "unavailable".into();
        process.read_bytes = None;
        process.written_bytes = None;
        let sent = families(&view);
        assert!(!sent.iter().any(|name| name.starts_with("IO")), "{sent:?}");
        assert!(
            sent.iter().any(|name| name == "MemoryResidentBytes"),
            "{sent:?}"
        );
        // A scope this reader does not know is not reported as one it does,
        // and Windows' scope reads as process.
        process_scope(&mut view, "something_new");
        assert!(!families(&view).iter().any(|name| name.starts_with("IO")));
        process_scope(&mut view, "process_io");
        let io: Vec<Value> = list(&view)
            .into_iter()
            .filter(|metric| metric["name"].as_str().unwrap().contains(".IO"))
            .map(|metric| metric["fields"].clone())
            .collect();
        assert_eq!(
            io,
            [json!({"scope": "process"}), json!({"scope": "process"})]
        );
    }

    fn process_scope(view: &mut View, scope: &str) {
        let process = view.latest.as_mut().unwrap().process.as_mut().unwrap();
        process.io_scope = scope.into();
        process.read_bytes = Some(1);
        process.written_bytes = Some(2);
    }

    #[tokio::test]
    async fn describe_and_list_agree_family_for_family() {
        let (described, _) = exchange(
            &Unread,
            &[json!({"method": "io.systemd.Metrics.Describe", "more": true})],
        )
        .await;
        assert_eq!(described.len(), FAMILIES.len());
        let (last, rest) = described.split_last().unwrap();
        assert!(rest.iter().all(|reply| reply["continues"] == true));
        assert_eq!(last.get("continues"), None);
        let types: std::collections::BTreeMap<String, String> = described
            .iter()
            .map(|reply| {
                let family = &reply["parameters"];
                assert_eq!(
                    family.as_object().unwrap().len(),
                    3,
                    "name, description and type only: {family}"
                );
                assert!(!family["description"].as_str().unwrap().is_empty());
                (
                    family["name"].as_str().unwrap().to_string(),
                    family["type"].as_str().unwrap().to_string(),
                )
            })
            .collect();
        assert_eq!(types.len(), FAMILIES.len(), "a family described twice");
        // A view with every reading present sends every described family,
        // and nothing else; each value is of its family's type.
        let listed = list(&super::super::full_view());
        let names: std::collections::BTreeSet<&str> = listed
            .iter()
            .map(|metric| metric["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, types.keys().map(String::as_str).collect());
        for metric in &listed {
            let kind = &types[metric["name"].as_str().unwrap()];
            let value = &metric["value"];
            match kind.as_str() {
                "string" => assert!(value.is_string(), "{metric}"),
                "counter" | "gauge" => assert!(value.is_u64(), "{metric}"),
                other => panic!("an unexpected type {other}"),
            }
        }
        // Each type sent is one the interface declares.
        let declared = IDL.split("type MetricFamilyType(").nth(1).unwrap();
        let declared = declared.split(')').next().unwrap();
        for kind in types.values() {
            assert!(
                declared
                    .lines()
                    .any(|line| line.trim().trim_end_matches(',') == kind),
                "{kind} is not a MetricFamilyType"
            );
        }
        // The InstanceId description says what a reader needs to know.
        let instance = &described[2]["parameters"];
        assert_eq!(instance["name"], "io.chan.Devserver.InstanceId");
        assert!(instance["description"]
            .as_str()
            .unwrap()
            .contains("every restart"));
    }

    /// systemd's `varlink_idl_interface_name_is_valid`.
    fn interface_name_is_valid(name: &str) -> bool {
        let mut chars = name.chars();
        if !chars.next().is_some_and(|c| c.is_ascii_alphabetic()) {
            return false;
        }
        let (mut dot, mut dash) = (false, false);
        for c in chars {
            match c {
                '.' | '-' if dot || dash => return false,
                '.' => dot = true,
                '-' => dash = true,
                c if c.is_ascii_alphanumeric() => (dot, dash) = (false, false),
                _ => return false,
            }
        }
        !dot && !dash
    }

    /// systemd's `varlink_idl_field_name_is_valid`.
    fn field_name_is_valid(name: &str) -> bool {
        let mut chars = name.chars();
        if !chars.next().is_some_and(|c| c.is_ascii_alphabetic()) {
            return false;
        }
        let mut underscore = false;
        for c in chars {
            match c {
                '_' if underscore => return false,
                '_' => underscore = true,
                c if c.is_ascii_alphanumeric() => underscore = false,
                _ => return false,
            }
        }
        !underscore
    }

    /// systemd-report's `metrics_name_valid`: an interface name, a dot, and
    /// a field name.
    fn metrics_name_valid(name: &str) -> bool {
        name.rsplit_once('.').is_some_and(|(interface, field)| {
            interface_name_is_valid(interface) && field_name_is_valid(field)
        })
    }

    /// systemd-report's `metric_startswith_prefix`: a true prefix, followed
    /// by a dot.
    fn metric_startswith_prefix(name: &str, prefix: &str) -> bool {
        !prefix.is_empty()
            && name
                .strip_prefix(prefix)
                .is_some_and(|rest| rest.starts_with('.') && rest.len() > 1)
    }

    #[test]
    fn every_name_passes_systemd_reports_checks() {
        // The ports refuse what systemd-report refuses.
        for (name, valid) in [
            ("io.systemd.Basic.CPUUsage", true),
            ("io.chan.Devserver.HomeFiles", true),
            ("io.chan.Devserver.Home_Files", true),
            ("io.chan.Devserver.Home__Files", false),
            ("io.chan.Devserver.Home_", false),
            ("io.chan.Devserver.9Files", false),
            ("io.chan.Devserver.Home-Files", false),
            ("io..chan.Devserver.HomeFiles", false),
            ("io.chan-.Devserver.HomeFiles", false),
            ("io.chan.Devserver.", false),
            ("HomeFiles", false),
        ] {
            assert_eq!(metrics_name_valid(name), valid, "{name}");
        }
        assert!(metric_startswith_prefix("io.chan.Devserver.PID", SOURCE));
        assert!(!metric_startswith_prefix("io.chan.DevserverPID", SOURCE));
        assert!(!metric_startswith_prefix(SOURCE, SOURCE));
        assert!(!metric_startswith_prefix("io.chan.Other.PID", SOURCE));
        // The source's socket name is one systemd-report lists.
        assert!(interface_name_is_valid(SOURCE));
        // Every name the source can send, described and listed.
        let described = describe();
        let listed = list(&super::super::full_view());
        for name in described
            .iter()
            .chain(&listed)
            .map(|item| item["name"].as_str().unwrap())
        {
            assert!(
                metrics_name_valid(name),
                "{name} is not a valid metric name"
            );
            assert!(
                metric_startswith_prefix(name, SOURCE),
                "{name} is not under {SOURCE}"
            );
        }
        // Fields name a metric within its family: valid field names with
        // string values.
        for metric in &listed {
            if let Some(fields) = metric.get("fields") {
                for (key, value) in fields.as_object().unwrap() {
                    assert!(field_name_is_valid(key), "{metric}");
                    assert!(value.is_string(), "{metric}");
                }
            }
        }
    }

    #[tokio::test]
    async fn a_read_of_a_real_runtime_sends_only_described_valid_names() {
        let home = tempfile::tempdir().unwrap();
        let runtime = Runtime::start(home.path().into()).unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while runtime.view(false, None).latest.is_none() {
            assert!(std::time::Instant::now() < deadline, "no sample");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let (replies, journal) = exchange(&runtime, &[list_call()]).await;
        assert_eq!(journal, "");
        let described: std::collections::BTreeSet<String> = describe()
            .iter()
            .map(|family| family["name"].as_str().unwrap().to_string())
            .collect();
        for (family, _, _) in metrics(&replies) {
            let name = format!("{SOURCE}.{family}");
            assert!(described.contains(&name), "{name} is not described");
            assert!(metrics_name_valid(&name));
        }
        assert!(
            metrics(&replies)
                .iter()
                .any(|(family, _, _)| family == "MemoryResidentBytes"),
            "a sampled runtime reports its memory"
        );
    }

    #[tokio::test]
    async fn no_metric_to_send_answers_no_such_metric() {
        let no_such_metric = json!({"error": NO_SUCH_METRIC, "parameters": {}});
        // A devserver that cannot be read: the journal says why, in one line.
        let down = Canned::failing("no devserver is listening on 127.0.0.1:8787");
        let (replies, journal) = exchange(&down, &[list_call()]).await;
        assert_eq!(replies, std::slice::from_ref(&no_such_metric));
        assert_eq!(
            journal,
            "chan metrics: no devserver metrics to report: no devserver is listening on \
             127.0.0.1:8787\n"
        );
        // A schema this reader does not know is not read at all.
        let (replies, journal) =
            exchange(&Body(r#"{"schemaVersion":2,"samples":[]}"#), &[list_call()]).await;
        assert_eq!(replies, std::slice::from_ref(&no_such_metric));
        assert_eq!(
            journal,
            "chan metrics: no devserver metrics to report: unsupported metrics schema 2\n"
        );
        // An empty view, with not even the schema version in it.
        let (replies, journal) = exchange(&Body("{}"), &[list_call()]).await;
        assert_eq!(replies, std::slice::from_ref(&no_such_metric));
        assert!(
            journal.starts_with(
                "chan metrics: no devserver metrics to report: invalid metrics response"
            ),
            "{journal}"
        );
        assert_eq!(journal.lines().count(), 1, "{journal}");
        // A read with nothing in it to send ends the same way, and so the
        // stream is the sentinel alone.
        assert_eq!(stream(Vec::new()), [no_such_metric]);
        // The devserver's state never touches Describe.
        let (replies, journal) = exchange(
            &down,
            &[json!({"method": "io.systemd.Metrics.Describe", "more": true})],
        )
        .await;
        assert_eq!(replies.len(), FAMILIES.len());
        assert_eq!(journal, "");
    }

    #[test]
    fn calls_follow_sd_varlinks_rules() {
        let reply = |method: &str, parameters: Option<Value>, more: bool| match dispatch(&call(
            method, parameters, more,
        )) {
            Answer::Reply(reply) => reply,
            other => panic!("{method} answered {other:?}"),
        };
        for method in ["io.systemd.Metrics.List", "io.systemd.Metrics.Describe"] {
            let wanted = if method.ends_with("List") {
                Answer::List
            } else {
                Answer::Describe
            };
            // Absent, null or empty parameters are no parameters, as a
            // frame spells them.
            for frame in [
                json!({"method": method, "more": true}),
                json!({"method": method, "more": true, "parameters": null}),
                json!({"method": method, "more": true, "parameters": {}}),
            ] {
                let parsed: Call = serde_json::from_value(frame.clone()).unwrap();
                assert_eq!(dispatch(&parsed), wanted, "{frame}");
            }
            // Without `more`, ExpectedMore, before any parameter is read.
            for parameters in [None, Some(json!({"since": 2}))] {
                assert_eq!(
                    reply(method, parameters, false),
                    json!({"error": "org.varlink.service.ExpectedMore", "parameters": {}})
                );
            }
            // Any parameter is one these methods do not take.
            assert_eq!(
                reply(method, Some(json!({"history": true})), true),
                json!({"error": "org.varlink.service.InvalidParameter", "parameters": {"parameter": "history"}})
            );
            assert_eq!(
                reply(method, Some(json!([1])), true)["parameters"]["parameter"],
                "parameters"
            );
        }
        assert_eq!(
            reply("io.systemd.Metrics.Get", None, true),
            json!({"error": "org.varlink.service.MethodNotFound", "parameters": {"method": "io.systemd.Metrics.Get"}})
        );
        assert_eq!(
            reply("io.chan.Metrics.Get", None, false),
            json!({"error": "org.varlink.service.InterfaceNotFound", "parameters": {"interface": "io.chan.Metrics"}})
        );
        let mut upgrade = call("io.systemd.Metrics.List", None, true);
        upgrade.upgrade = true;
        assert_eq!(dispatch(&upgrade), Answer::Reply(invalid("upgrade")));
    }

    #[test]
    fn introspection_names_the_two_interfaces_as_systemd_describes_them() {
        let reply = |method: &str, parameters: Value| match dispatch(&call(
            method,
            Some(parameters),
            false,
        )) {
            Answer::Reply(reply) => reply,
            other => panic!("{method} answered {other:?}"),
        };
        assert_eq!(
            reply("org.varlink.service.GetInfo", json!({}))["parameters"]["interfaces"],
            json!(["io.systemd.Metrics", "org.varlink.service"])
        );
        assert_eq!(
            reply("org.varlink.service.GetInfo", json!({"x": 1}))["error"],
            "org.varlink.service.InvalidParameter"
        );
        let description = |interface: &str| {
            reply(
                "org.varlink.service.GetInterfaceDescription",
                json!({ "interface": interface }),
            )
        };
        assert_eq!(description(INTERFACE)["parameters"]["description"], IDL);
        assert_eq!(
            description(SERVICE)["parameters"]["description"],
            SERVICE_IDL
        );
        assert_eq!(
            description("io.chan.Metrics"),
            json!({"error": "org.varlink.service.InterfaceNotFound", "parameters": {"interface": "io.chan.Metrics"}})
        );
        assert_eq!(
            reply("org.varlink.service.GetInterfaceDescription", json!({}))["parameters"]
                ["parameter"],
            "interface"
        );
        // The description is systemd's: the interface, its enum, its two
        // methods that require `more` and take no parameters, its one error.
        // A byte-for-byte comparison against a running systemd is the
        // isolated guest run's; these are the declarations a client relies on.
        assert!(IDL.starts_with("# Metrics APIs\ninterface io.systemd.Metrics\n"));
        for declaration in [
            "type MetricFamilyType(",
            "# [Requires 'more' flag]\nmethod List() -> (",
            "# [Requires 'more' flag]\nmethod Describe() -> (",
            "\n\tname: string,\n\t# Metric object name",
            "\n\tfields: ?object,\n",
            "\n\tvalue: any\n)",
            "\n\ttype: MetricFamilyType\n)",
            "\nerror NoSuchMetric()\n",
        ] {
            assert!(
                IDL.contains(declaration),
                "the description lacks {declaration:?}"
            );
        }
        // Every error this source sends is declared by its interface.
        for error in [
            "InvalidParameter(",
            "MethodNotFound(",
            "InterfaceNotFound(",
            "ExpectedMore()",
        ] {
            assert!(SERVICE_IDL.contains(&format!("\nerror {error}")), "{error}");
        }
    }

    #[tokio::test]
    async fn one_connection_carries_several_calls_and_a_read_each() {
        let source = Canned::view(distinct_view());
        let calls = [
            json!({"method": "org.varlink.service.GetInfo"}),
            json!({"method": "io.systemd.Metrics.Describe", "more": true, "parameters": {}}),
            list_call(),
            // A oneway call is not answered, and does not read.
            json!({"method": "io.systemd.Metrics.List", "oneway": true}),
            json!({"method": "io.systemd.Metrics.List"}),
            list_call(),
        ];
        let (replies, _) = exchange(&source, &calls).await;
        let count = distinct_view_metrics().len();
        assert_eq!(replies.len(), 1 + FAMILIES.len() + count + 1 + count);
        assert!(replies[0]["parameters"]["interfaces"].is_array());
        let expected_more = &replies[1 + FAMILIES.len() + count];
        assert_eq!(expected_more["error"], "org.varlink.service.ExpectedMore");
        // Each List reads the devserver once, without history.
        assert_eq!(
            *source.asked.lock().unwrap(),
            [(false, None), (false, None)]
        );
    }

    const GET_INFO: &[u8] = b"{\"method\":\"org.varlink.service.GetInfo\"}\0";

    #[tokio::test(start_paused = true)]
    async fn an_idle_client_ends_its_connection_without_an_error() {
        // Connected and silent: the client end stays open, so only the idle
        // bound can end the connection.
        let (client, server) = tokio::io::duplex(1024);
        let (input, output) = tokio::io::split(server);
        let started = tokio::time::Instant::now();
        let ended = serve(&Unread, input, output, std::io::sink()).await;
        assert!(
            ended.is_ok(),
            "an idle client ended the source as a failure: {ended:?}"
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
        let started = tokio::time::Instant::now();
        let serving =
            tokio::spawn(async move { serve(&Unread, input, output, std::io::sink()).await });
        client.write_all(GET_INFO).await.unwrap();
        let ended = serving.await.unwrap();
        assert!(
            ended.is_ok(),
            "a client that stopped reading ended the source as a failure: {ended:?}"
        );
        assert_eq!(started.elapsed(), Duration::from_secs(10));
        drop(client);
    }

    #[tokio::test]
    async fn a_client_that_left_ends_its_connection_without_an_error() {
        // Gone before its reply could be written.
        let (mut client, server) = tokio::io::duplex(1024);
        client.write_all(GET_INFO).await.unwrap();
        drop(client);
        let (input, output) = tokio::io::split(server);
        let ended = serve(&Unread, input, output, std::io::sink()).await;
        assert!(
            ended.is_ok(),
            "a client that left ended the source as a failure: {ended:?}"
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
        let ended = serve(&Unread, Reset, tokio::io::sink(), std::io::sink()).await;
        assert!(
            ended.is_ok(),
            "a reset connection ended the source as a failure: {ended:?}"
        );
    }

    #[tokio::test]
    async fn a_malformed_frame_is_an_error() {
        let oversized = [vec![b' '; MAX_FRAME as usize + 1], vec![0]].concat();
        for (frame, problem) in [
            (b"{\0".to_vec(), "invalid Varlink call"),
            // A frame cut off by the end of the connection.
            (b"{\"method\"".to_vec(), "invalid Varlink frame length"),
            (oversized, "invalid Varlink frame length"),
        ] {
            let (mut client, server) = tokio::io::duplex(1 << 18);
            client.write_all(&frame).await.unwrap();
            drop(client);
            let (input, output) = tokio::io::split(server);
            let error = serve(&Unread, input, output, std::io::sink())
                .await
                .unwrap_err();
            assert!(format!("{error:#}").contains(problem), "{error:#}");
        }
    }
}
