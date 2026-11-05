use super::*;
use crate::clock;
use crate::resolver::{Lookup, RESOLVE_TIMEOUT};
use crate::testing::*;
use crate::x25519::{PublicKey, StaticSecret};
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
        let a = Tunnel::build(config, sockets, None, resolver).unwrap();
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

async fn initiation(socket: &UdpSocket) -> SocketAddr {
    let mut bytes = [0; 256];
    let (len, from) = timeout(WAIT, socket.recv_from(&mut bytes))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(len, 148);
    assert_eq!(&bytes[..4], &[1, 0, 0, 0]);
    from
}

#[tokio::test]
async fn unresolved_start_returns_and_recovers_without_restart() {
    let _clock = clock::test_offset_guard();
    let mut f = Fixture::new().await;
    // No task has been polled: construction cannot wait on the resolver.
    assert_eq!(f.a.status().endpoint, None);
    let query = f.query().await;
    assert_eq!(f.a.status().last_handshake, None);
    query
        .send(Err(io::Error::new(io::ErrorKind::NotFound, "name absent")))
        .unwrap();
    until(|| f.a.status().resolution_error.is_some()).await;
    let error = timeout(WAIT, f.a.connect(b_port(80)))
        .await
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

    clock::advance(REKEY_TIMEOUT + TICK);
    let a = f.a.clone();
    let mut listener = f.b.listen(0).unwrap();
    let port = listener.port();
    // New demand keeps the tunnel retrying even though this attempt still
    // sees the previous error before the successful lookup arrives.
    let _ = a.connect(b_port(port)).await;
    f.query().await.send(Ok(f.b_at)).unwrap();
    until(|| f.a.status().resolution_error.is_none()).await;
    let (a, b) = timeout(WAIT, async {
        tokio::join!(a.connect(b_port(port)), listener.accept())
    })
    .await
    .unwrap();
    exchange(&mut a.unwrap(), &mut b.unwrap()).await;
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

#[tokio::test]
async fn hanging_rekey_lookup_keeps_established_streams_moving() {
    let _clock = clock::test_offset_guard();
    let mut f = Fixture::new().await;
    let (mut a, mut b) = f.establish().await;
    exchange(&mut a, &mut b).await;
    clock::advance(Duration::from_secs(121));
    let _hanging = f.query().await;
    for _ in 0..4 {
        exchange(&mut a, &mut b).await;
    }
    assert!(
        f.queries.try_recv().is_err(),
        "only one lookup may be in flight"
    );
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
async fn delayed_lookup_result_does_not_undo_newer_authenticated_roaming() {
    let _clock = clock::test_offset_guard();
    let mut f = Fixture::new().await;
    let (_a, _b) = f.establish().await;
    let completed_at = Instant::now();
    clock::advance(Duration::from_secs(1));
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
    f.a.inner.driver.abort();
    let name = Endpoint {
        host: "peer.test".into(),
        port: f.b_at.port(),
    };
    let mut driver = Driver {
        shared: f.a.inner.shared.clone(),
        wire: f.a.inner.wire.clone(),
        sockets: Sockets::default(),
        endpoint_name: name.clone(),
        allowed_ips: vec![],
        resolver: Resolver::new(name),
        resolution_tx: watch::channel(None).0,
        resolved_at: None,
        pending_initiation: false,
    };
    // Deliver an already-completed lookup after the authenticated datagram.
    driver.resolved(Ok(f.b_at), completed_at).await;
    assert_eq!(f.a.status().endpoint, Some(roam.local_addr().unwrap()));
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
