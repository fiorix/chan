//! How long the tunnel listener holds the dial-time PAT.
//!
//! The listener needs the bearer to validate the dial and to hand it to
//! the Hello-name announcement; a registered tunnel must not keep it for
//! the life of the connection. These tests watch the allocation behind
//! the `&str` the listener hands the validator and assert that it is
//! freed while the tunnel is still registered. A second pin scans every
//! live allocation for the raw token bytes after registration and
//! allows exactly the h2 decoder's scratch buffer, so a later
//! `tokio::spawn` inside `register_tunnel` that keeps a clone would turn
//! red.
//!
//! The watch is this binary's global allocator, which is why these tests
//! live in their own file. Tests in one binary run on parallel threads,
//! so each test uses slots of its own.

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::UnsafeCell;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use chan_tunnel_client::{dial, ClientConfig};
use chan_tunnel_server::{
    serve_tunnel_listener, Registry, ServerError, Validated, Validator, TUNNEL_SCOPE,
};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Semaphore;
use url::Url;
use uuid::Uuid;

const SLOTS: usize = 4;

/// The address each slot watches; `0` is an unarmed slot.
static WATCHED: [AtomicUsize; SLOTS] = [const { AtomicUsize::new(0) }; SLOTS];

/// Set once the allocation holding the slot's address is freed.
static RELEASED: [AtomicBool; SLOTS] = [const { AtomicBool::new(false) }; SLOTS];

/// `System`, plus a note of when an allocation holding a watched address
/// is freed. A reallocation that moves a watched address carries the
/// watch to the new block, so a move is never reported as a release.
struct WatchingAllocator;

#[global_allocator]
static ALLOCATOR: WatchingAllocator = WatchingAllocator;

// SAFETY: every method forwards its arguments to `System` unchanged. The
// bookkeeping only loads and stores atomics, which never allocates.
unsafe impl GlobalAlloc for WatchingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let p = System.alloc(layout);
        if !p.is_null() {
            live_insert(p as usize, layout.size());
        }
        p
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let p = System.alloc_zeroed(layout);
        if !p.is_null() {
            live_insert(p as usize, layout.size());
        }
        p
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        live_remove(ptr as usize);
        note_release(ptr as usize, layout.size(), None);
        System.dealloc(ptr, layout)
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        live_lock();
        let moved = System.realloc(ptr, layout, new_size);
        if !moved.is_null() {
            live_remove(ptr as usize);
            live_insert(moved as usize, new_size);
            note_release(
                ptr as usize,
                layout.size(),
                Some((moved as usize, new_size)),
            );
        }
        live_unlock();
        moved
    }
}

/// The block `[start, start + len)` is gone: moved to `to` when it was
/// reallocated, freed otherwise.
fn note_release(start: usize, len: usize, to: Option<(usize, usize)>) {
    for (watch, release) in WATCHED.iter().zip(&RELEASED) {
        let watched = watch.load(Ordering::SeqCst);
        if watched == 0 || watched < start || watched >= start + len {
            continue;
        }
        match to {
            Some((to, to_len)) if watched - start < to_len => {
                watch.store(to + (watched - start), Ordering::SeqCst);
            }
            _ => {
                watch.store(0, Ordering::SeqCst);
                release.store(true, Ordering::SeqCst);
            }
        }
    }
}

// Live-allocation table used by the scan-based pin.

const LIVE_CAP: usize = 1 << 20;
const LIVE_TOMB: usize = usize::MAX;

struct LiveTable {
    addr: UnsafeCell<[usize; LIVE_CAP]>,
    size: UnsafeCell<[usize; LIVE_CAP]>,
}

// SAFETY: all accesses are protected by LIVE_LOCK.
unsafe impl Sync for LiveTable {}

static LIVE_TABLE: LiveTable = LiveTable {
    addr: UnsafeCell::new([0; LIVE_CAP]),
    size: UnsafeCell::new([0; LIVE_CAP]),
};
static LIVE_LOCK: AtomicBool = AtomicBool::new(false);

fn live_lock() {
    while LIVE_LOCK
        .compare_exchange_weak(false, true, Ordering::Acquire, Ordering::Relaxed)
        .is_err()
    {
        std::hint::spin_loop();
    }
}

fn live_unlock() {
    LIVE_LOCK.store(false, Ordering::Release);
}

fn live_slot(addr: usize) -> usize {
    (addr >> 4).wrapping_mul(0x9E37_79B9_7F4A_7C15) % LIVE_CAP
}

unsafe fn live_insert(addr: usize, size: usize) {
    let a = &mut *LIVE_TABLE.addr.get();
    let s = &mut *LIVE_TABLE.size.get();
    let mut i = live_slot(addr);
    let start = i;
    loop {
        if a[i] == 0 || a[i] == LIVE_TOMB {
            a[i] = addr;
            s[i] = size;
            return;
        }
        i = (i + 1) % LIVE_CAP;
        if i == start {
            panic!("live allocation table full");
        }
    }
}

unsafe fn live_remove(addr: usize) {
    let a = &mut *LIVE_TABLE.addr.get();
    let mut i = live_slot(addr);
    let start = i;
    loop {
        if a[i] == addr {
            a[i] = LIVE_TOMB;
            return;
        }
        if a[i] == 0 {
            return;
        }
        i = (i + 1) % LIVE_CAP;
        if i == start {
            return;
        }
    }
}

/// Snapshot of live allocations that contain a needle.
#[derive(Debug)]
struct LiveScan {
    hits: [(usize, usize, usize); 64],
    n: usize,
}

impl LiveScan {
    fn hits(&self) -> &[(usize, usize, usize)] {
        &self.hits[..self.n.min(64)]
    }
}

/// Scan every live allocation for `needle`. Returns a snapshot with up
/// to 64 hits; the count includes hits beyond 64.
unsafe fn live_scan(needle: &[u8]) -> LiveScan {
    let mut scan = LiveScan {
        hits: [(0, 0, 0); 64],
        n: 0,
    };
    live_lock();
    let a = &*LIVE_TABLE.addr.get();
    let s = &*LIVE_TABLE.size.get();
    for i in 0..LIVE_CAP {
        let addr = a[i];
        if addr == 0 || addr == LIVE_TOMB || s[i] < needle.len() {
            continue;
        }
        let block = std::slice::from_raw_parts(addr as *const u8, s[i]);
        for off in 0..=block.len() - needle.len() {
            if &block[off..off + needle.len()] == needle {
                if scan.n < 64 {
                    scan.hits[scan.n] = (addr, s[i], off);
                }
                scan.n += 1;
                break;
            }
        }
    }
    live_unlock();
    scan
}

/// Watch the allocation that holds `text`. The caller owns `slot`.
fn watch(slot: usize, text: &str) {
    RELEASED[slot].store(false, Ordering::SeqCst);
    WATCHED[slot].store(text.as_ptr() as usize, Ordering::SeqCst);
}

fn armed(slot: usize) -> bool {
    WATCHED[slot].load(Ordering::SeqCst) != 0
}

fn released(slot: usize) -> bool {
    RELEASED[slot].load(Ordering::SeqCst)
}

/// Poll `condition` until it holds or `within` passes.
async fn eventually(within: Duration, condition: impl Fn() -> bool) -> bool {
    let deadline = tokio::time::Instant::now() + within;
    loop {
        if condition() {
            return true;
        }
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

/// How long a test gives a copy of the PAT to be freed once nothing
/// needs it any more: far more than the few statements between
/// registration and the handler moving on, on a loaded runner.
const RELEASE_WINDOW: Duration = Duration::from_secs(5);

/// Admits every dial as alice's `ds-1` and watches the allocation behind
/// every token it is handed: `validate` arms `validate_slot`, and
/// `announce_devserver_name` arms `announce_slot` and then holds the
/// announcement open until the test adds a permit to `finish_announce`.
struct WatchingValidator {
    validate_slot: usize,
    announce_slot: usize,
    announcing: AtomicBool,
    finish_announce: Semaphore,
}

impl WatchingValidator {
    fn new(validate_slot: usize, announce_slot: usize) -> Arc<Self> {
        Arc::new(Self {
            validate_slot,
            announce_slot,
            announcing: AtomicBool::new(false),
            finish_announce: Semaphore::new(0),
        })
    }
}

#[async_trait]
impl Validator for WatchingValidator {
    async fn validate(&self, token: &str) -> Result<Validated, ServerError> {
        watch(self.validate_slot, token);
        Ok(Validated {
            user_id: Uuid::nil(),
            username: "alice".into(),
            devserver_id: "ds-1".into(),
            scopes: vec![TUNNEL_SCOPE.into()],
            gateway_assertion_key: None,
            admission_lease: None,
            admission_lease_expires_at: None,
        })
    }

    async fn announce_devserver_name(&self, token: &str, _name: &str) {
        watch(self.announce_slot, token);
        self.announcing.store(true, Ordering::SeqCst);
        let _finished = self.finish_announce.acquire().await;
    }
}

/// Unique sentinel for the scan-based pin. The header literal is static,
/// so the client side makes no heap copy of the raw token bytes.
const SENTINEL: &str = "chanpatSENTINELqz7XkQ4mVb2Lr9Tw";
const HEADER: &str = "Bearer chanpatSENTINELqz7XkQ4mVb2Lr9Tw";

/// Validator that accepts only the scan sentinel.
struct SentinelValidator;

#[async_trait]
impl Validator for SentinelValidator {
    async fn validate(&self, token: &str) -> Result<Validated, ServerError> {
        assert_eq!(token, SENTINEL);
        Ok(Validated {
            user_id: Uuid::nil(),
            username: "alice".into(),
            devserver_id: "ds-1".into(),
            scopes: vec![TUNNEL_SCOPE.into()],
            gateway_assertion_key: None,
            admission_lease: None,
            admission_lease_expires_at: None,
        })
    }
}

async fn spawn_listener(validator: Arc<dyn Validator>) -> (u16, Arc<Registry>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind 0");
    let port = listener.local_addr().expect("local addr").port();
    let registry = Registry::new();
    let serving = registry.clone();
    tokio::spawn(async move {
        let _ = serve_tunnel_listener(listener, validator, serving, 0).await;
    });
    (port, registry)
}

fn cfg(port: u16, name: Option<&str>) -> ClientConfig {
    ClientConfig {
        tunnel_url: Url::parse(&format!("http://127.0.0.1:{port}/v1/tunnel"))
            .expect("hard-coded url is valid"),
        token: "chan_pat_lifetime-under-test".into(),
        workspace: "devsrv".into(),
        name: name.map(str::to_owned),
        client_version: "chan/test".into(),
        dial_timeout: Duration::from_secs(5),
        ..ClientConfig::default()
    }
}

#[tokio::test]
async fn a_registered_tunnel_does_not_keep_the_dial_time_pat() {
    let validator = WatchingValidator::new(0, 1);
    let (port, registry) = spawn_listener(validator.clone()).await;
    // Held, not polled: the tunnel stays registered for the whole test.
    let (_registration, _tunnel) = dial(&cfg(port, None)).await.expect("dial");
    assert!(released(0) || armed(0), "the validator never saw the dial");
    assert!(
        eventually(RELEASE_WINDOW, || registry.get("alice", "ds-1").is_some()).await,
        "the tunnel never registered",
    );

    assert!(
        eventually(RELEASE_WINDOW, || released(0)).await,
        "the listener still holds the PAT it validated, {RELEASE_WINDOW:?} after the tunnel \
         registered",
    );
    assert!(
        registry.get("alice", "ds-1").is_some(),
        "the PAT was freed only because the tunnel went away",
    );
}

#[tokio::test]
async fn the_name_announcement_holds_the_pat_only_until_it_returns() {
    let validator = WatchingValidator::new(2, 3);
    let (port, registry) = spawn_listener(validator.clone()).await;
    let (_registration, _tunnel) = dial(&cfg(port, Some("office box"))).await.expect("dial");
    assert!(
        eventually(RELEASE_WINDOW, || validator
            .announcing
            .load(Ordering::SeqCst))
        .await,
        "the Hello name was never announced",
    );

    validator.finish_announce.add_permits(1);
    assert!(
        eventually(RELEASE_WINDOW, || released(2) && released(3)).await,
        "a copy of the PAT outlived the announcement: validated copy freed {}, announced copy \
         freed {}",
        released(2),
        released(3),
    );
    assert!(
        registry.get("alice", "ds-1").is_some(),
        "the PAT was freed only because the tunnel went away",
    );
}

#[tokio::test]
async fn scan_based_pin_allows_only_the_h2_decoder_scratch_block() {
    let validator: Arc<dyn Validator> = Arc::new(SentinelValidator);
    let (port, registry) = spawn_listener(validator).await;

    let tcp = TcpStream::connect(("127.0.0.1", port))
        .await
        .expect("connect");
    let (mut send_request, conn) = h2::client::handshake(tcp).await.expect("h2 handshake");
    tokio::spawn(async move {
        let _ = conn.await;
    });

    let mut authorization = http::HeaderValue::from_static(HEADER);
    authorization.set_sensitive(true);
    let request = http::Request::builder()
        .method(http::Method::POST)
        .uri(format!(
            "http://tunnel.test{}",
            chan_tunnel_proto::TUNNEL_PATH
        ))
        .header(http::header::AUTHORIZATION, authorization)
        .body(())
        .expect("constant request");
    let (response, send_stream) = send_request.send_request(request, false).unwrap();
    let response = response.await.unwrap();
    assert_eq!(response.status(), http::StatusCode::OK);

    let duplex = chan_tunnel_proto::H2Duplex::new(send_stream, response.into_body());
    let cfg = ClientConfig {
        token: "unused".into(),
        workspace: "devsrv".into(),
        ..ClientConfig::default()
    };
    let (_registration, _tunnel) = chan_tunnel_client::handshake(&cfg, duplex)
        .await
        .expect("hello handshake");

    assert!(
        eventually(RELEASE_WINDOW, || registry.get("alice", "ds-1").is_some()).await,
        "the tunnel never registered",
    );
    // Give the handler time to return from register_tunnel and start
    // the tunnel driver before we scan.
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(registry.get("alice", "ds-1").is_some());

    let scan = unsafe { live_scan(SENTINEL.as_bytes()) };
    let hits = scan.hits();
    assert_eq!(
        hits.len(),
        1,
        "expected exactly one live allocation holding the raw PAT, found {hits:?}"
    );
    let (addr, size, off) = hits[0];
    assert!(
        size >= 4096,
        "expected the h2 decoder scratch buffer (>=4096 bytes), got {size}"
    );
    assert!(
        off >= 7,
        "expected the PAT to be preceded by other header strings in the scratch buffer"
    );
    let block = unsafe { std::slice::from_raw_parts(addr as *const u8, size) };
    assert_eq!(
        &block[off - 7..off],
        b"Bearer ",
        "the live block does not contain the expected 'Bearer ' prefix"
    );
}
