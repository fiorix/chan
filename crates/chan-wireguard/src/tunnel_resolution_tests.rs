use super::*;
use crate::clock;
use crate::resolver::{Lookup, RESOLVE_TIMEOUT};
use crate::testing::*;
use crate::x25519::{PublicKey, StaticSecret};
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot};
use tokio::time::timeout;

struct Answer(oneshot::Sender<io::Result<Vec<SocketAddr>>>);

impl Answer {
    fn send(self, answer: io::Result<SocketAddr>) -> Result<(), io::Result<Vec<SocketAddr>>> {
        self.0.send(answer.map(|address| vec![address]))
    }

    fn send_all(
        self,
        answers: io::Result<Vec<SocketAddr>>,
    ) -> Result<(), io::Result<Vec<SocketAddr>>> {
        self.0.send(answers)
    }
}

struct Fixture {
    a: Tunnel,
    b: Tunnel,
    a_at: SocketAddr,
    b_at: SocketAddr,
    queries: mpsc::UnboundedReceiver<Answer>,
}

fn controlled_lookup() -> (Lookup, mpsc::UnboundedReceiver<Answer>) {
    let (queries, receiver) = mpsc::unbounded_channel();
    let lookup: Lookup = Arc::new(move |_| {
        let (answer, result) = oneshot::channel();
        queries.send(Answer(answer)).unwrap();
        Box::pin(async move { result.await.unwrap() })
    });
    (lookup, receiver)
}

impl Fixture {
    async fn new() -> Self {
        Self::build(false).await
    }

    /// A client whose name `peer.test` resolves only through `queries`,
    /// and its peer. With `known` the client starts with the peer's
    /// address, as `start_on` gives it one.
    async fn build(known: bool) -> Self {
        Self::build_with_keepalive(known, None).await
    }

    async fn build_with_keepalive(known: bool, keepalive: Option<u16>) -> Self {
        let a_key = StaticSecret::random_from_rng(OsRng);
        let b_key = StaticSecret::random_from_rng(OsRng);
        let a_pub = PublicKey::from(&a_key);
        let b_pub = PublicKey::from(&b_key);
        let a_udp = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let b_udp = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let a_at = a_udp.local_addr().unwrap();
        let b_at = b_udp.local_addr().unwrap();
        let mut config = config(a_key, b_pub, A_ADDR, B_ADDR, b_at);
        config.peer.endpoint.host = "peer.test".into();
        config.peer.persistent_keepalive = keepalive;
        let (lookup, queries) = controlled_lookup();
        let resolver = Resolver::with_lookup(config.peer.endpoint.clone(), lookup);
        let mut sockets = Sockets::default();
        sockets.insert(a_udp).unwrap();
        let a = Tunnel::build(config, sockets, known.then_some(b_at), resolver).unwrap();
        let b = Tunnel::start_on(
            crate::testing::config(b_key, a_pub, B_ADDR, A_ADDR, a_at),
            b_udp,
            a_at,
        )
        .unwrap();
        Self {
            a,
            b,
            a_at,
            b_at,
            queries,
        }
    }

    async fn query(&mut self) -> Answer {
        timeout(WAIT, self.queries.recv()).await.unwrap().unwrap()
    }

    async fn establish(&mut self) -> (Stream, Stream) {
        self.query().await.send(Ok(self.b_at)).unwrap();
        self.connect().await
    }

    async fn connect(&self) -> (Stream, Stream) {
        let mut listener = self.b.listen(0).unwrap();
        let port = listener.port();
        let (a, b) = timeout(WAIT, async {
            tokio::join!(self.a.connect(b_port(port)), listener.accept())
        })
        .await
        .unwrap();
        (a.unwrap(), b.unwrap())
    }
}

async fn until(mut predicate: impl FnMut() -> bool) {
    timeout(WAIT, async {
        while !predicate() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
}

/// Cancel the client's sole TCP dial and drain its closing reset before
/// advancing the protocol clock; neither may restart an expired core.
async fn cancel_connect(tunnel: &Tunnel, pending: JoinHandle<io::Result<Stream>>) {
    pending.abort();
    assert!(pending.await.unwrap_err().is_cancelled());
    timeout(WAIT, async {
        while tunnel
            .inner
            .shared
            .stack
            .lock()
            .sockets
            .iter()
            .next()
            .is_some()
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the cancelled client's socket drains before the clock advances");
}

async fn until_expired(tunnel: &Tunnel, message: &str) {
    timeout(WAIT, async {
        while !tunnel.inner.wire.lock().tunn.is_expired() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect(message);
}

async fn exchange(a: &mut Stream, b: &mut Stream) {
    timeout(WAIT, async {
        a.write_all(b"ping").await.unwrap();
        let mut bytes = [0; 4];
        b.read_exact(&mut bytes).await.unwrap();
        assert_eq!(&bytes, b"ping");
        b.write_all(b"pong").await.unwrap();
        a.read_exact(&mut bytes).await.unwrap();
        assert_eq!(&bytes, b"pong");
    })
    .await
    .unwrap();
}

fn is_initiation(datagram: &[u8]) -> bool {
    datagram.len() == 148 && datagram[..4] == [1, 0, 0, 0]
}

async fn initiation(socket: &UdpSocket) -> SocketAddr {
    initiation_within(socket, WAIT).await
}

async fn initiation_within(socket: &UdpSocket, within: Duration) -> SocketAddr {
    let mut bytes = [0; 256];
    let (len, from) = timeout(within, socket.recv_from(&mut bytes))
        .await
        .expect("an initiation in time")
        .unwrap();
    assert!(is_initiation(&bytes[..len]));
    from
}

/// Every datagram waiting on `socket`.
fn drain(socket: &UdpSocket) -> Vec<Vec<u8>> {
    let mut bytes = [0; 2048];
    let mut datagrams = Vec::new();
    while let Ok(len) = socket.try_recv(&mut bytes) {
        datagrams.push(bytes[..len].to_vec());
    }
    datagrams
}

fn not_found(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::NotFound, message.to_string())
}

const VIA_OLD: u8 = 0;
const VIA_NEW: u8 = 1;
const MUTE: u8 = 2;
const ONLY_OLD: u8 = 3;

/// A UDP relay in front of the peer at `to`. The client reaches it at
/// `old` or `new`, and the peer sees every datagram come from `back`.
/// `VIA_OLD` answers the client through `old`; `VIA_NEW` drops what
/// arrives at `old` and answers through `new`, as when the peer moved;
/// `ONLY_OLD` answers through `old` and drops what arrives at `new`, as
/// when the peer is back and the address it moved to is dark; `MUTE`
/// forwards nothing either way. Every datagram the peer sends is
/// also copied to `from_peer`, and every one `old` drops to `dark`.
struct Relay {
    old: SocketAddr,
    new: SocketAddr,
    back: SocketAddr,
    mode: Arc<AtomicU8>,
    from_peer: mpsc::UnboundedReceiver<Vec<u8>>,
    to_peer: mpsc::UnboundedReceiver<Vec<u8>>,
    at_new: mpsc::UnboundedReceiver<Vec<u8>>,
    old_socket: Arc<UdpSocket>,
    hold_responses: Arc<AtomicBool>,
    drop_next_probe: Arc<AtomicBool>,
    dark: mpsc::UnboundedReceiver<Vec<u8>>,
    task: JoinHandle<()>,
}

impl Relay {
    async fn new(to: SocketAddr) -> Self {
        let old = Arc::new(UdpSocket::bind("127.0.0.1:0").await.unwrap());
        let new = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let back = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let (old_at, new_at) = (old.local_addr().unwrap(), new.local_addr().unwrap());
        let back_at = back.local_addr().unwrap();
        let mode = Arc::new(AtomicU8::new(VIA_OLD));
        let (copy, from_peer) = mpsc::unbounded_channel();
        let (forwarded, to_peer) = mpsc::unbounded_channel();
        let (seen_new, at_new) = mpsc::unbounded_channel();
        let hold_responses = Arc::new(AtomicBool::new(false));
        let drop_next_probe = Arc::new(AtomicBool::new(false));
        let (dropped, dark) = mpsc::unbounded_channel();
        let task = tokio::spawn({
            let mode = mode.clone();
            let old = old.clone();
            let hold_responses = hold_responses.clone();
            let drop_next_probe = drop_next_probe.clone();
            async move {
                let mut client = None;
                let mut at_old = [0u8; 2048];
                let mut at_new = [0u8; 2048];
                let mut at_back = [0u8; 2048];
                loop {
                    tokio::select! {
                        received = old.recv_from(&mut at_old) => {
                            let Ok((len, from)) = received else { continue };
                            if matches!(mode.load(Ordering::SeqCst), VIA_OLD | ONLY_OLD) {
                                client = Some(from);
                                let _ = forwarded.send(at_old[..len].to_vec());
                                let _ = back.send_to(&at_old[..len], to).await;
                            } else {
                                let _ = dropped.send(at_old[..len].to_vec());
                            }
                        }
                        received = new.recv_from(&mut at_new) => {
                            let Ok((len, from)) = received else { continue };
                            let _ = seen_new.send(at_new[..len].to_vec());
                            if is_initiation(&at_new[..len]) && drop_next_probe.swap(false, Ordering::SeqCst) {
                                continue;
                            }
                            if matches!(mode.load(Ordering::SeqCst), VIA_OLD | VIA_NEW) {
                                client = Some(from);
                                let _ = forwarded.send(at_new[..len].to_vec());
                                let _ = back.send_to(&at_new[..len], to).await;
                            }
                        }
                        received = back.recv_from(&mut at_back) => {
                            let Ok((len, _)) = received else { continue };
                            let _ = copy.send(at_back[..len].to_vec());
                            if hold_responses.load(Ordering::SeqCst) {
                                continue;
                            }
                            let front = match mode.load(Ordering::SeqCst) {
                                VIA_OLD | ONLY_OLD => old.as_ref(),
                                VIA_NEW => &new,
                                _ => continue,
                            };
                            if let Some(client) = client {
                                let _ = front.send_to(&at_back[..len], client).await;
                            }
                        }
                    }
                }
            }
        });
        Self {
            old: old_at,
            new: new_at,
            back: back_at,
            mode,
            from_peer,
            to_peer,
            at_new,
            old_socket: old,
            hold_responses,
            drop_next_probe,
            dark,
            task,
        }
    }

    fn set(&self, mode: u8) {
        self.mode.store(mode, Ordering::SeqCst);
    }

    /// Initiations `old` dropped since the last call.
    fn dark_initiations(&mut self) -> usize {
        let mut count = 0;
        while let Ok(datagram) = self.dark.try_recv() {
            count += usize::from(is_initiation(&datagram));
        }
        count
    }
}

impl Drop for Relay {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// A session between the fixture's tunnels through the relay's old front.
async fn session_through(relay: &Relay, f: &mut Fixture) -> (Stream, Stream) {
    f.query().await.send(Ok(relay.old)).unwrap();
    let (mut a, mut b) = f.connect().await;
    exchange(&mut a, &mut b).await;
    assert_eq!(f.a.status().endpoint, Some(relay.old));
    (a, b)
}

/// The peer moves: the old front goes dark and the peer, speaking first,
/// is heard from the new one, which the client's endpoint follows.
async fn roam(relay: &Relay, client: &Tunnel, a: &mut Stream, b: &mut Stream) {
    relay.set(VIA_NEW);
    b.write_all(b"hi").await.unwrap();
    let mut two = [0; 2];
    timeout(WAIT, a.read_exact(&mut two))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(client.status().endpoint, Some(relay.new));
}

/// Mute the relay once the peer has nothing left to resend. The clock the
/// tests advance is the peer's too: a peer still holding unacknowledged
/// data would start a handshake of its own after the jump, and its own
/// lookup, past `STALE_HANDSHAKE`, would send it to the client directly.
async fn settle_then_mute(relay: &Relay, a: &mut Stream, b: &mut Stream) {
    exchange(a, b).await;
    tokio::time::sleep(4 * TICK).await;
    relay.set(MUTE);
}

fn fresh_handshake(tunnel: &Tunnel, within: Duration) -> bool {
    matches!(tunnel.status().handshake, HandshakeState::Live(age) if age < within)
}

#[tokio::test]
async fn unresolved_start_returns_and_recovers_without_restart() {
    let _clock = clock::test_offset_guard();
    let mut f = Fixture::new().await;
    // No task has been polled: construction cannot wait on the resolver.
    assert_eq!(f.a.status().endpoint, None);
    let query = f.query().await;
    assert_eq!(f.a.status().handshake, HandshakeState::Never);
    let connecting = tokio::spawn({
        let a = f.a.clone();
        async move { a.connect(b_port(80)).await }
    });
    tokio::time::sleep(2 * TICK).await;
    query.send(Err(not_found("name absent"))).unwrap();
    let error = timeout(WAIT, connecting)
        .await
        .unwrap()
        .unwrap()
        .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("endpoint did not resolve: peer.test:"),
        "{error}"
    );
    assert!(error.to_string().contains("name absent"), "{error}");
    assert_eq!(error.kind(), io::ErrorKind::NotFound);

    // The held initiation retries the lookup on its own; the next answer
    // brings the tunnel up with no new demand and no restart.
    clock::advance(REKEY_TIMEOUT + TICK);
    f.query().await.send(Ok(f.b_at)).unwrap();
    until(|| matches!(f.a.status().handshake, HandshakeState::Live(_))).await;
    assert_eq!(f.a.status().resolution_error, None);
    let (mut a, mut b) = f.connect().await;
    exchange(&mut a, &mut b).await;
}

/// A live session's rekey lookup answers a new address while the old
/// path is muted, so it gets a copy of the initiation in flight. After
/// expiry the next answer takes the endpoint and gets a fresh initiation.
#[tokio::test]
async fn live_rekey_and_expiry_follow_the_next_lookup() {
    let _clock = clock::test_offset_guard();
    let mut f = Fixture::new().await;
    let relay = Relay::new(f.b_at).await;
    let (mut a, mut b) = session_through(&relay, &mut f).await;
    settle_then_mute(&relay, &mut a, &mut b).await;
    let moved = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    clock::advance(Duration::from_secs(121));
    f.query()
        .await
        .send(Ok(moved.local_addr().unwrap()))
        .unwrap();
    initiation(&moved).await;
    assert!(
        matches!(f.a.status().handshake, HandshakeState::Live(_)),
        "rekey while the session lives"
    );
    // Keep the old peer from initiating a handshake of its own at expiry.
    drop(f.b);
    clock::advance(Duration::from_secs(91));
    until(|| f.a.inner.wire.lock().tunn.is_expired()).await;
    let after_expiry = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    a.write_all(b"after expiry").await.unwrap();
    let query = timeout(WAIT, f.queries.recv()).await.unwrap().unwrap();
    query.send(Ok(after_expiry.local_addr().unwrap())).unwrap();
    initiation(&after_expiry).await;
    assert_eq!(
        f.a.status().endpoint,
        Some(after_expiry.local_addr().unwrap())
    );
}

/// The lookup a rekey starts never returns, as a hung `getaddrinfo`. The
/// rekey goes to the known endpoint without waiting for it, the session
/// keeps carrying data, the timeout lands in the status, the tunnel
/// outlives the first session's `REJECT_AFTER_TIME`, and the next rekey
/// goes out beside the still-owned lookup instead of starting another.
#[tokio::test]
async fn a_hung_lookup_keeps_a_live_session_past_reject_after_time() {
    let _clock = clock::test_offset_guard();
    let mut f = Fixture::new().await;
    let (mut a, mut b) = f.establish().await;
    exchange(&mut a, &mut b).await;
    clock::advance(Duration::from_secs(121));
    let _hung = f.query().await;
    let waiting = tokio::time::Instant::now();
    while waiting.elapsed() < RESOLVE_TIMEOUT + Duration::from_secs(1) {
        exchange(&mut a, &mut b).await;
        tokio::time::sleep(TICK).await;
    }
    until(|| fresh_handshake(&f.a, Duration::from_secs(60))).await;
    let error = f.a.status().resolution_error.unwrap();
    assert!(error.contains("lookup timed out"), "{error}");

    clock::advance(Duration::from_secs(60));
    exchange(&mut a, &mut b).await;
    clock::advance(Duration::from_secs(100));
    until(|| fresh_handshake(&f.a, REKEY_TIMEOUT)).await;
    assert!(
        f.queries.try_recv().is_err(),
        "one lookup in flight: the hung one"
    );
    exchange(&mut a, &mut b).await;
}

/// Walk the clock 190 s in 5 s steps, past `REJECT_AFTER_TIME`, handing
/// every lookup the tunnel starts to `answer`; returns how many it started.
async fn walk_past_reject(f: &mut Fixture, mut answer: impl FnMut(Answer)) -> usize {
    let mut lookups = 0;
    for _ in 0..38 {
        clock::advance(Duration::from_secs(5));
        tokio::time::sleep(2 * TICK).await;
        while let Ok(query) = f.queries.try_recv() {
            lookups += 1;
            answer(query);
        }
        tokio::time::sleep(2 * TICK).await;
    }
    lookups
}

#[tokio::test]
async fn idle_persistent_keepalive_keeps_driver_status_live() {
    let _clock = clock::test_offset_guard();
    let mut f = Fixture::build_with_keepalive(true, Some(25)).await;
    f.query().await.send(Ok(f.b_at)).unwrap();
    clock::advance(Duration::from_secs(25));
    until(|| fresh_handshake(&f.a, REKEY_TIMEOUT)).await;
    for step in 1..=24 {
        clock::advance(Duration::from_secs(25));
        let started = tokio::time::Instant::now();
        while started.elapsed() < 2 * TICK {
            while let Ok(query) = f.queries.try_recv() {
                query.send(Ok(f.b_at)).unwrap();
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let status = f.a.status();
        assert!(
            matches!(status.handshake, HandshakeState::Live(age) if age < Duration::from_secs(150)),
            "idle step {step}: keepalives must renew the live session: {status:?}"
        );
        assert_eq!(
            (status.tx_bytes, status.rx_bytes),
            (0, 0),
            "no payload drives this renewal"
        );
    }
}

#[tokio::test]
async fn rekeys_past_reject_after_time_with_working_lookups() {
    let _clock = clock::test_offset_guard();
    let mut f = Fixture::new().await;
    let (mut a, mut b) = f.establish().await;
    exchange(&mut a, &mut b).await;
    let b_at = f.b_at;
    walk_past_reject(&mut f, |query| {
        let _ = query.send(Ok(b_at));
    })
    .await;
    exchange(&mut a, &mut b).await;
}

#[tokio::test]
async fn failing_lookups_keep_rekeying_to_the_known_endpoint() {
    let _clock = clock::test_offset_guard();
    let mut f = Fixture::new().await;
    let (mut a, mut b) = f.establish().await;
    exchange(&mut a, &mut b).await;
    let lookups = walk_past_reject(&mut f, |query| {
        let _ = query.send(Err(io::Error::other("resolver down")));
    })
    .await;
    assert!(lookups > 0, "the rekey still asks for a lookup");
    exchange(&mut a, &mut b).await;
    let status = f.a.status();
    assert!(
        matches!(status.handshake, HandshakeState::Live(age) if age < Duration::from_secs(180)),
        "{status:?}"
    );
    assert!(
        status
            .resolution_error
            .as_deref()
            .is_some_and(|error| error.contains("resolver down")),
        "the failure stays in the status: {status:?}"
    );
}

#[tokio::test]
async fn start_on_endpoint_carries_the_handshake_while_the_name_fails() {
    let _clock = clock::test_offset_guard();
    let mut f = Fixture::build(true).await;
    f.query()
        .await
        .send(Err(not_found("host resolver cannot see it")))
        .unwrap();
    let (mut a, mut b) = f.connect().await;
    exchange(&mut a, &mut b).await;
    let status = f.a.status();
    assert_eq!(status.endpoint, Some(f.b_at));
    assert!(status.resolution_error.is_some(), "{status:?}");
}

/// No lookup has answered yet when the peer roams, so only the endpoint
/// `start_on` was given can say the rekey's answer, that same address, is
/// unchanged: nothing goes there, and the session stays where the peer
/// moved.
#[tokio::test]
async fn start_on_endpoint_stands_as_the_previous_answer() {
    let _clock = clock::test_offset_guard();
    let a_key = StaticSecret::random_from_rng(OsRng);
    let b_key = StaticSecret::random_from_rng(OsRng);
    let (a_pub, b_pub) = (PublicKey::from(&a_key), PublicKey::from(&b_key));
    let a_udp = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let b_udp = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let a_at = a_udp.local_addr().unwrap();
    let mut relay = Relay::new(b_udp.local_addr().unwrap()).await;
    let mut a_config = config(a_key, b_pub, A_ADDR, B_ADDR, relay.old);
    a_config.peer.endpoint.host = "peer.test".into();
    let (lookup, mut queries) = controlled_lookup();
    let resolver = Resolver::with_lookup(a_config.peer.endpoint.clone(), lookup);
    let mut sockets = Sockets::default();
    sockets.insert(a_udp).unwrap();
    // As `start_on` builds it, with the lookups under the test's control.
    let client = Tunnel::build(a_config, sockets, Some(relay.old), resolver).unwrap();
    let server = Tunnel::start_on(config(b_key, a_pub, B_ADDR, A_ADDR, a_at), b_udp, a_at).unwrap();
    let query = timeout(WAIT, queries.recv()).await.unwrap().unwrap();
    query.send(Err(not_found("not yet"))).unwrap();
    let mut listener = server.listen(0).unwrap();
    let port = listener.port();
    let (a, b) = timeout(WAIT, async {
        tokio::join!(client.connect(b_port(port)), listener.accept())
    })
    .await
    .unwrap();
    let (mut a, mut b) = (a.unwrap(), b.unwrap());
    exchange(&mut a, &mut b).await;
    roam(&relay, &client, &mut a, &mut b).await;
    clock::advance(Duration::from_secs(121));
    let query = timeout(WAIT, queries.recv()).await.unwrap().unwrap();
    tokio::time::sleep(8 * TICK).await;
    relay.dark_initiations();
    query.send(Ok(relay.old)).unwrap();
    until(|| fresh_handshake(&client, Duration::from_secs(60))).await;
    tokio::time::sleep(8 * TICK).await;
    assert_eq!(
        relay.dark_initiations(),
        0,
        "nothing goes to the address start_on was given"
    );
    assert_eq!(client.status().endpoint, Some(relay.new));
    exchange(&mut a, &mut b).await;
}

/// A peer that never answers: each retry goes to the known endpoint at
/// once, asks for at most one lookup at a time and none within five
/// seconds of the last, and an answer naming the endpoint in use sends
/// nothing more.
#[tokio::test]
async fn silent_peer_limits_lookups_and_retries_at_once() {
    let _clock = clock::test_offset_guard();
    let mut f = Fixture::new().await;
    let silent = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    f.query()
        .await
        .send(Ok(silent.local_addr().unwrap()))
        .unwrap();
    let pending = tokio::spawn({
        let a = f.a.clone();
        async move { a.connect(b_port(80)).await }
    });
    initiation(&silent).await;
    for _ in 0..3 {
        clock::advance(Duration::from_secs(1));
        tokio::time::sleep(2 * TICK).await;
        assert!(
            f.queries.try_recv().is_err(),
            "no lookup before five seconds"
        );
    }
    clock::advance(Duration::from_secs(3));
    let query = f.query().await;
    initiation_within(&silent, REKEY_TIMEOUT / 2).await;
    clock::advance(Duration::from_secs(6));
    initiation_within(&silent, REKEY_TIMEOUT / 2).await;
    assert!(
        f.queries.try_recv().is_err(),
        "no overlapping lookup on another retry"
    );
    query.send(Ok(silent.local_addr().unwrap())).unwrap();
    tokio::time::sleep(4 * TICK).await;
    assert!(
        drain(&silent).is_empty(),
        "an answer naming the endpoint in use sends nothing"
    );
    pending.abort();
}

#[tokio::test]
async fn timeout_retains_one_lookup_then_allows_recovery() {
    let _clock = clock::test_offset_guard();
    let mut f = Fixture::new().await;
    let query = f.query().await;
    let a = f.a.clone();
    let connecting = tokio::spawn(async move { a.connect(b_port(80)).await });
    let error = timeout(RESOLVE_TIMEOUT + Duration::from_secs(3), connecting)
        .await
        .unwrap()
        .unwrap()
        .unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::TimedOut);
    assert!(error.to_string().contains("endpoint did not resolve"));
    assert!(error.to_string().contains("lookup timed out"));
    clock::advance(Duration::from_secs(20));
    tokio::time::sleep(2 * TICK).await;
    assert!(
        f.queries.try_recv().is_err(),
        "timeout must retain the OS lookup"
    );
    query.send(Ok(f.b_at)).unwrap();
    until(|| f.a.status().resolution_error.is_none()).await;
    let (mut a, mut b) = f.connect().await;
    exchange(&mut a, &mut b).await;
}

#[tokio::test]
async fn failed_lookups_do_not_retry_on_every_tick() {
    let _clock = clock::test_offset_guard();
    let mut f = Fixture::new().await;
    let query = f.query().await;
    let connecting = tokio::spawn({
        let a = f.a.clone();
        async move { a.connect(b_port(80)).await }
    });
    tokio::time::sleep(2 * TICK).await;
    query
        .send(Err(io::Error::new(io::ErrorKind::NotFound, "name absent")))
        .unwrap();
    assert!(connecting.await.unwrap().is_err());
    tokio::time::sleep(4 * TICK).await;
    assert!(
        f.queries.try_recv().is_err(),
        "a failed lookup must not retry each tick"
    );
    clock::advance(REKEY_TIMEOUT + TICK);
    let _retry = f.query().await;
}

#[tokio::test]
async fn a_connect_after_a_failed_lookup_waits_for_the_lookup_it_starts() {
    let _clock = clock::test_offset_guard();
    let mut f = Fixture::new().await;
    f.query().await.send(Err(not_found("name absent"))).unwrap();
    until(|| f.a.status().resolution_error.is_some()).await;
    clock::advance(REKEY_TIMEOUT + TICK);
    let mut listener = f.b.listen(0).unwrap();
    let port = listener.port();
    let connecting = tokio::spawn({
        let a = f.a.clone();
        async move { a.connect(b_port(port)).await }
    });
    // The lookup this connect starts succeeds.
    f.query().await.send(Ok(f.b_at)).unwrap();
    let (a, b) = timeout(WAIT, async { tokio::join!(connecting, listener.accept()) })
        .await
        .unwrap();
    let (mut a, mut b) = (a.unwrap().unwrap(), b.unwrap());
    exchange(&mut a, &mut b).await;
}

#[tokio::test]
async fn a_connect_during_a_stalled_lookup_fails_at_once_with_the_timeout() {
    let _clock = clock::test_offset_guard();
    let mut f = Fixture::new().await;
    let _stalled = f.query().await;
    timeout(RESOLVE_TIMEOUT + Duration::from_secs(3), async {
        while f.a.status().resolution_error.is_none() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    // No other lookup can end while the timed-out one holds the OS call.
    let error = timeout(Duration::from_secs(1), f.a.connect(b_port(80)))
        .await
        .expect("a connect has nothing to wait for")
        .unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::TimedOut);
    assert!(error.to_string().contains("lookup timed out"), "{error}");
}

#[tokio::test]
async fn authenticated_roaming_and_a_later_lookup_both_move_the_endpoint() {
    let _clock = clock::test_offset_guard();
    let mut f = Fixture::new().await;
    let (mut a, mut b) = f.establish().await;
    exchange(&mut a, &mut b).await;
    let roam = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let mut packet = [0; 256];
    let sealed = {
        let mut wire = f.b.inner.wire.lock();
        let TunnResult::WriteToNetwork(bytes) = wire.tunn.encapsulate(&[], &mut packet) else {
            panic!("established session")
        };
        bytes.to_vec()
    };
    roam.send_to(&sealed, f.a_at).await.unwrap();
    until(|| f.a.status().endpoint == Some(roam.local_addr().unwrap())).await;
    // The old peer must not start a competing handshake when both clocks
    // advance; only the client's next initiation is under test here.
    drop(f.b);
    let moved = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    // Nothing answers at the roamed address, so by the time the rekey's
    // lookup answers the session is past STALE_HANDSHAKE and the answer
    // takes the endpoint. The rekey left for the roamed address before
    // the answer, so the new address gets its own initiation at once,
    // well inside the retry interval.
    clock::advance(STALE_HANDSHAKE + Duration::from_secs(5));
    timeout(WAIT, f.queries.recv())
        .await
        .unwrap()
        .unwrap()
        .send(Ok(moved.local_addr().unwrap()))
        .unwrap();
    initiation_within(&moved, REKEY_TIMEOUT / 2).await;
    assert_eq!(f.a.status().endpoint, Some(moved.local_addr().unwrap()));
}

/// The peer roams while its DNS record still names the address it left.
/// The rekey's lookup answers that unchanged address; the endpoint stays
/// where the peer authenticated from and the rekey reaches it there.
#[tokio::test]
async fn an_unchanged_answer_does_not_undo_a_live_roam() {
    let _clock = clock::test_offset_guard();
    let mut f = Fixture::new().await;
    let mut relay = Relay::new(f.b_at).await;
    let (mut a, mut b) = session_through(&relay, &mut f).await;
    roam(&relay, &f.a, &mut a, &mut b).await;
    exchange(&mut a, &mut b).await;
    clock::advance(Duration::from_secs(121));
    let query = f.query().await;
    // Let both sides' post-jump timers (keepalives) flush before the answer.
    tokio::time::sleep(8 * TICK).await;
    relay.dark_initiations();
    query.send(Ok(relay.old)).unwrap();
    until(|| fresh_handshake(&f.a, Duration::from_secs(60))).await;
    tokio::time::sleep(8 * TICK).await;
    assert_eq!(
        relay.dark_initiations(),
        0,
        "nothing goes to the old address"
    );
    assert_eq!(f.a.status().endpoint, Some(relay.new));
    exchange(&mut a, &mut b).await;
}

/// The control for the case above: the record moved with the peer.
#[tokio::test]
async fn a_rekey_lookup_answering_the_roamed_address_keeps_the_session() {
    let _clock = clock::test_offset_guard();
    let mut f = Fixture::new().await;
    let relay = Relay::new(f.b_at).await;
    let (mut a, mut b) = session_through(&relay, &mut f).await;
    roam(&relay, &f.a, &mut a, &mut b).await;
    exchange(&mut a, &mut b).await;
    clock::advance(Duration::from_secs(121));
    let query = f.query().await;
    tokio::time::sleep(8 * TICK).await;
    query.send(Ok(relay.new)).unwrap();
    until(|| fresh_handshake(&f.a, Duration::from_secs(60))).await;
    assert_eq!(f.a.status().endpoint, Some(relay.new));
    exchange(&mut a, &mut b).await;
}

/// The rekey's lookup starts before the peer roams and ends after it,
/// still naming the old address: completing later does not let it win.
#[tokio::test]
async fn a_lookup_started_before_a_roam_does_not_undo_it() {
    let _clock = clock::test_offset_guard();
    let mut f = Fixture::new().await;
    let mut relay = Relay::new(f.b_at).await;
    let (mut a, mut b) = session_through(&relay, &mut f).await;
    clock::advance(Duration::from_secs(121));
    let query = f.query().await;
    roam(&relay, &f.a, &mut a, &mut b).await;
    relay.dark_initiations();
    query.send(Ok(relay.old)).unwrap();
    until(|| fresh_handshake(&f.a, Duration::from_secs(60))).await;
    tokio::time::sleep(8 * TICK).await;
    assert_eq!(
        relay.dark_initiations(),
        0,
        "nothing goes to the old address"
    );
    assert_eq!(f.a.status().endpoint, Some(relay.new));
    exchange(&mut a, &mut b).await;
}

/// The roamed path goes quiet. Past `STALE_HANDSHAKE` it is presumed
/// dead, and even an unchanged answer moves the endpoint back to the
/// name's address, where the peer is again and the session resumes. The
/// roamed address stays dark, so only the answer can move the endpoint.
#[tokio::test]
async fn after_a_stale_handshake_an_unchanged_answer_moves_the_endpoint() {
    let _clock = clock::test_offset_guard();
    let mut f = Fixture::new().await;
    let relay = Relay::new(f.b_at).await;
    let (mut a, mut b) = session_through(&relay, &mut f).await;
    roam(&relay, &f.a, &mut a, &mut b).await;
    settle_then_mute(&relay, &mut a, &mut b).await;
    clock::advance(STALE_HANDSHAKE + Duration::from_secs(5));
    let query = f.query().await;
    // The keepalives after the jump and the rekey, which leaves for the
    // roamed address at once, die in the muted relay.
    tokio::time::sleep(8 * TICK).await;
    assert_eq!(f.a.status().endpoint, Some(relay.new));
    relay.set(ONLY_OLD);
    query.send(Ok(relay.old)).unwrap();
    until(|| f.a.status().endpoint == Some(relay.old)).await;
    exchange(&mut a, &mut b).await;
}

/// The far side of the desktop e2e (`wg-peer`) starts with a placeholder
/// endpoint and learns the client's address from its first handshake.
/// Its own lookups answer the placeholder; while the handshake is fresh
/// they must not move the endpoint back to it, or its initiations (here
/// the one after fifteen unanswered seconds) would go nowhere.
#[tokio::test]
async fn the_responders_placeholder_does_not_capture_its_initiations() {
    let _clock = clock::test_offset_guard();
    let a_key = StaticSecret::random_from_rng(OsRng);
    let b_key = StaticSecret::random_from_rng(OsRng);
    let (a_pub, b_pub) = (PublicKey::from(&a_key), PublicKey::from(&b_key));
    let a_udp = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let b_udp = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let mut relay = Relay::new(b_udp.local_addr().unwrap()).await;
    let placeholder = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let placeholder_at = placeholder.local_addr().unwrap();
    let b = Tunnel::start_on(
        config(b_key, a_pub, B_ADDR, A_ADDR, placeholder_at),
        b_udp,
        placeholder_at,
    )
    .unwrap();
    let a = Tunnel::start_on(
        config(a_key, b_pub, A_ADDR, B_ADDR, relay.old),
        a_udp,
        relay.old,
    )
    .unwrap();
    let mut listener = b.listen(0).unwrap();
    let port = listener.port();
    let (client, server) = timeout(WAIT, async {
        tokio::join!(a.connect(b_port(port)), listener.accept())
    })
    .await
    .unwrap();
    let (mut client, mut server) = (client.unwrap(), server.unwrap());
    exchange(&mut client, &mut server).await;
    assert_eq!(b.status().endpoint, Some(relay.back));

    relay.set(MUTE);
    while relay.from_peer.try_recv().is_ok() {}
    server.write_all(b"unheard").await.unwrap();
    clock::advance(Duration::from_secs(16));
    timeout(WAIT, async {
        while !is_initiation(&relay.from_peer.recv().await.unwrap()) {}
    })
    .await
    .expect("the responder's initiation goes to the client's address");
    let mut bytes = [0; 256];
    assert!(
        placeholder.try_recv_from(&mut bytes).is_err(),
        "nothing goes to the placeholder"
    );
    assert_eq!(b.status().endpoint, Some(relay.back));
}

#[tokio::test]
async fn endpoint_moves_between_ipv4_and_ipv6() {
    let _clock = clock::test_offset_guard();
    let mut f = Fixture::new().await;
    let silent4 = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let silent6 = UdpSocket::bind("[::1]:0").await.unwrap();
    f.query()
        .await
        .send(Ok(silent4.local_addr().unwrap()))
        .unwrap();
    let connecting = tokio::spawn({
        let a = f.a.clone();
        async move { a.connect(b_port(80)).await }
    });
    assert!(initiation(&silent4).await.is_ipv4());
    clock::advance(Duration::from_secs(6));
    f.query()
        .await
        .send(Ok(silent6.local_addr().unwrap()))
        .unwrap();
    assert!(initiation(&silent6).await.is_ipv6());
    assert_eq!(
        drain(&silent4).len(),
        1,
        "the retry went to the known endpoint before the answer"
    );
    // Cancel TCP demand so a retransmitted SYN cannot restart the core
    // before expiry is observed. Expiry resets the tried addresses.
    cancel_connect(&f.a, connecting).await;
    clock::advance(Duration::from_secs(91));
    until_expired(
        &f.a,
        "the unanswered IPv6 handshake expires after 91 seconds",
    )
    .await;
    let retry = tokio::spawn({
        let client = f.a.clone();
        async move { client.connect(b_port(81)).await }
    });
    f.query()
        .await
        .send(Ok(silent4.local_addr().unwrap()))
        .unwrap();
    assert_eq!(
        initiation(&silent4).await,
        f.a_at,
        "the old family socket is retained"
    );
    retry.abort();
}

/// `Tunnel::start` holds no socket until its first answer binds one of
/// the answer's family; the fixtures above all bring their own.
#[tokio::test]
async fn start_binds_its_socket_from_the_first_answer() {
    let a_key = StaticSecret::random_from_rng(OsRng);
    let b_key = StaticSecret::random_from_rng(OsRng);
    let (a_pub, b_pub) = (PublicKey::from(&a_key), PublicKey::from(&b_key));
    let b_udp = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let b_at = b_udp.local_addr().unwrap();
    let placeholder = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let placeholder_at = placeholder.local_addr().unwrap();
    let b = Tunnel::start_on(
        config(b_key, a_pub, B_ADDR, A_ADDR, placeholder_at),
        b_udp,
        placeholder_at,
    )
    .unwrap();
    // An IP literal resolves without a DNS query.
    let a = Tunnel::start(config(a_key, b_pub, A_ADDR, B_ADDR, b_at)).unwrap();
    let mut listener = b.listen(0).unwrap();
    let port = listener.port();
    let (client, server) = timeout(WAIT, async {
        tokio::join!(a.connect(b_port(port)), listener.accept())
    })
    .await
    .unwrap();
    exchange(&mut client.unwrap(), &mut server.unwrap()).await;
    assert_eq!(a.status().endpoint, Some(b_at));
    let from = b.status().endpoint.unwrap();
    assert!(
        from.is_ipv4() && !from.ip().is_unspecified() && from != placeholder_at,
        "{from}"
    );
}

/// Makes this thread's socket binds fail until dropped.
struct RefuseBind;

impl RefuseBind {
    fn new() -> Self {
        REFUSE_BIND.set(true);
        RefuseBind
    }
}

impl Drop for RefuseBind {
    fn drop(&mut self) {
        REFUSE_BIND.set(false);
    }
}

#[tokio::test]
async fn a_bind_failure_reads_as_one() {
    let _clock = clock::test_offset_guard();
    let _refuse = RefuseBind::new();
    let mut f = Fixture::new().await;
    // The fixture holds an IPv4 socket, so an IPv6 answer needs a bind.
    let answer: SocketAddr = "[::1]:51820".parse().unwrap();
    f.query().await.send(Ok(answer)).unwrap();
    until(|| f.a.status().resolution_error.is_some()).await;
    let error = f.a.status().resolution_error.unwrap();
    assert!(
        error.starts_with("binding a UDP socket for [::1]:51820: "),
        "{error}"
    );
    assert_eq!(
        f.a.status().endpoint,
        None,
        "an answer without a socket is not used"
    );
}

/// Records events on this thread, including their structured fields.
#[derive(Clone, Default)]
struct Events(Arc<Mutex<Vec<RecordedEvent>>>);

#[derive(Clone, Debug)]
struct RecordedEvent {
    level: String,
    target: String,
    message: String,
    fields: Vec<(String, String)>,
}

impl RecordedEvent {
    fn field(&self, name: &str) -> &str {
        &self.fields.iter().find(|(key, _)| key == name).unwrap().1
    }
}

impl Events {
    fn endpoint_lines(&self) -> Vec<(String, String)> {
        self.0
            .lock()
            .iter()
            .filter(|event| event.message.starts_with("WireGuard endpoint"))
            .map(|event| (event.level.clone(), event.message.clone()))
            .collect()
    }
}

impl tracing::Subscriber for Events {
    fn enabled(&self, _: &tracing::Metadata<'_>) -> bool {
        true
    }

    fn new_span(&self, _: &tracing::span::Attributes<'_>) -> tracing::span::Id {
        tracing::span::Id::from_u64(1)
    }

    fn record(&self, _: &tracing::span::Id, _: &tracing::span::Record<'_>) {}

    fn record_follows_from(&self, _: &tracing::span::Id, _: &tracing::span::Id) {}

    fn event(&self, event: &tracing::Event<'_>) {
        struct Fields {
            message: String,
            fields: Vec<(String, String)>,
        }
        impl tracing::field::Visit for Fields {
            fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
                if field.name() == "message" {
                    self.message = format!("{value:?}");
                } else {
                    self.fields
                        .push((field.name().to_string(), format!("{value:?}")));
                }
            }
        }
        let mut fields = Fields {
            message: String::new(),
            fields: Vec::new(),
        };
        event.record(&mut fields);
        self.0.lock().push(RecordedEvent {
            level: event.metadata().level().to_string(),
            target: event.metadata().target().to_string(),
            message: fields.message,
            fields: fields.fields,
        });
    }

    fn enter(&self, _: &tracing::span::Id) {}

    fn exit(&self, _: &tracing::span::Id) {}
}

/// A lookup fails every few seconds while demand lasts; the log says so
/// at warn when a failure starts or changes, and at debug while it repeats.
/// The recovery logs at warn too, once, so a warn filter sees both ends.
#[tokio::test]
async fn lookup_failures_warn_when_they_start_or_change() {
    let events = Events::default();
    let dispatch = tracing::Dispatch::new(events.clone());
    // With one dispatcher registered, tracing-core computes a callsite's
    // interest from the default of whichever thread first reaches it, so
    // a callsite a parallel test reached first stays disabled here too. A
    // second registered dispatcher makes it ask every registered one.
    let _second = tracing::Dispatch::new(Events::default());
    let _subscriber = tracing::dispatcher::set_default(&dispatch);
    let _clock = clock::test_offset_guard();
    let mut f = Fixture::new().await;
    let _connecting = tokio::spawn({
        let a = f.a.clone();
        async move { a.connect(b_port(80)).await }
    });
    f.query().await.send(Err(not_found("name absent"))).unwrap();
    for answer in [not_found("name absent"), not_found("server failure")] {
        clock::advance(REKEY_TIMEOUT + TICK);
        f.query().await.send(Err(answer)).unwrap();
    }
    clock::advance(REKEY_TIMEOUT + TICK);
    f.query().await.send(Ok(f.b_at)).unwrap();
    until(|| matches!(f.a.status().handshake, HandshakeState::Live(_))).await;
    // Both peers share the test clock. Stop the peer so its dead-peer
    // handshake cannot make the client a responder before its rekey.
    drop(f.b);
    // The rekey's lookup fails as the last one before the recovery did:
    // a new failure, not a repeat.
    clock::advance(Duration::from_secs(121));
    timeout(WAIT, f.queries.recv())
        .await
        .expect("the recovered client's rekey requests a lookup")
        .expect("the resolver remains alive")
        .send(Err(not_found("server failure")))
        .unwrap();
    until(|| f.a.status().resolution_error.is_some()).await;
    let lines = events.endpoint_lines();
    let lines: Vec<(&str, &str)> = lines
        .iter()
        .map(|(level, message)| (level.as_str(), message.as_str()))
        .collect();
    assert_eq!(
        lines,
        [
            ("WARN", "WireGuard endpoint failed; retrying"),
            ("DEBUG", "WireGuard endpoint still failing; retrying"),
            ("WARN", "WireGuard endpoint failed; retrying"),
            ("WARN", "WireGuard endpoint lookup recovered"),
            ("WARN", "WireGuard endpoint failed; retrying"),
        ]
    );
}

#[tokio::test]
async fn slow_lookup_starts_the_retry_clock_at_transmission() {
    let _clock = clock::test_offset_guard();
    let mut f = Fixture::new().await;
    let query = f.query().await;
    let silent = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let connecting = tokio::spawn({
        let a = f.a.clone();
        async move { a.connect(b_port(80)).await }
    });
    tokio::time::sleep(TICK).await;
    clock::advance(Duration::from_secs(4));
    query.send(Ok(silent.local_addr().unwrap())).unwrap();
    initiation(&silent).await;
    clock::advance(Duration::from_secs(2));
    tokio::time::sleep(2 * TICK).await;
    let mut bytes = [0; 256];
    assert!(
        silent.try_recv_from(&mut bytes).is_err(),
        "a slow lookup must not consume the retry interval before transmission"
    );
    assert!(f.queries.try_recv().is_err());
    connecting.abort();
}

/// A differing answer received after a rekey waits for the next genuine
/// attempt. Its probe carries no session data, and an answer naming the
/// live endpoint leaves that endpoint alone.
#[tokio::test]
async fn a_changed_answer_gets_only_a_handshake_while_the_session_is_fresh() {
    let _clock = clock::test_offset_guard();
    let mut f = Fixture::new().await;
    let relay = Relay::new(f.b_at).await;
    let (mut a, mut b) = session_through(&relay, &mut f).await;
    let dead = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    clock::advance(Duration::from_secs(121));
    let query = f.query().await;
    until(|| fresh_handshake(&f.a, REKEY_TIMEOUT)).await;
    query.send(Ok(dead.local_addr().unwrap())).unwrap();
    tokio::time::sleep(2 * TICK).await;
    assert!(drain(&dead).is_empty(), "a late answer starts no handshake");
    exchange(&mut a, &mut b).await;
    clock::advance(Duration::from_secs(121));
    f.query().await.send(Ok(relay.old)).unwrap();
    initiation(&dead).await;
    assert_eq!(f.a.status().endpoint, Some(relay.old));
    exchange(&mut a, &mut b).await;
    for datagram in drain(&dead) {
        assert!(is_initiation(&datagram), "data reached the dead address");
    }
}

/// The record moved with the peer before the old path closed. The rekey's
/// lookup answers the new address while the session is fresh; that
/// address gets an initiation, the peer answers from there, and roaming
/// moves the endpoint.
#[tokio::test]
async fn a_changed_answer_moves_the_endpoint_once_the_peer_answers_there() {
    let _clock = clock::test_offset_guard();
    let mut f = Fixture::new().await;
    let relay = Relay::new(f.b_at).await;
    let (mut a, mut b) = session_through(&relay, &mut f).await;
    settle_then_mute(&relay, &mut a, &mut b).await;
    clock::advance(Duration::from_secs(121));
    let query = f.query().await;
    // The keepalives after the jump and the rekey sent to the old address
    // die in the muted relay, so the peer has nothing left to say until
    // an initiation reaches it at the new address.
    tokio::time::sleep(8 * TICK).await;
    relay.set(VIA_NEW);
    query.send(Ok(relay.new)).unwrap();
    until(|| f.a.status().endpoint == Some(relay.new)).await;
    exchange(&mut a, &mut b).await;
}

/// How long the slow resolver below takes: inside `RESOLVE_TIMEOUT`.
const SLOW_ANSWER: Duration = Duration::from_secs(8);

/// A rekey's lookup that answers after `SLOW_ANSWER`, with the time the
/// tunnel asked for it; the rekey completes while it is held.
async fn rekey_beside_a_slow_lookup(f: &mut Fixture) -> (Answer, tokio::time::Instant) {
    clock::advance(Duration::from_secs(121));
    let query = f.query().await;
    let asked = tokio::time::Instant::now();
    timeout(SLOW_ANSWER - Duration::from_secs(1), async {
        while !fresh_handshake(&f.a, Duration::from_secs(60)) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the rekey completes before the lookup answers");
    tokio::time::sleep_until(asked + SLOW_ANSWER).await;
    (query, asked)
}

/// With an endpoint known, a rekey goes out at once and does not wait for
/// the lookup it asks for.
#[tokio::test]
async fn a_slow_lookup_does_not_delay_a_rekey_to_the_known_endpoint() {
    let _clock = clock::test_offset_guard();
    let mut f = Fixture::new().await;
    let (mut a, mut b) = f.establish().await;
    exchange(&mut a, &mut b).await;
    let (query, _) = rekey_beside_a_slow_lookup(&mut f).await;
    query.send(Ok(f.b_at)).unwrap();
    exchange(&mut a, &mut b).await;
    assert_eq!(f.a.status().endpoint, Some(f.b_at));
}

/// A differing slow answer arrives after the rekey completed. It is
/// remembered for the next genuine attempt instead of starting another.
#[tokio::test]
async fn a_differing_slow_answer_waits_for_the_next_attempt() {
    let _clock = clock::test_offset_guard();
    let mut f = Fixture::new().await;
    let (mut a, mut b) = f.establish().await;
    exchange(&mut a, &mut b).await;
    let other = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let (query, _) = rekey_beside_a_slow_lookup(&mut f).await;
    query.send(Ok(other.local_addr().unwrap())).unwrap();
    tokio::time::sleep(2 * TICK).await;
    assert!(
        drain(&other).is_empty(),
        "a late answer starts no handshake"
    );
    exchange(&mut a, &mut b).await;
    clock::advance(Duration::from_secs(121));
    f.query().await.send(Ok(f.b_at)).unwrap();
    initiation_within(&other, REKEY_TIMEOUT / 2).await;
    assert_eq!(f.a.status().endpoint, Some(f.b_at));
    exchange(&mut a, &mut b).await;
}

/// A timed-out lookup holds the OS call and nothing retries until it
/// returns: the status and the log say it is stalled, not retrying, and
/// the recovery when the call returns logs at warn.
#[tokio::test]
async fn a_stalled_lookup_reads_as_stalled_until_its_call_returns() {
    let events = Events::default();
    let dispatch = tracing::Dispatch::new(events.clone());
    // See lookup_failures_warn_when_they_start_or_change.
    let _second = tracing::Dispatch::new(Events::default());
    let _subscriber = tracing::dispatcher::set_default(&dispatch);
    let _clock = clock::test_offset_guard();
    let mut f = Fixture::new().await;
    let stalled = f.query().await;
    timeout(RESOLVE_TIMEOUT + Duration::from_secs(3), async {
        while f.a.status().resolution_error.is_none() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let status = f.a.status();
    assert!(status.resolution_stalled, "{status:?}");
    assert_eq!(
        status.resolution_error,
        Some(format!(
            "endpoint did not resolve: peer.test:{}: lookup timed out",
            f.b_at.port()
        ))
    );
    stalled.send(Ok(f.b_at)).unwrap();
    until(|| {
        let status = f.a.status();
        !status.resolution_stalled && status.resolution_error.is_none()
    })
    .await;
    let lines = events.endpoint_lines();
    let lines: Vec<(&str, &str)> = lines
        .iter()
        .map(|(level, message)| (level.as_str(), message.as_str()))
        .collect();
    assert_eq!(
        lines,
        [
            (
                "WARN",
                "WireGuard endpoint lookup stalled; waiting for the system resolver"
            ),
            ("WARN", "WireGuard endpoint lookup recovered"),
        ]
    );
}

fn answer_session_lookups(f: &mut Fixture, address: SocketAddr) -> JoinHandle<()> {
    let mut queries = std::mem::replace(&mut f.queries, mpsc::unbounded_channel().1);
    tokio::spawn(async move {
        while let Some(query) = queries.recv().await {
            query.send(Ok(address)).unwrap();
        }
    })
}

impl Events {
    fn session_lines(&self) -> Vec<RecordedEvent> {
        self.0
            .lock()
            .iter()
            .filter(|event| event.message.starts_with("WireGuard session"))
            .cloned()
            .collect()
    }

    fn assert_session_levels(&self, expiries: usize) {
        let events = self.0.lock();
        assert!(
            !events.iter().any(|event| event.level == "ERROR"),
            "{events:?}"
        );
        assert!(
            !events
                .iter()
                .any(|event| event.level == "WARN"
                    && event.target.starts_with("chan_wireguard::noise")),
            "{events:?}"
        );
        let expiry: Vec<_> = events
            .iter()
            .filter(|event| event.message.starts_with("CONNECTION_EXPIRED("))
            .collect();
        assert_eq!(expiry.len(), expiries, "{expiry:?}");
        assert!(
            expiry.iter().all(|event| event.level == "DEBUG"),
            "{expiry:?}"
        );
    }
}

#[tokio::test]
async fn session_notice_unanswered_handshakes_warn_once_and_recover() {
    let events = Events::default();
    let dispatch = tracing::Dispatch::new(events.clone());
    // See lookup_failures_warn_when_they_start_or_change.
    let _second = tracing::Dispatch::new(Events::default());
    let _subscriber = tracing::dispatcher::set_default(&dispatch);
    let _clock = clock::test_offset_guard();
    let mut f = Fixture::new().await;
    let mut relay = Relay::new(f.b_at).await;
    relay.set(MUTE);
    let answers = answer_session_lookups(&mut f, relay.old);
    let listener = f.b.listen(0).unwrap();
    let port = listener.port();
    let start_connect = || {
        let client = f.a.clone();
        tokio::spawn(async move { client.connect(b_port(port)).await })
    };
    let first = start_connect();
    until(|| relay.dark_initiations() > 0).await;
    clock::advance(Duration::from_secs(6));
    until(|| relay.dark_initiations() > 0).await;
    // A retransmitted TCP SYN would restart the core after expiry,
    // making its expired state transient between predicate polls.
    cancel_connect(&f.a, first).await;
    clock::advance(Duration::from_secs(85));
    until_expired(&f.a, "first unanswered handshake expires after 85 seconds").await;
    // The expired core reports ConnectionExpired on each tick too; those
    // ticks must not masquerade as another expiry.
    tokio::time::sleep(2 * TICK).await;
    let second = start_connect();
    until(|| !f.a.inner.wire.lock().tunn.is_expired()).await;
    until(|| relay.dark_initiations() > 0).await;
    cancel_connect(&f.a, second).await;
    clock::advance(Duration::from_secs(91));
    until_expired(&f.a, "second unanswered handshake expires after 91 seconds").await;
    relay.set(VIA_OLD);
    let third = start_connect();
    until(|| {
        f.a.inner
            .wire
            .lock()
            .tunn
            .time_since_last_handshake()
            .is_some()
    })
    .await;
    let lines = events.session_lines();
    assert_eq!(
        lines
            .iter()
            .map(|event| (event.level.as_str(), event.message.as_str()))
            .collect::<Vec<_>>(),
        [
            ("WARN", "WireGuard session handshake has not completed"),
            ("DEBUG", "WireGuard session handshake has not completed"),
            ("WARN", "WireGuard session established"),
        ]
    );
    for line in &lines {
        assert_eq!(line.target, "chan_wireguard::tunnel");
        assert_eq!(
            line.field("endpoint"),
            format!("peer.test:{}", f.b_at.port())
        );
        assert_eq!(line.field("address"), format!("Some({})", relay.old));
    }
    for line in &lines[..2] {
        assert_eq!(line.field("last_handshake"), "never");
    }
    events.assert_session_levels(2);
    third.abort();
    answers.abort();
}

#[tokio::test]
async fn session_notice_retains_lost_handshake_age_and_recovers_data() {
    let events = Events::default();
    let dispatch = tracing::Dispatch::new(events.clone());
    // See lookup_failures_warn_when_they_start_or_change.
    let _second = tracing::Dispatch::new(Events::default());
    let _subscriber = tracing::dispatcher::set_default(&dispatch);
    let _clock = clock::test_offset_guard();
    let mut f = Fixture::new().await;
    let mut relay = Relay::new(f.b_at).await;
    assert_eq!(f.a.status().handshake, HandshakeState::Never);
    let (mut a, mut b) = session_through(&relay, &mut f).await;
    assert!(matches!(f.a.status().handshake, HandshakeState::Live(age) if age < WAIT));
    let answers = answer_session_lookups(&mut f, relay.old);
    assert!(events.session_lines().is_empty());
    settle_then_mute(&relay, &mut a, &mut b).await;
    clock::advance(Duration::from_secs(121));
    until(|| relay.dark_initiations() > 0).await;
    clock::advance(Duration::from_secs(91));
    until(|| f.a.inner.wire.lock().tunn.is_expired()).await;
    assert!(f
        .a
        .inner
        .wire
        .lock()
        .tunn
        .time_since_last_handshake()
        .is_none());
    assert!(
        matches!(f.a.status().handshake, HandshakeState::Lost(age) if age >= Duration::from_secs(200))
    );
    let lost = events.session_lines();
    assert_eq!(lost.len(), 1, "{lost:?}");
    assert_eq!(lost[0].level, "WARN");
    assert_eq!(lost[0].message, "WireGuard session lost");
    let age: f64 = lost[0]
        .field("last_handshake")
        .strip_suffix('s')
        .unwrap()
        .parse()
        .unwrap();
    assert!(age >= 200.0, "{lost:?}");
    relay.set(VIA_OLD);
    a.write_all(b"after expiry").await.unwrap();
    let mut bytes = [0; 12];
    timeout(WAIT, b.read_exact(&mut bytes))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(&bytes, b"after expiry");
    exchange(&mut a, &mut b).await;
    assert!(matches!(f.a.status().handshake, HandshakeState::Live(age) if age < WAIT));
    let lines = events.session_lines();
    assert_eq!(lines.len(), 2, "{lines:?}");
    assert_eq!(lines[1].level, "WARN");
    assert_eq!(lines[1].message, "WireGuard session established");
    for line in &lines {
        assert_eq!(
            line.field("endpoint"),
            format!("peer.test:{}", f.b_at.port())
        );
        assert_eq!(line.field("address"), format!("Some({})", relay.old));
    }
    events.assert_session_levels(1);
    answers.abort();
}

#[tokio::test]
async fn session_notice_untransmitted_handshake_is_debug_only() {
    let events = Events::default();
    let dispatch = tracing::Dispatch::new(events.clone());
    // See lookup_failures_warn_when_they_start_or_change.
    let _second = tracing::Dispatch::new(Events::default());
    let _subscriber = tracing::dispatcher::set_default(&dispatch);
    let _clock = clock::test_offset_guard();
    let mut f = Fixture::new().await;
    let query = f.query().await;
    let connecting = tokio::spawn({
        let client = f.a.clone();
        async move { client.connect(b_port(80)).await }
    });
    tokio::time::sleep(2 * TICK).await;
    query.send(Err(not_found("name absent"))).unwrap();
    assert!(timeout(WAIT, connecting).await.unwrap().unwrap().is_err());
    clock::advance(Duration::from_secs(91));
    until(|| f.a.inner.wire.lock().tunn.is_expired()).await;
    let lines = events.session_lines();
    assert_eq!(lines.len(), 1, "{lines:?}");
    assert_eq!(lines[0].level, "DEBUG");
    assert_eq!(lines[0].field("last_handshake"), "never");
    assert_eq!(lines[0].field("address"), "None");
    let warnings: Vec<_> = events
        .0
        .lock()
        .iter()
        .filter(|event| event.level == "WARN")
        .map(|event| event.message.clone())
        .collect();
    assert_eq!(warnings, ["WireGuard endpoint failed; retrying"]);
    events.assert_session_levels(1);
}

#[tokio::test]
async fn session_notice_idle_expiry_is_debug_only() {
    let events = Events::default();
    let dispatch = tracing::Dispatch::new(events.clone());
    // See lookup_failures_warn_when_they_start_or_change.
    let _second = tracing::Dispatch::new(Events::default());
    let _subscriber = tracing::dispatcher::set_default(&dispatch);
    let _clock = clock::test_offset_guard();
    let mut f = Fixture::new().await;
    drop(f.b);
    f.queries.recv().await.unwrap().send(Ok(f.b_at)).unwrap();
    until(|| f.a.status().endpoint == Some(f.b_at)).await;
    clock::advance(Duration::from_secs(541));
    until(|| f.a.inner.wire.lock().tunn.is_expired()).await;
    let lines = events.session_lines();
    assert_eq!(lines.len(), 1, "{lines:?}");
    assert_eq!(lines[0].level, "DEBUG");
    assert_eq!(lines[0].field("last_handshake"), "never");
    assert_eq!(f.a.status().handshake, HandshakeState::Never);
    assert!(!events.0.lock().iter().any(|event| event.level == "WARN"));
    events.assert_session_levels(1);
}

async fn next_initiation(packets: &mut mpsc::UnboundedReceiver<Vec<u8>>) -> Vec<u8> {
    timeout(WAIT, async {
        loop {
            let packet = packets.recv().await.expect("relay remains alive");
            if is_initiation(&packet) {
                return packet;
            }
        }
    })
    .await
    .expect("an initiation reaches the observed path")
}

#[tokio::test]
async fn endpoint_probe_copies_the_in_flight_initiation() {
    let _clock = clock::test_offset_guard();
    let mut f = Fixture::new().await;
    let mut relay = Relay::new(f.b_at).await;
    let (mut a, mut b) = session_through(&relay, &mut f).await;
    settle_then_mute(&relay, &mut a, &mut b).await;
    let other = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    clock::advance(Duration::from_secs(121));
    let query = f.query().await;
    let in_flight = next_initiation(&mut relay.dark).await;
    query.send(Ok(other.local_addr().unwrap())).unwrap();
    let mut probe = [0; 256];
    let (len, _) = timeout(WAIT, other.recv_from(&mut probe))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        &probe[..len],
        in_flight,
        "a probe copies the in-flight handshake without replacing it"
    );
    assert_eq!(f.a.status().endpoint, Some(relay.old));
}

#[tokio::test]
async fn endpoint_probes_do_not_churn_the_live_peer() {
    let _clock = clock::test_offset_guard();
    let mut f = Fixture::new().await;
    let mut relay = Relay::new(f.b_at).await;
    let (mut a, mut b) = session_through(&relay, &mut f).await;
    while relay.to_peer.try_recv().is_ok() {}
    let dead_a = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let dead_b = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    while relay.from_peer.try_recv().is_ok() {}
    relay.hold_responses.store(true, Ordering::SeqCst);
    clock::advance(Duration::from_secs(121));
    let query = f.query().await;
    query.send(Ok(dead_a.local_addr().unwrap())).unwrap();
    initiation(&dead_a).await;
    let response = next_response(&mut relay.from_peer).await;
    relay.hold_responses.store(false, Ordering::SeqCst);
    relay.old_socket.send_to(&response, f.a_at).await.unwrap();
    until(|| fresh_handshake(&f.a, REKEY_TIMEOUT)).await;
    for address in [
        dead_b.local_addr().unwrap(),
        dead_a.local_addr().unwrap(),
        dead_b.local_addr().unwrap(),
    ] {
        clock::advance(REKEY_TIMEOUT + TICK);
        tokio::time::sleep(2 * TICK).await;
        while let Ok(query) = f.queries.try_recv() {
            query.send(Ok(address)).unwrap();
        }
        exchange(&mut a, &mut b).await;
    }
    let mut initiations = 0;
    while let Ok(packet) = relay.to_peer.try_recv() {
        initiations += usize::from(is_initiation(&packet));
    }
    assert_eq!(
        initiations, 1,
        "only the scheduled rekey reaches the live peer; lookup probes add none"
    );
    assert_eq!(f.a.status().endpoint, Some(relay.old));
}

async fn delayed_probe_recovery(drop_one: bool) {
    let _clock = clock::test_offset_guard();
    let mut f = Fixture::new().await;
    let mut relay = Relay::new(f.b_at).await;
    let (mut a, mut b) = session_through(&relay, &mut f).await;
    tokio::time::sleep(4 * TICK).await;
    while relay.from_peer.try_recv().is_ok() {}
    relay.hold_responses.store(true, Ordering::SeqCst);
    if drop_one {
        relay.drop_next_probe.store(true, Ordering::SeqCst);
    } else {
        relay.set(ONLY_OLD);
    }
    clock::advance(Duration::from_secs(121));
    f.query().await.send(Ok(relay.new)).unwrap();
    next_initiation(&mut relay.at_new).await;
    assert!(
        !relay.drop_next_probe.load(Ordering::SeqCst),
        "the lost-packet arm actually drops its first probe"
    );
    // Complete the same attempt on its old path after the new-address
    // probe was lost. The saved response is authenticated by the client.
    let response = next_response(&mut relay.from_peer).await;
    relay.hold_responses.store(false, Ordering::SeqCst);
    relay.old_socket.send_to(&response, f.a_at).await.unwrap();
    until(|| fresh_handshake(&f.a, REKEY_TIMEOUT)).await;
    assert_eq!(f.a.status().endpoint, Some(relay.old));
    let answers = answer_session_lookups(&mut f, relay.new);
    relay.set(VIA_NEW);
    let moved_at = Instant::now();
    let tx = f.a.status().tx_bytes;
    a.write_all(b"cutover").await.unwrap();
    until(|| f.a.status().tx_bytes > tx).await;
    clock::advance(Duration::from_secs(16));
    next_initiation(&mut relay.at_new).await;
    until(|| f.a.status().endpoint == Some(relay.new)).await;
    assert!(
        moved_at.elapsed() < Duration::from_secs(25),
        "the next dead-peer attempt follows the cutover before the stale interval"
    );
    let mut bytes = [0; 7];
    timeout(WAIT, b.read_exact(&mut bytes))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(&bytes, b"cutover");
    exchange(&mut a, &mut b).await;
    answers.abort();
}

#[tokio::test]
async fn endpoint_probe_retries_a_record_that_moved_before_the_host() {
    delayed_probe_recovery(false).await;
}

#[tokio::test]
async fn endpoint_probe_retries_a_lost_datagram_on_the_next_attempt() {
    delayed_probe_recovery(true).await;
}

#[tokio::test]
async fn endpoint_probe_does_not_repeat_on_five_second_retries() {
    let _clock = clock::test_offset_guard();
    let mut f = Fixture::new().await;
    let mut relay = Relay::new(f.b_at).await;
    let (mut a, mut b) = session_through(&relay, &mut f).await;
    settle_then_mute(&relay, &mut a, &mut b).await;
    clock::advance(Duration::from_secs(121));
    f.query().await.send(Ok(relay.new)).unwrap();
    next_initiation(&mut relay.at_new).await;
    // Stay below the stale threshold: each retry still belongs to the
    // same handshake and must not send another live-session probe.
    for _ in 0..2 {
        clock::advance(REKEY_TIMEOUT + TICK);
        f.query().await.send(Ok(relay.new)).unwrap();
        tokio::time::sleep(TICK).await;
        assert!(
            relay.at_new.try_recv().is_err(),
            "a retry is not a new live-session probe"
        );
    }
}

#[tokio::test]
async fn endpoint_rotating_answers_try_each_stale_address_once() {
    let _clock = clock::test_offset_guard();
    let mut f = Fixture::new().await;
    let dead_a = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let dead_b = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let (a_at, b_at) = (dead_a.local_addr().unwrap(), dead_b.local_addr().unwrap());
    f.query()
        .await
        .send_all(Ok(vec![a_at, b_at, f.b_at]))
        .unwrap();
    let mut listener = f.b.listen(0).unwrap();
    let port = listener.port();
    let connecting = tokio::spawn({
        let client = f.a.clone();
        async move { client.connect(b_port(port)).await }
    });
    initiation(&dead_a).await;
    assert_eq!(f.a.status().endpoint, Some(a_at));
    clock::advance(REKEY_TIMEOUT + TICK);
    let query = f.query().await;
    initiation(&dead_b).await;
    assert_eq!(f.a.status().endpoint, Some(b_at));
    query.send_all(Ok(vec![b_at, a_at, f.b_at])).unwrap();
    tokio::time::sleep(TICK).await;
    clock::advance(REKEY_TIMEOUT + TICK);
    let query = f.query().await;
    query.send_all(Ok(vec![a_at, b_at, f.b_at])).unwrap();
    let (a, b) = timeout(WAIT, async { tokio::join!(connecting, listener.accept()) })
        .await
        .unwrap();
    exchange(&mut a.unwrap().unwrap(), &mut b.unwrap()).await;
    assert_eq!(f.a.status().endpoint, Some(f.b_at));
    assert!(
        drain(&dead_a).is_empty(),
        "the first dead address is not retried through a rotated list"
    );
    assert!(
        drain(&dead_b).is_empty(),
        "the second dead address is not retried through a rotated list"
    );
}

#[tokio::test]
async fn endpoint_rotating_answers_keep_a_live_member() {
    let _clock = clock::test_offset_guard();
    let mut f = Fixture::new().await;
    let (mut a, mut b) = f.establish().await;
    let dead = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    clock::advance(Duration::from_secs(121));
    f.query()
        .await
        .send_all(Ok(vec![dead.local_addr().unwrap(), f.b_at]))
        .unwrap();
    until(|| fresh_handshake(&f.a, REKEY_TIMEOUT)).await;
    exchange(&mut a, &mut b).await;
    assert!(
        drain(&dead).is_empty(),
        "answer order cannot probe a dead address when the live address is present"
    );
    assert_eq!(f.a.status().endpoint, Some(f.b_at));
}

#[tokio::test]
async fn endpoint_empty_answer_fails_without_discarding_the_endpoint() {
    let _clock = clock::test_offset_guard();
    let mut f = Fixture::build(true).await;
    f.query().await.send_all(Ok(Vec::new())).unwrap();
    until(|| f.a.status().resolution_error.is_some()).await;
    assert!(f
        .a
        .status()
        .resolution_error
        .unwrap()
        .contains("no usable address"));
    assert_eq!(f.a.status().endpoint, Some(f.b_at));
    let (mut a, mut b) = f.connect().await;
    exchange(&mut a, &mut b).await;
}

async fn next_response(packets: &mut mpsc::UnboundedReceiver<Vec<u8>>) -> Vec<u8> {
    timeout(WAIT, async {
        loop {
            let packet = packets.recv().await.expect("relay remains alive");
            if packet.len() == 92 && packet[..4] == [2, 0, 0, 0] {
                return packet;
            }
        }
    })
    .await
    .expect("the relay holds a handshake response")
}

#[tokio::test]
async fn endpoint_lost_probe_remains_available_when_the_path_goes_stale() {
    let _clock = clock::test_offset_guard();
    let mut f = Fixture::new().await;
    let mut relay = Relay::new(f.b_at).await;
    let (mut a, mut b) = session_through(&relay, &mut f).await;
    settle_then_mute(&relay, &mut a, &mut b).await;
    relay.drop_next_probe.store(true, Ordering::SeqCst);
    clock::advance(Duration::from_secs(121));
    let attempt = Instant::now();
    f.query().await.send(Ok(relay.new)).unwrap();
    next_initiation(&mut relay.dark).await;
    next_initiation(&mut relay.at_new).await;
    assert!(!relay.drop_next_probe.load(Ordering::SeqCst));
    assert_eq!(f.a.status().endpoint, Some(relay.old));
    // The peer's post-jump keepalive must die before the new path opens,
    // or it would roam the endpoint without a successful initiation.
    tokio::time::sleep(2 * TICK).await;
    relay.set(VIA_NEW);
    let answers = answer_session_lookups(&mut f, relay.new);
    for _ in 0..4 {
        clock::advance(REKEY_TIMEOUT + TICK);
        tokio::time::sleep(2 * TICK).await;
        if f.a.status().endpoint == Some(relay.new) {
            break;
        }
    }
    assert_eq!(
        f.a.status().endpoint,
        Some(relay.new),
        "a lost live probe must remain eligible for the first stale retries"
    );
    until(|| fresh_handshake(&f.a, REKEY_TIMEOUT)).await;
    assert!(
        attempt.elapsed() < Duration::from_secs(30),
        "recovery must not wait for the 90-second attempt expiry"
    );
    exchange(&mut a, &mut b).await;
    answers.abort();
}

#[tokio::test]
async fn endpoint_record_can_move_back_while_the_new_path_is_live() {
    let _clock = clock::test_offset_guard();
    let mut f = Fixture::new().await;
    let mut relay = Relay::new(f.b_at).await;
    let (mut a, mut b) = session_through(&relay, &mut f).await;
    settle_then_mute(&relay, &mut a, &mut b).await;
    relay.set(VIA_NEW);
    clock::advance(Duration::from_secs(121));
    f.query().await.send(Ok(relay.new)).unwrap();
    until(|| f.a.status().endpoint == Some(relay.new)).await;
    until(|| fresh_handshake(&f.a, REKEY_TIMEOUT)).await;
    exchange(&mut a, &mut b).await;
    tokio::time::sleep(4 * TICK).await;
    while relay.dark.try_recv().is_ok() {}
    while relay.from_peer.try_recv().is_ok() {}
    relay.hold_responses.store(true, Ordering::SeqCst);
    clock::advance(Duration::from_secs(121));
    let attempt = Instant::now();
    f.query().await.send(Ok(relay.old)).unwrap();
    next_response(&mut relay.from_peer).await;
    next_initiation(&mut relay.dark).await;
    assert!(attempt.elapsed() < REKEY_TIMEOUT);
    assert_eq!(f.a.status().endpoint, Some(relay.new));
    assert!(matches!(f.a.status().handshake, HandshakeState::Live(age) if age < STALE_HANDSHAKE));
}

#[tokio::test]
async fn endpoint_bind_failure_tries_another_answer() {
    let events = Events::default();
    let dispatch = tracing::Dispatch::new(events.clone());
    let _second = tracing::Dispatch::new(Events::default());
    let _subscriber = tracing::dispatcher::set_default(&dispatch);
    let _clock = clock::test_offset_guard();
    let _refuse = RefuseBind::new();
    let mut f = Fixture::new().await;
    let first = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let next = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    f.query()
        .await
        .send(Ok(first.local_addr().unwrap()))
        .unwrap();
    let connecting = tokio::spawn({
        let client = f.a.clone();
        async move { client.connect(b_port(80)).await }
    });
    initiation(&first).await;
    clock::advance(REKEY_TIMEOUT + TICK);
    f.query()
        .await
        .send_all(Ok(vec![
            "[::1]:51820".parse().unwrap(),
            next.local_addr().unwrap(),
        ]))
        .unwrap();
    until(|| f.a.status().resolution_error.is_some()).await;
    assert!(f
        .a
        .status()
        .resolution_error
        .unwrap()
        .starts_with("binding a UDP socket for [::1]:51820: "));
    clock::advance(REKEY_TIMEOUT + TICK);
    let _query = f.query().await;
    initiation(&next).await;
    assert_eq!(f.a.status().endpoint, Some(next.local_addr().unwrap()));
    assert_eq!(
        events.endpoint_lines(),
        [("WARN".into(), "WireGuard endpoint failed; retrying".into())]
    );
    connecting.abort();
}

#[tokio::test]
async fn endpoint_stale_retry_moves_only_once_even_when_its_lookup_finishes() {
    let _clock = clock::test_offset_guard();
    let mut f = Fixture::new().await;
    let first = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let second = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let third = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let addresses = vec![
        first.local_addr().unwrap(),
        second.local_addr().unwrap(),
        third.local_addr().unwrap(),
    ];
    f.query().await.send_all(Ok(addresses.clone())).unwrap();
    let connecting = tokio::spawn({
        let client = f.a.clone();
        async move { client.connect(b_port(80)).await }
    });
    initiation(&first).await;
    clock::advance(REKEY_TIMEOUT + TICK);
    let query = f.query().await;
    initiation(&second).await;
    assert_eq!(f.a.status().endpoint, Some(addresses[1]));
    query
        .send_all(Ok(vec![addresses[2], addresses[0], addresses[1]]))
        .unwrap();
    tokio::time::sleep(2 * TICK).await;
    assert_eq!(
        f.a.status().endpoint,
        Some(addresses[1]),
        "one retry cannot consume two candidates"
    );
    assert!(
        drain(&third).is_empty(),
        "the lookup result does not send a second stale move"
    );
    clock::advance(REKEY_TIMEOUT + TICK);
    let _query = f.query().await;
    initiation(&third).await;
    assert_eq!(f.a.status().endpoint, Some(addresses[2]));
    connecting.abort();
}

#[tokio::test]
async fn endpoint_empty_datagram_does_not_roam_or_replace_the_session() {
    let events = Events::default();
    let dispatch = tracing::Dispatch::new(events.clone());
    // See lookup_failures_warn_when_they_start_or_change.
    let _second = tracing::Dispatch::new(Events::default());
    let _subscriber = tracing::dispatcher::set_default(&dispatch);
    let _clock = clock::test_offset_guard();
    let mut f = Fixture::new().await;
    let (mut a, mut b) = f.establish().await;
    exchange(&mut a, &mut b).await;
    tokio::time::sleep(4 * TICK).await;
    clock::advance(Duration::from_secs(1));
    let HandshakeState::Live(before) = f.a.status().handshake else {
        panic!("the control establishes a session");
    };
    let other = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let other_at = other.local_addr().unwrap();
    other.send_to(&[], f.a_at).await.unwrap();
    // A malformed marker from the same socket is read after the empty
    // payload, giving the receive loop a positive progress control.
    other.send_to(&[0], f.a_at).await.unwrap();
    until(|| {
        events.0.lock().iter().any(|event| {
            event.target == "chan_wireguard::tunnel"
                && event.message == "dropping a datagram"
                && event.field("from") == other_at.to_string()
        })
    })
    .await;
    let after = f.a.status();
    assert_eq!(
        after.endpoint,
        Some(f.b_at),
        "an empty network datagram authenticates no sender"
    );
    assert!(
        matches!(after.handshake, HandshakeState::Live(age) if age >= before),
        "the same session remains usable: {after:?}"
    );
    exchange(&mut a, &mut b).await;

    // The same source can move the endpoint when it carries a genuinely
    // authenticated packet from the peer's current session.
    let mut work = [0; 256];
    let sealed = {
        let mut wire = f.b.inner.wire.lock();
        let TunnResult::WriteToNetwork(packet) = wire.tunn.encapsulate(&[], &mut work) else {
            panic!("the peer retains the established session");
        };
        packet.to_vec()
    };
    other.send_to(&sealed, f.a_at).await.unwrap();
    until(|| f.a.status().endpoint == Some(other_at)).await;
    assert!(matches!(f.a.status().handshake, HandshakeState::Live(age) if age >= before));
}
