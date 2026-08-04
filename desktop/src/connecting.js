// Connecting / retry screen for outbound (remote-workspace) windows.
//
// The problem this solves: chan-desktop points an outbound
// WebviewWindow straight at a remote chan URL it does not own. When
// that remote is down the WKWebView just shows a blank white page with
// no feedback. Instead the Rust side opens this local page first;
// it shows a spinner + a live elapsed timer + one timestamped row per
// connection attempt, retries until it succeeds (or the user closes the
// window), and on success navigates the same window to the live
// workspace.
//
// Window <-> page contract (page side; the Rust/Tauri half lives in
// serve.rs `build_workspace_window`):
//
//   * Inputs are injected by an initialization_script that runs BEFORE
//     this file, as a global object:
//         window.__CHAN_CONNECTING__ = { url, target }
//       url    = the clean remote URL to DISPLAY ("connecting to {url}")
//                and to hand to the probe.
//       target = the full URL to NAVIGATE to on success: remote URL plus
//                ?w=<window-label> plus any restored #fragment, assembled
//                by Rust exactly like a direct workspace load, so per-window
//                SPA state + window-config restore survive the navigation.
//   * Reachability is probed through a single Tauri command:
//         invoke('probe_url', { url }) -> { reachable, status, detail }
//     For a gateway target, reachable is false on 502/503/504 and on a
//     transport failure; 401/403/404 prove the gate answered and are reachable.
//     Loopback targets keep the any-response behavior. The Rust request carries
//     the target origin's webview cookies when available.
//     The page cannot fetch the remote itself: the strict CSP
//     (default-src 'self') blocks cross-origin connect-src, so detection
//     must run in Rust, which has no CORS restriction and owns the
//     per-attempt timeout. The PAGE owns the loop, cadence, timer, rows,
//     and the success navigation; probe_url stays stateless.
//   * On a reachable probe the page calls window.location.replace(target),
//     so the connecting window becomes the workspace window in place. It
//     keeps its init script (KEY_BRIDGE_JS) and close handler across that
//     navigation, so it behaves as a normal workspace window afterwards.
//
// When window.__TAURI__ is absent (opening this file directly in a
// browser for development), inputs fall back to query params and the
// probe is simulated, so the page renders + animates standalone. Use
// ?demo=ok / ?demo=fail to force the simulated outcome.

const tauri = window.__TAURI__;
const invoke = tauri && tauri.core ? tauri.core.invoke : null;

// Injected-by-Rust inputs first; query params are the dev fallback.
const injected = window.__CHAN_CONNECTING__ || null;
const params = new URLSearchParams(location.search);
let displayUrl = (injected && injected.url) || params.get('url') || '';
let targetUrl = (injected && injected.target) || params.get('target') || displayUrl;
// label is a dev-only nicety (not part of the Tauri contract); when
// absent the header just reads "Connecting to workspace".
const label = params.get('label') || '';
const demo = params.get('demo'); // 'ok' | 'fail' | null (standalone only)

// Pause between a failed probe and the next attempt. The probe itself
// carries a ~5s server-side connect timeout (Rust), so a black-hole host
// cannot hang the loop; attempts are paced AFTER each probe resolves so
// there is never more than one in-flight probe.
const RETRY_DELAY_MS = 2000;

// Give-up threshold. A remote that never comes up must not spin forever:
// after this many failed attempts the loop stops and surfaces Retry /
// Disconnect, so neither the user nor the launcher's connecting state is
// stuck. Retry resumes with a fresh budget; the count is generous because a
// legitimately-booting remote can take a while.
const GIVE_UP_AFTER_ATTEMPTS = 20;

const els = {
  body: document.body,
  spinner: document.getElementById('spinner'),
  title: document.getElementById('title'),
  url: document.getElementById('url'),
  elapsed: document.getElementById('elapsed'),
  attempt: document.getElementById('attempt'),
  log: document.getElementById('log'),
  foot: document.getElementById('foot'),
  actions: document.getElementById('actions'),
  retry: document.getElementById('retry'),
  disconnect: document.getElementById('disconnect'),
};

wireActions();

let attempt = 0;
let startedAt = null; // wall-clock of the first attempt; drives the timer
let stopped = false; // set once connected or on a hard error
let elapsedTimer = null;

applyTheme();

// Standalone-dev convenience: with no Tauri and no URL given, synthesize
// a demo target so the page still animates when opened as a bare file.
if (!displayUrl && !invoke) {
  displayUrl = 'http://127.0.0.1:4000/';
  targetUrl = displayUrl;
}

applyTarget();

if (!displayUrl) {
  showHardError('No workspace URL was provided to connect to.');
} else {
  startElapsedTimer();
  runLoop();
}

// Follow the launcher's chosen theme, injected by Rust into the
// __CHAN_CONNECTING__ global (null follows the OS). styles.css :root + the
// OS-light media query handle the follow-OS case, so we only pin an explicit
// light/dark override here.
function applyTheme() {
  const theme = injected && injected.theme;
  if (theme === 'dark' || theme === 'light') {
    document.documentElement.setAttribute('data-theme', theme);
  }
}

// Render the target into the header. The url line shows the display URL
// verbatim (the contract's `url` is the user-facing string to print);
// the full navigate target rides in the title attribute for hover.
function applyTarget() {
  els.title.textContent = label ? `Connecting to ${label}` : 'Connecting to workspace';
  els.url.textContent = displayUrl || '(no URL)';
  els.url.setAttribute('title', targetUrl || displayUrl || '');
}

function startElapsedTimer() {
  startedAt = Date.now();
  updateElapsed();
  elapsedTimer = setInterval(updateElapsed, 1000);
}

function updateElapsed() {
  if (startedAt == null) return;
  els.elapsed.textContent = fmtElapsed(Date.now() - startedAt);
}

// The retry loop. Each pass appends one timestamped row, probes the
// remote, resolves the row to ok/fail, and either navigates (success)
// or waits and loops (failure). Runs until `stopped` flips, which only
// happens on success or a hard error; OS window-close just kills the
// page mid-await, which is fine.
async function runLoop() {
  addRow('info', new Date(), `Opening connection to ${displayUrl}`);
  while (!stopped) {
    attempt += 1;
    els.attempt.textContent = String(attempt);
    const at = new Date();
    const row = addRow('pending', at, `attempt ${attempt}: connecting...`);

    let res;
    try {
      res = await probe(displayUrl);
    } catch (e) {
      // A rejected probe IPC counts as a failed attempt.
      res = { reachable: false, status: null, detail: errText(e) };
    }
    if (stopped) return;

    if (res && res.reachable) {
      const code = res.status != null ? ` (HTTP ${res.status})` : '';
      setRow(row, 'ok', `attempt ${attempt}: connected${code}`);
      await onConnected();
      return;
    }

    setRow(row, 'fail', `attempt ${attempt}: ${failReason(res)}`);
    if (attempt >= GIVE_UP_AFTER_ATTEMPTS) {
      showGaveUp();
      return;
    }
    await delay(RETRY_DELAY_MS);
  }
}

// The retry loop hit GIVE_UP_AFTER_ATTEMPTS. Stop spinning and offer Retry /
// Disconnect rather than looping forever (which left the launcher stuck on
// "connecting"). Not a hard error: Retry resumes the loop.
function showGaveUp() {
  stopped = true;
  stopElapsedTimer();
  els.body.classList.add('is-gaveup');
  els.title.textContent = label ? `Can't reach ${label}` : "Still can't connect";
  els.foot.textContent =
    `${displayUrl} hasn't responded after ${attempt} attempts. Retry, or disconnect to close this window.`;
  els.actions.hidden = false;
}

// Clear the gave-up state so the loop can resume from a clean header.
function hideGaveUp() {
  els.body.classList.remove('is-gaveup');
  els.actions.hidden = true;
  els.title.textContent = label ? `Connecting to ${label}` : 'Connecting to workspace';
  els.foot.textContent = 'This window keeps retrying until it connects or you close it.';
}

// Retry restarts the loop with a fresh attempt budget; Disconnect destroys the
// window (same as Cmd+W) so the launcher leaves the connecting state. Both are
// no-ops until the loop has actually given up (the actions are hidden before
// then). request_close_window is a no-op in standalone-browser dev (no Tauri).
function wireActions() {
  els.retry.addEventListener('click', () => {
    if (!stopped) return;
    hideGaveUp();
    attempt = 0;
    stopped = false;
    startElapsedTimer();
    runLoop();
  });
  els.disconnect.addEventListener('click', () => {
    if (invoke) invoke('request_close_window').catch(() => {});
  });
}

// Probe the remote for reachability. In Tauri this is the `probe_url`
// Rust command (no CORS, owns its connect timeout). Standalone it is
// simulated so the page can be developed without a desktop build.
async function probe(url) {
  if (invoke) {
    return await invoke('probe_url', { url });
  }
  return simulateProbe();
}

// Standalone-only probe simulation. ?demo=ok succeeds immediately,
// ?demo=fail never succeeds, default fails a few times then succeeds so
// both the retry log and the success handoff are visible in a browser.
async function simulateProbe() {
  await delay(700);
  if (demo === 'ok') return { reachable: true, status: 200, detail: 'ok' };
  if (demo === 'fail') return { reachable: false, status: null, detail: 'connection refused (demo)' };
  if (attempt >= 3) return { reachable: true, status: 200, detail: 'ok' };
  return { reachable: false, status: null, detail: 'connection refused (demo)' };
}

// Success path: stop the spinner, mark the window connected, let the
// success state show for a beat, then navigate the window to the live
// workspace target. Standalone (no Tauri) skips the real navigation so
// the dev page does not jump to a dead URL.
async function onConnected() {
  stopped = true;
  stopElapsedTimer();
  els.body.classList.add('is-connected');
  els.title.textContent = label ? `Connected to ${label}` : 'Connected';
  els.foot.textContent = 'Opening workspace...';
  await delay(450);
  if (invoke) {
    location.replace(targetUrl);
  }
}

function showHardError(msg) {
  stopped = true;
  stopElapsedTimer();
  els.body.classList.add('is-error');
  els.title.textContent = 'Cannot connect';
  els.foot.textContent = 'Close this window and try opening the workspace again.';
  addRow('fail', new Date(), msg);
}

function stopElapsedTimer() {
  if (elapsedTimer != null) {
    clearInterval(elapsedTimer);
    elapsedTimer = null;
  }
}

// Append a log row stamped with the wall-clock time it occurred and
// return it so the caller can resolve a pending row in place.
function addRow(kind, when, msg) {
  const row = document.createElement('div');
  row.className = `log-row ${kind}`;
  const time = document.createElement('span');
  time.className = 'log-time';
  time.textContent = fmtClock(when);
  const text = document.createElement('span');
  text.className = 'log-msg';
  text.textContent = msg;
  row.appendChild(time);
  row.appendChild(text);
  els.log.appendChild(row);
  els.log.scrollTop = els.log.scrollHeight;
  return row;
}

function setRow(row, kind, msg) {
  row.className = `log-row ${kind}`;
  const text = row.querySelector('.log-msg');
  if (text) text.textContent = msg;
  els.log.scrollTop = els.log.scrollHeight;
}

// Turn a probe result into a short failure reason for the log.
function failReason(res) {
  if (!res) return 'no response';
  if (res.detail) return res.detail;
  if (res.status != null) return `HTTP ${res.status}`;
  return 'no response';
}

function errText(e) {
  if (e == null) return 'unknown error';
  if (typeof e === 'string') return e;
  return e.message || String(e);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// HH:MM:SS wall clock for an attempt timestamp.
function fmtClock(d) {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

// Elapsed since the first attempt: MM:SS, growing to H:MM:SS past an
// hour so a long-abandoned retry still reads cleanly.
function fmtElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${pad2(m)}:${pad2(s)}`;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

// Close/cancel chords. The connecting window must be closable from the
// keyboard: Cmd+W on macOS normally arrives via the File > Close Window
// menu item (which destroys a connecting window for real), and this
// listener covers Ctrl+D everywhere plus Cmd/Ctrl+W where no menu item
// claims the chord (Linux has no Close Window accelerator). The invoked
// request_close_window destroys the window outright, bypassing the
// bury-on-close handler - on this screen there is no session or shell
// worth keeping, only the retry loop being cancelled. Capture phase so
// a focused element cannot swallow the chord first; no-op in the
// standalone-browser dev mode (no Tauri, nothing to close).
window.addEventListener(
  'keydown',
  (e) => {
    if (!invoke) return;
    const key = (e.key || '').toLowerCase();
    const close = ((e.metaKey || e.ctrlKey) && key === 'w') || (e.ctrlKey && key === 'd');
    if (!close) return;
    e.preventDefault();
    invoke('request_close_window').catch(() => {});
  },
  true,
);
