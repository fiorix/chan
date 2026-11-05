use super::*;
use crate::clock;
use crate::resolver::{Lookup, RESOLVE_TIMEOUT};
use crate::testing::*;
use crate::x25519::{PublicKey, StaticSecret};
use std::sync::atomic::{AtomicU8, Ordering};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot};
use tokio::time::timeout;

type Answer = oneshot::Sender<io::Result<SocketAddr>>;

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
        queries.send(answer).unwrap();
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
    let mut bytes = [0; 256];
    let (len, from) = timeout(WAIT, socket.recv_from(&mut bytes))
        .await
        .unwrap()
        .unwrap();
    assert!(is_initiation(&bytes[..len]));
    from
}

fn not_found(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::NotFound, message.to_string())
}

const VIA_OLD: u8 = 0;
const VIA_NEW: u8 = 1;
const MUTE: u8 = 2;

/// A UDP relay in front of the peer at `to`. The client reaches it at
/// `old` or `new`, and the peer sees every datagram come from `back`.
/// `VIA_OLD` answers the client through `old`; `VIA_NEW` drops what
/// arrives at `old` and answers through `new`, as when the peer moved;
/// `MUTE` forwards nothing either way. Every datagram the peer sends is
/// also copied to `from_peer`.
struct Relay {
    old: SocketAddr,
    new: SocketAddr,
    back: SocketAddr,
    mode: Arc<AtomicU8>,
    from_peer: mpsc::UnboundedReceiver<Vec<u8>>,
    task: JoinHandle<()>,
}

impl Relay {
    async fn new(to: SocketAddr) -> Self {
        let old = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let new = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let back = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let (old_at, new_at) = (old.local_addr().unwrap(), new.local_addr().unwrap());
        let back_at = back.local_addr().unwrap();
        let mode = Arc::new(AtomicU8::new(VIA_OLD));
        let (copy, from_peer) = mpsc::unbounded_channel();
        let task = tokio::spawn({
            let mode = mode.clone();
            async move {
                let mut client = None;
                let mut at_old = [0u8; 2048];
                let mut at_new = [0u8; 2048];
                let mut at_back = [0u8; 2048];
                loop {
                    tokio::select! {
                        received = old.recv_from(&mut at_old) => {
                            let Ok((len, from)) = received else { continue };
                            if mode.load(Ordering::SeqCst) == VIA_OLD {
                                client = Some(from);
                                let _ = back.send_to(&at_old[..len], to).await;
                            }
                        }
                        received = new.recv_from(&mut at_new) => {
                            let Ok((len, from)) = received else { continue };
                            if mode.load(Ordering::SeqCst) != MUTE {
                                client = Some(from);
                                let _ = back.send_to(&at_new[..len], to).await;
                            }
                        }
                        received = back.recv_from(&mut at_back) => {
                            let Ok((len, _)) = received else { continue };
                            let _ = copy.send(at_back[..len].to_vec());
                            let front = match mode.load(Ordering::SeqCst) {
                                VIA_OLD => &old,
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
            task,
        }
    }

    fn set(&self, mode: u8) {
        self.mode.store(mode, Ordering::SeqCst);
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
async fn roam(relay: &Relay, f: &Fixture, a: &mut Stream, b: &mut Stream) {
    relay.set(VIA_NEW);
    b.write_all(b"hi").await.unwrap();
    let mut two = [0; 2];
    timeout(WAIT, a.read_exact(&mut two))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(f.a.status().endpoint, Some(relay.new));
}

fn fresh_handshake(tunnel: &Tunnel, within: Duration) -> bool {
    tunnel
        .status()
        .last_handshake
        .is_some_and(|age| age < within)
}

#[tokio::test]
async fn unresolved_start_returns_and_recovers_without_restart() {
    let _clock = clock::test_offset_guard();
    let mut f = Fixture::new().await;
    // No task has been polled: construction cannot wait on the resolver.
    assert_eq!(f.a.status().endpoint, None);
    let query = f.query().await;
    assert_eq!(f.a.status().last_handshake, None);
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
    until(|| f.a.status().last_handshake.is_some()).await;
    assert_eq!(f.a.status().resolution_error, None);
    let (mut a, mut b) = f.connect().await;
    exchange(&mut a, &mut b).await;
}

#[tokio::test]
async fn live_rekey_and_expiry_follow_the_next_lookup() {
    let _clock = clock::test_offset_guard();
    let mut f = Fixture::new().await;
    let (mut a, mut b) = f.establish().await;
    exchange(&mut a, &mut b).await;
    let moved = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    clock::advance(Duration::from_secs(121));
    f.query()
        .await
        .send(Ok(moved.local_addr().unwrap()))
        .unwrap();
    initiation(&moved).await;
    assert!(
        f.a.status().last_handshake.is_some(),
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
/// session keeps carrying data while the rekey waits, the rekey goes to
/// the known endpoint at the deadline, the tunnel outlives the first
/// session's `REJECT_AFTER_TIME`, and the next rekey goes out at once
/// beside the still-owned lookup instead of starting another.
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
        status
            .last_handshake
            .is_some_and(|age| age < Duration::from_secs(180)),
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
/// `start_on` was given can say the later answer is unchanged.
#[tokio::test]
async fn start_on_endpoint_stands_as_the_previous_answer() {
    let _clock = clock::test_offset_guard();
    let mut f = Fixture::build(true).await;
    f.query().await.send(Err(not_found("not yet"))).unwrap();
    let (mut a, mut b) = f.connect().await;
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
    drop(f.b);
    clock::advance(Duration::from_secs(121));
    timeout(WAIT, f.queries.recv())
        .await
        .unwrap()
        .unwrap()
        .send(Ok(f.b_at))
        .unwrap();
    // The roamed address also hears the client's own traffic.
    timeout(WAIT, async {
        let mut bytes = [0; 256];
        loop {
            let len = roam.recv(&mut bytes).await.unwrap();
            if is_initiation(&bytes[..len]) {
                break;
            }
        }
    })
    .await
    .expect("the rekey goes to the roamed address");
    assert_eq!(f.a.status().endpoint, Some(roam.local_addr().unwrap()));
}

#[tokio::test]
async fn silent_peer_limits_lookups_and_uses_fresh_answers() {
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
    let mut bytes = [0; 256];
    assert!(
        silent.try_recv_from(&mut bytes).is_err(),
        "no initiation using the stale answer"
    );
    clock::advance(Duration::from_secs(6));
    tokio::time::sleep(2 * TICK).await;
    assert!(
        f.queries.try_recv().is_err(),
        "no overlapping lookup on another retry"
    );
    query.send(Ok(silent.local_addr().unwrap())).unwrap();
    initiation(&silent).await;
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
    clock::advance(Duration::from_secs(121));
    timeout(WAIT, f.queries.recv())
        .await
        .unwrap()
        .unwrap()
        .send(Ok(moved.local_addr().unwrap()))
        .unwrap();
    initiation(&moved).await;
    assert_eq!(f.a.status().endpoint, Some(moved.local_addr().unwrap()));
}

/// The peer roams while its DNS record still names the address it left.
/// The rekey's lookup answers that unchanged address; the endpoint stays
/// where the peer authenticated from and the rekey reaches it there.
#[tokio::test]
async fn an_unchanged_answer_does_not_undo_a_live_roam() {
    let _clock = clock::test_offset_guard();
    let mut f = Fixture::new().await;
    let relay = Relay::new(f.b_at).await;
    let (mut a, mut b) = session_through(&relay, &mut f).await;
    roam(&relay, &f, &mut a, &mut b).await;
    exchange(&mut a, &mut b).await;
    clock::advance(Duration::from_secs(121));
    let query = f.query().await;
    // Let both sides' post-jump timers (keepalives) flush before the answer.
    tokio::time::sleep(8 * TICK).await;
    query.send(Ok(relay.old)).unwrap();
    until(|| fresh_handshake(&f.a, Duration::from_secs(60))).await;
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
    roam(&relay, &f, &mut a, &mut b).await;
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
    let relay = Relay::new(f.b_at).await;
    let (mut a, mut b) = session_through(&relay, &mut f).await;
    clock::advance(Duration::from_secs(121));
    let query = f.query().await;
    roam(&relay, &f, &mut a, &mut b).await;
    query.send(Ok(relay.old)).unwrap();
    until(|| fresh_handshake(&f.a, Duration::from_secs(60))).await;
    assert_eq!(f.a.status().endpoint, Some(relay.new));
    exchange(&mut a, &mut b).await;
}

/// Past `STALE_HANDSHAKE` the roamed path is presumed dead, and even an
/// unchanged answer moves the endpoint back to the name's address.
#[tokio::test]
async fn after_a_stale_handshake_an_unchanged_answer_moves_the_endpoint() {
    let _clock = clock::test_offset_guard();
    let mut f = Fixture::new().await;
    let relay = Relay::new(f.b_at).await;
    let (mut a, mut b) = session_through(&relay, &mut f).await;
    roam(&relay, &f, &mut a, &mut b).await;
    clock::advance(STALE_HANDSHAKE + Duration::from_secs(5));
    let query = f.query().await;
    // The peer's keepalive after the jump still arrives from the new front
    // and authenticates; let it land first, as it would before a real
    // handshake went this stale.
    tokio::time::sleep(8 * TICK).await;
    assert_eq!(f.a.status().endpoint, Some(relay.new));
    query.send(Ok(relay.old)).unwrap();
    until(|| f.a.status().endpoint == Some(relay.old)).await;
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
    clock::advance(Duration::from_secs(6));
    f.query()
        .await
        .send(Ok(silent4.local_addr().unwrap()))
        .unwrap();
    assert_eq!(
        initiation(&silent4).await,
        f.a_at,
        "the old family socket is retained"
    );
    connecting.abort();
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
