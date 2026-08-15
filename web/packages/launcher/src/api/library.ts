// The launcher's HTTP client against the chan-library loopback server.
//
// The launcher is a pure HTTP client: it never opens native windows, never
// dials a devserver, never parses an opaque window id. Every type here
// mirrors a struct the library serializes, so the field names ARE the wire
// (the server pins them with byte tests).

// ---- The authoritative window record ------------------------------------
// What the library serves at GET /api/library/windows. The launcher renders
// these rows; `cs window list` and the desktop Window menu render the same
// rows off the same feed. Clients never parse `window_id` or `title`;
// remote-row decoration is recomposed from `kind`, `ordinal`, and
// `workspace_path`.

export type WindowKind = "terminal" | "workspace";
export const MAX_WINDOW_LABEL_CHARS = 64;

/** Which surface minted a window: a chan-desktop native window, or a launcher
 * `window.open` target. Drives the desktop watcher's twin-window suppression so
 * a browser-minted record never opens a native window. */
export type WindowOrigin = "native" | "browser";

export interface WindowRecord {
  /** Library-minted, persisted, opaque, stable. The reconciliation key. Never parsed. */
  window_id: string;
  /** "local" (the baked-in local-disk library) or "lib-<16hex>" (a devserver). */
  library_id: string;
  kind: WindowKind;
  /** Library-composed, persisted, auto-derived (local perspective). Never parsed. */
  title: string;
  /** Per-(kind, workspace/library) "Window N"; library-owned, persisted. */
  ordinal: number;
  /** Optional user text appended to the generated Terminal Window N / Window N
   * label. Empty values are omitted from the wire. Ordinary terminal and
   * workspace windows expose this as inline-editable text; clients keep the
   * generated ordinal separate. */
  label?: string;
  /** kind=workspace: full root path. Omitted from the wire for a terminal
   * window, so absent here rather than null. */
  workspace_path?: string | null;
  /** Route prefix of the tenant serving this window's content. */
  prefix: string;
  /** Per-tenant bearer for `prefix`; empty when the owning tenant is off. */
  token: string;
  /** A durable library record exists (survives disconnect AND library restart). */
  persisted: boolean;
  /** A /ws socket tagged with window_id is live right now. */
  connected: boolean;
  /** A file transfer (upload or download) is in flight for this window right
   * now. Volatile per-push state, so a launcher with no socket on the serving
   * tenant still learns a window is mid-transfer and can guard its close. */
  active_transfer: boolean;
  /** The devserver's connect CONTROL terminal (runs the connect script). The
   * feed renders it FIRST in its library group; the desktop mints it. Omitted
   * from the wire for an ordinary window, so absent here rather than false. */
  control?: boolean;
  /**
   * Server-persisted visibility. The window is buried/hidden on the
   * desktop, vs shown. Skip-if-default on the wire; OMITTED for visible windows
   * means the field is OPTIONAL here and ABSENT reads as visible. The launcher is
   * a passive consumer: the desktop persists this at the bury/unbury chokepoint
   * and it rides the existing `/api/library/windows` feed.
   */
  hidden?: boolean;
  /**
   * Client-claimed affinity of the surface that minted this window: "native" (a
   * chan-desktop window) or "browser" (a launcher `window.open` target).
   * Skip-if-native on the wire, so ABSENT reads as native. The desktop watcher
   * skips non-native records so a browser-minted window never gets a native twin.
   */
  origin?: WindowOrigin;
}

/** Full snapshot pushed on connect and on every change over the watch socket. */
export interface WindowSet {
  windows: WindowRecord[];
  /**
   * Per-tenant leadership: `{ "<prefix>": "<leader-window-id>" }` keyed by the
   * tenant route `prefix` (one prefix = one leader). Only tenants with a live
   * leader appear; absent/empty means none. The launcher correlates
   * `leaders[record.prefix]` against the acting window_id for leader-only
   * affordances.
   */
  leaders?: Record<string, string>;
}

// ---- The workspace registry ---------------------------------------------

/**
 * Live mount lifecycle of a workspace tenant. `on` is the persisted DESIRED
 * state; `status` is where the mount actually is right now, so the launcher
 * drives spinners off real backend state instead of a timer:
 * - `stopped`  not mounted (desired off, or never started)
 * - `starting` mount requested / in flight (the spinner state)
 * - `running`  mounted and serving
 * - `locked`   mounted by another live/unknown Chan process; not actionable here
 * - `closing`  unmount requested / in flight (spinner + locked controls)
 * - `removing` remove requested / in flight (spinner + locked controls)
 * - `error`    mount failed (open error); see `WorkspaceEntry.error`
 */
export type WorkspaceStatus =
  | "stopped"
  | "starting"
  | "running"
  | "locked"
  | "closing"
  | "removing"
  | "error";

/**
 * A workspace row in the launcher's workspace feed. Local rows are folders in
 * the local registry (`devserver_id` null); remote rows are workspaces a
 * connected devserver serves (`devserver_id` set), merged into the same feed so
 * the SPA groups them under their devserver. The field names ARE the wire (the
 * server's `LauncherWorkspace`).
 */
export interface WorkspaceEntry {
  /** Registry-assigned stable id (the server owns the scheme). */
  workspace_id: string;
  /** Canonical filesystem path of the workspace root. */
  path: string;
  /** Optional display label; empty falls back to the path basename. */
  label: string;
  /** Persisted DESIRED state: tenant should be served (on) vs registered-but-off. */
  on: boolean;
  /** Live mount lifecycle. The spinner shows while transitional; `locked` disables
   * local control; `error` renders a row error affordance carrying `error`.
   * Drives the UI in place of `on`. */
  status: WorkspaceStatus;
  /** Short human reason, present only when `status === "error"`. */
  error?: string;
  /** The library serving this row: host-local id for local rows (`local` in the
   * desktop app, `lib-*` in the standalone devserver); the remote library id for
   * a devserver-served row. Older local rows may omit it. */
  library_id: string | null;
  /** The devserver serving this row: null for a local row; the devserver
   * registry id for a remote row (the row's group key + route target). */
  devserver_id: string | null;
  /** The mounted route prefix. For a local row it equals the workspace_id (the
   * slash-free local prefix; local on/off/rm route by workspace_id). For a
   * devserver row it is the remote mount prefix the devserver workspace
   * on/off/forget routes target. */
  prefix: string;
}

// ---- The devserver registry ---------------------------------------------
// A devserver is a remote library the desktop dials out to. The launcher
// CRUDs the registry over HTTP (so the browser can manage it); the dial-out
// and native-window reconciliation are desktop-internal. The token is
// write-only over the wire: POST/PUT accept it, GET never echoes it back;
// `has_token` reports whether one is stored.

/**
 * Live connection lifecycle of a devserver, driving the launcher's Connect /
 * Disconnect toggle and its spinner off real backend state:
 * - `disconnected` no live connection (the Connect state); emitted when the
 *   tunnel drops or the control script exits, so a dropped devserver clears
 *   its spinner with no manual reload
 * - `connecting`   dial in flight (the spinner state)
 * - `connected`    a live connection is held (the Disconnect state)
 */
export type DevserverStatus = "disconnected" | "connecting" | "connected" | "unreachable";

export interface DevserverEntry {
  /** Stable registry id used for row actions and the connection-state map. For
   * a synthesized gateway roster row this is the desktop-minted
   * `gw:{gateway_id}:{owner}:{devserver_id}` triple; update/remove 404 on it. */
  id: string;
  /** Full configured endpoint URL, including scheme. */
  url: string;
  /**
   * The devserver host the desktop dials: hostname or IP, no scheme or port
   * (`box.example.com`). The desktop forms the dial / tenant URL from `host` +
   * `port` (`http://{host}:{port}{prefix}...`).
   */
  host: string;
  /** The devserver port the desktop dials. */
  port: number;
  /** Optional user label for the launcher section header. */
  label: string;
  /** Optional connect command the control terminal runs (e.g. an ssh forward). */
  script: string;
  /** Whether a bearer token is stored (the value is never returned). */
  has_token: boolean;
  /**
   * The library id this devserver is assigned once known, joining its window
   * rows in the feed to the user's name for it (the "🌐 + name" remote label).
   * null before the devserver's first connect, when no library id exists yet.
   */
  library_id: string | null;
  /**
   * Live connection lifecycle. Drives Connect vs Disconnect and the connect
   * spinner, and gates Edit read-only (the backend rejects edits while a
   * connection is held). `disconnected` on a surface with no desktop bridge.
   */
  status: DevserverStatus;
  /**
   * A gateway sign-in for this devserver is waiting on the user's browser:
   * the desktop opened the identity page and holds this until the deep link
   * returns, the wait times out, or the row is re-clicked (which re-opens
   * the browser). Renders as a waiting spinner row; `status` stays
   * `disconnected` while waiting. Always false off-desktop.
   */
  pending_signin: boolean;
  /**
   * Auto-hide the connect control terminal once the devserver connects: the
   * desktop buries the control-terminal window on success instead of leaving it
   * open. Set from the add/edit dialog; false when unset.
   */
  auto_hide_control: boolean;
  /**
   * The devserver host's OS family (`macos | windows | linux | other`),
   * self-reported at connect, driving the machine icon. Empty before the first
   * connect or from a devserver too old to report it; no icon is shown then. A
   * non-empty unrecognized value shows the neutral monitor mark.
   */
  os: string;
  /**
   * Best-effort human OS string for the machine-icon tooltip (e.g. a linux
   * `PRETTY_NAME`); null when unknown.
   */
  pretty_name: string | null;
  /**
   * The owning gateway's registry id for a synthesized gateway roster row;
   * null for a plain (persisted) devserver row. Synthesized rows are
   * read-only in the registry: no checkbox, no edit, no remove.
   */
  gateway_id: string | null;
  /** The owning gateway's URL; empty for plain rows. */
  gateway_url: string;
  /** A roster row shared with the account (role != owner), not owned by it. */
  shared: boolean;
  /** A shared roster row that needs explicit native-IPC consent before connect. */
  native_trust_required: boolean;
}

// ---- The gateway registry -------------------------------------------------
// A gateway is a remote chan-gateway the desktop holds an account-level
// connection to; its devservers surface as synthesized read-only rows in the
// devserver feed (`gateway_id` set). The launcher CRUDs the registry over
// HTTP; discovery, the account sign-in, roster polling, and the connection
// cascade are desktop-internal. The field names ARE the wire (the server's
// GatewayEntry).

/**
 * Live connection lifecycle of a gateway, driving the badge on the Gateways
 * screen:
 * - `disconnected` no live connection (the Connect state)
 * - `connecting`   discovery / sign-in / first roster fetch in flight
 * - `connected`    roster polling is live
 * - `unreachable`  polling kept failing; the desktop keeps the last-known
 *   roster and retries (401 instead cascades to `disconnected`)
 */
export type GatewayStatus = "disconnected" | "connecting" | "connected" | "unreachable";

export interface GatewayEntry {
  /** Stable registry id (desktop-minted `gw-<8hex>`). */
  id: string;
  /** The gateway origin the desktop discovers and polls. */
  url: string;
  /** Optional user label; empty falls back to the URL. */
  label: string;
  /** Persisted DESIRED state: connect on startup vs parked. Connect persists
   * true, disconnect false. */
  enabled: boolean;
  status: GatewayStatus;
  /** An account sign-in for this gateway is waiting on the user's browser. */
  pending_signin: boolean;
  /** How many roster devservers this gateway currently synthesizes. */
  devserver_count: number;
  /** The last connection/roster error, or null. */
  last_error: string | null;
}

/** Write payload for add gateway. Save just adds -- no probe, no sign-in. */
export interface GatewayInput {
  url: string;
  label?: string;
}

/** Write payload for add/edit devserver. `token` absent on edit leaves it unchanged. */
export interface DevserverInput {
  /** Full endpoint URL; preferred for new clients. */
  url?: string;
  /** The devserver host (hostname or IP, no scheme or port). Required, non-empty. */
  host: string;
  /** The devserver port. Required. */
  port: number;
  label?: string;
  script?: string;
  /** Bearer for a proxied/gateway devserver, so the user connects without scraping. */
  token?: string;
  /** Explicitly remove a stored bearer token on edit. */
  clear_token?: boolean;
  /** Auto-hide the connect control terminal on a successful connect. */
  auto_hide_control?: boolean;
}

// ---- The client surface -------------------------------------------------
// One interface, implemented twice: the live HTTP client below, and the
// in-memory mock (`./mock`) the launcher runs against until the handlers are
// deployed. `watchWindows` returns an unsubscribe handle.

/** Mint parameters beyond the window kind. */
export interface CreateWindowOptions {
  /** kind=workspace: the workspace root path. Omitted for a terminal. */
  workspacePath?: string;
  /** Client-claimed affinity. The window manager mints "browser"; desktop paths
   * omit it (absent => native), so a browser-minted record never opens a native
   * twin. */
  origin?: WindowOrigin;
  /** The caller's claimed leader window_id for the per-tenant mint gate. Absent
   * on legacy/leaderless callers (leaderless or matching-leader allows). */
  actingWindowId?: string;
}

export interface LibraryApi {
  listWorkspaces(): Promise<WorkspaceEntry[]>;
  addLocalWorkspace(path: string, label?: string): Promise<WorkspaceEntry>;
  /** Turn a local workspace on/off. An unforced off of a workspace with live
   * terminal sessions answers 409 `live_terminals` (parse with
   * `liveTerminalsCount`); retry with `force: true` to off it anyway. */
  setWorkspaceOn(id: string, on: boolean, force?: boolean): Promise<void>;
  removeWorkspace(id: string): Promise<void>;
  listDevservers(): Promise<DevserverEntry[]>;
  addDevserver(input: DevserverInput): Promise<DevserverEntry>;
  updateDevserver(id: string, input: DevserverInput): Promise<DevserverEntry>;
  removeDevserver(id: string): Promise<void>;
  /** Tell the desktop to connect a devserver (run its connect command + dial
   * the URL). A pure desktop action: a surface with no desktop bridge answers
   * 409, so the launcher only offers it where window-ops are available. */
  connectDevserver(id: string): Promise<void>;
  /** Tear down the desktop's live connection to a devserver (its windows leave
   * the feed). A desktop action; a surface with no desktop bridge answers 409. */
  disconnectDevserver(id: string): Promise<void>;
  /** Persist consent for one current shared gateway devserver's native IPC. */
  grantDevserverNativeTrust(id: string): Promise<void>;
  /** Revoke consent and wait for its desktop connection/windows to close. */
  revokeDevserverNativeTrust(id: string): Promise<void>;
  /** Open a terminal window on a connected devserver (desktop action, 409 with
   * no bridge). */
  openDevserverTerminal(id: string): Promise<void>;
  /** Open a window onto one of a connected devserver's served workspaces by its
   * remote path (desktop action, 409 with no bridge). */
  openDevserverWorkspace(id: string, path: string): Promise<void>;
  /** Turn a connected devserver's served workspace on/off by its mounted prefix
   * (desktop action, 409 with no bridge). An unforced off of a workspace that
   * still has live terminal sessions answers 409 `{error:"live_terminals",
   * active_terminals:N}`; pass `force` to tear them down and turn off anyway. */
  setDevserverWorkspaceOn(id: string, prefix: string, on: boolean, force?: boolean): Promise<void>;
  /** Forget (unmount + drop) a connected devserver's served workspace by its
   * mounted prefix (desktop action, 409 with no bridge). An unforced forget with
   * live terminals answers the same live_terminals body as off. */
  forgetDevserverWorkspace(id: string, prefix: string, force?: boolean): Promise<void>;
  /** List the gateway registry. Empty on surfaces that hold none. */
  listGateways(): Promise<GatewayEntry[]>;
  /** Register a gateway by URL. Save just adds: no probe, no sign-in; the
   * first Connect discovers + signs in. */
  addGateway(input: GatewayInput): Promise<GatewayEntry>;
  /** Rename a gateway (label only). The URL is the gateway's identity and
   * stays fixed: remove + re-add changes the origin. */
  updateGateway(id: string, input: GatewayInput): Promise<GatewayEntry>;
  /** Remove a gateway. The desktop cascades: live roster connections tear
   * down and the synthesized rows leave the feed. */
  removeGateway(id: string): Promise<void>;
  /** Connect a gateway (persists enabled=true; discovery, sign-in, and the
   * roster poll are desktop-internal). A surface with no desktop bridge
   * answers 409. */
  connectGateway(id: string): Promise<void>;
  /** Disconnect a gateway (persists enabled=false; cascades its live rows).
   * A surface with no desktop bridge answers 409. */
  disconnectGateway(id: string): Promise<void>;
  /** Open the desktop's native folder picker; resolves to the chosen absolute
   * path, or null if the user cancelled. A pure desktop action (no desktop
   * bridge → 409), offered only where window-ops are available. */
  pickFolder(): Promise<string | null>;
  listWindows(): Promise<WindowRecord[]>;
  watchWindows(onSet: (set: WindowSet) => void): () => void;
  /** Mint a window of the local library (client supplies the kind; the library
   * supplies the id + persists). A terminal window has no workspacePath. The
   * window manager mints `origin:"browser"` and stamps the acting window_id (its
   * leader claim for the per-tenant mint gate); desktop paths omit both (absent
   * origin => native, absent claim allowed when leaderless). */
  createWindow(kind: WindowKind, opts?: CreateWindowOptions): Promise<WindowRecord>;
  /** Open (focus a live window / un-hide a buried one) via the desktop window
   * bridge. Rejects on a surface with no desktop attached. */
  openWindow(id: string): Promise<void>;
  /** Hide (bury) a window via the desktop window bridge, notification-free,
   * unlike the OS close button. Rejects with no desktop attached. */
  hideWindow(id: string): Promise<void>;
  /** Permanently close a native window through the desktop bridge. The owning
   * registry row is discarded; live local terminals retain the native confirm. */
  closeWindow(id: string): Promise<void>;
  /** Discard (unpersist + reap) a window record: the web-op close, distinct from
   * the desktop `/hide` bridge and reachable bridgeless. A follower never calls
   * it. `actingWindowId` claims the caller's leader identity for the per-tenant
   * gate; a mismatch against a live leader answers 403. */
  discardWindow(id: string, actingWindowId?: string): Promise<void>;
  /** Flip a window's server-persisted visibility (the bridgeless web op, not the
   * desktop `/hide` bridge). `actingWindowId` is the same leader claim as
   * discardWindow. */
  setWindowVisibility(id: string, hidden: boolean, actingWindowId?: string): Promise<void>;
  /** Persist optional user text beside a non-control window's generated label. */
  setWindowLabel(id: string, label: string, actingWindowId?: string): Promise<void>;
}

/** A non-2xx response, carrying the status and the server's text body. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    body: string,
  ) {
    super(body || `HTTP ${status}`);
    this.name = "ApiError";
  }
}

/**
 * The live-terminal count carried by an unforced devserver-workspace off that
 * was refused because the workspace still has live terminal sessions. Returns
 * `active_terminals` when `e` is an `ApiError` whose 409 body parses to
 * `{error:"live_terminals", active_terminals:N}`, else null, so the launcher
 * can confirm-and-retry only that case and let a plain `NO_DESKTOP` 409 (whose
 * body is not that JSON) fall through to the generic error banner.
 */
export function liveTerminalsCount(e: unknown): number | null {
  if (!(e instanceof ApiError) || e.status !== 409) return null;
  try {
    const body = JSON.parse(e.message) as { error?: unknown; active_terminals?: unknown };
    if (body.error === "live_terminals" && typeof body.active_terminals === "number") {
      return body.active_terminals;
    }
  } catch {
    // Not JSON (e.g. the plain `NO_DESKTOP` string body) → not the live case.
  }
  return null;
}

// The bearer the library hands the SPA. On loopback the launcher is served
// same-origin with a `?t=<token>` query (mirrors web/'s transport); a plain
// browser test passes it the same way. Empty means same-origin with no
// bearer (the local loopback default).
function authToken(): string {
  return new URLSearchParams(location.search).get("t") ?? "";
}

function cookieValue(name: string): string {
  if (typeof document === "undefined") return "";
  const prefix = `${name}=`;
  for (const part of document.cookie.split(";")) {
    const s = part.trim();
    if (s.startsWith(prefix)) {
      try {
        return decodeURIComponent(s.slice(prefix.length));
      } catch {
        return "";
      }
    }
  }
  return "";
}

function isUnsafeMethod(method: string): boolean {
  return method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  const token = authToken();
  if (token) headers.authorization = `Bearer ${token}`;
  const csrf = isUnsafeMethod(method) ? cookieValue("__Host-devserver_csrf") : "";
  if (csrf) headers["x-chan-csrf"] = csrf;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new ApiError(res.status, text);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** The live HTTP client. Ships once the /api/library/* handlers are deployed. */
export const liveApi: LibraryApi = {
  listWorkspaces: () => req("GET", "/api/library/workspaces"),
  addLocalWorkspace: (path, label) => req("POST", "/api/library/workspaces", { path, label }),
  setWorkspaceOn: (id, on, force) =>
    req(
      "POST",
      `/api/library/workspaces/${encodeURIComponent(id)}/${on ? "on" : "off"}`,
      // The off route accepts a `{ force }` body (live-terminal confirm); on
      // takes no body.
      on ? undefined : { force },
    ),
  removeWorkspace: (id) => req("DELETE", `/api/library/workspaces/${encodeURIComponent(id)}`),
  listDevservers: () => req("GET", "/api/library/devservers"),
  addDevserver: (input) => req("POST", "/api/library/devservers", input),
  updateDevserver: (id, input) =>
    req("PUT", `/api/library/devservers/${encodeURIComponent(id)}`, input),
  removeDevserver: (id) => req("DELETE", `/api/library/devservers/${encodeURIComponent(id)}`),
  connectDevserver: (id) =>
    req("POST", `/api/library/devservers/${encodeURIComponent(id)}/connect`),
  disconnectDevserver: (id) =>
    req("POST", `/api/library/devservers/${encodeURIComponent(id)}/disconnect`),
  grantDevserverNativeTrust: (id) =>
    req("PUT", `/api/library/devservers/${encodeURIComponent(id)}/native-trust`),
  revokeDevserverNativeTrust: (id) =>
    req("DELETE", `/api/library/devservers/${encodeURIComponent(id)}/native-trust`),
  openDevserverTerminal: (id) =>
    req("POST", `/api/library/devservers/${encodeURIComponent(id)}/terminal`),
  // The devserver-workspace ops carry the remote mount `prefix` / `path` in the
  // JSON body, not a path segment: a mount prefix can hold characters axum's
  // Path extractor + intervening (gateway) proxies mangle. on/off/forget are
  // distinct POST routes; forget is POST (a DELETE body is poorly supported).
  openDevserverWorkspace: (id, path) =>
    req("POST", `/api/library/devservers/${encodeURIComponent(id)}/workspaces/open`, { path }),
  // `on` posts just the prefix; `off` carries `force` so an unforced off can
  // answer 409 live_terminals and the launcher retry the same route forced.
  setDevserverWorkspaceOn: (id, prefix, on, force) =>
    req(
      "POST",
      `/api/library/devservers/${encodeURIComponent(id)}/workspaces/${on ? "on" : "off"}`,
      on ? { prefix } : { prefix, force },
    ),
  forgetDevserverWorkspace: (id, prefix, force) =>
    req("POST", `/api/library/devservers/${encodeURIComponent(id)}/workspaces/forget`, {
      prefix,
      force,
    }),
  listGateways: () => req("GET", "/api/library/gateways"),
  addGateway: (input) => req("POST", "/api/library/gateways", input),
  updateGateway: (id, input) =>
    req("PUT", `/api/library/gateways/${encodeURIComponent(id)}`, input),
  removeGateway: (id) => req("DELETE", `/api/library/gateways/${encodeURIComponent(id)}`),
  connectGateway: (id) => req("POST", `/api/library/gateways/${encodeURIComponent(id)}/connect`),
  disconnectGateway: (id) =>
    req("POST", `/api/library/gateways/${encodeURIComponent(id)}/disconnect`),
  pickFolder: () => req("POST", "/api/library/fs/pick-folder"),
  listWindows: () => req("GET", "/api/library/windows"),
  watchWindows: (onSet) => {
    // The feed is the live resync channel: the server pushes a FULL snapshot on
    // connect and on every change, so a fresh connection re-syncs the whole world.
    // Reconnect with capped backoff when the socket drops -- a closed socket left
    // un-rearmed is how a row strands on a stale `starting`/`connecting` status
    // (the dangling spinner), since no further push ever lands. The reconnect's
    // on-connect snapshot is the consolidation step that corrects it.
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    let ws: WebSocket | null = null;
    let stopped = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const open = (): void => {
      const token = authToken();
      const q = token ? `?t=${encodeURIComponent(token)}` : "";
      ws = new WebSocket(`${proto}//${location.host}/api/library/windows/watch${q}`);
      ws.onmessage = (ev) => {
        attempt = 0; // a frame proves the link is healthy: reset the backoff
        try {
          onSet(JSON.parse(ev.data) as WindowSet);
        } catch {
          // A malformed frame is dropped; the next full snapshot self-heals.
        }
      };
      ws.onclose = () => {
        if (!stopped) scheduleReconnect();
      };
      ws.onerror = () => {
        // Surface the failure as a close so the single reconnect path runs.
        ws?.close();
      };
    };

    const scheduleReconnect = (): void => {
      if (stopped || timer !== null) return;
      // 0.5s, 1s, 2s, 4s ... capped at 15s.
      const delay = Math.min(500 * 2 ** attempt, 15000);
      attempt += 1;
      timer = setTimeout(() => {
        timer = null;
        if (!stopped) open();
      }, delay);
    };

    open();
    return () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      ws?.close();
    };
  },
  createWindow: (kind, opts) =>
    req("POST", "/api/library/windows", {
      kind,
      ...(opts?.workspacePath ? { workspace_path: opts.workspacePath } : {}),
      ...(opts?.actingWindowId ? { acting_window_id: opts.actingWindowId } : {}),
      ...(opts?.origin ? { origin: opts.origin } : {}),
    }),
  openWindow: (id) => req("POST", `/api/library/windows/${encodeURIComponent(id)}/open`),
  hideWindow: (id) => req("POST", `/api/library/windows/${encodeURIComponent(id)}/hide`),
  closeWindow: (id) => req("POST", `/api/library/windows/${encodeURIComponent(id)}/close`),
  discardWindow: (id, actingWindowId) =>
    req(
      "DELETE",
      `/api/library/windows/${encodeURIComponent(id)}${
        actingWindowId ? `?acting_window_id=${encodeURIComponent(actingWindowId)}` : ""
      }`,
    ),
  setWindowVisibility: (id, hidden, actingWindowId) =>
    req("POST", `/api/library/windows/${encodeURIComponent(id)}/visibility`, {
      hidden,
      ...(actingWindowId ? { acting_window_id: actingWindowId } : {}),
    }),
  setWindowLabel: (id, label, actingWindowId) =>
    req("PUT", `/api/library/windows/${encodeURIComponent(id)}/label`, {
      label,
      ...(actingWindowId ? { acting_window_id: actingWindowId } : {}),
    }),
};
