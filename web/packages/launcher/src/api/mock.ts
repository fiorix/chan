// An in-memory backend implementing the same wire as the live client. The
// launcher runs against this until the /api/library/* handlers are deployed,
// which keeps the whole SPA browser-testable with no backend. It seeds a
// local library plus one devserver so every surface (registry rows, the
// two-choice dialog, the window feed with both local and remote libraries)
// has something real to render. Mutations notify the watch subscribers, so
// the feed updates live when a workspace toggles or a devserver is added.

import {
  ApiError,
  type DevserverEntry,
  type GatewayEntry,
  type LibraryApi,
  type WindowRecord,
  type WindowSet,
  type WorkspaceEntry,
} from "./library";

// The mock stores the bearer alongside the public record; the public shape
// (returned by listDevservers) never carries it.
interface MockDevserver extends DevserverEntry {
  token: string;
}

const DS_LIBRARY_ID = "lib-7f3a9c21b40d8e65";

let nextWs = 3;
let nextDs = 3;

// Local workspace rows carry the merged-feed tags too: devserver_id null marks
// them local (the SPA groups by devserver_id), library_id "local", and a
// slash-free prefix that equals the workspace_id (local rows route on/off/rm by
// workspace_id -- mirrors the server's local LauncherWorkspace).
const workspaces: WorkspaceEntry[] = [
  {
    workspace_id: "ws-1",
    path: "/home/hacker/notes",
    label: "",
    on: true,
    status: "running",
    library_id: "local",
    devserver_id: null,
    prefix: "ws-1",
  },
  {
    workspace_id: "ws-2",
    path: "/home/hacker/work/journal",
    label: "Journal",
    on: false,
    status: "stopped",
    library_id: "local",
    devserver_id: null,
    prefix: "ws-2",
  },
];

const devservers: MockDevserver[] = [
  {
    id: "ds-1",
    url: "http://box.example.com:8787",
    host: "box.example.com",
    port: 8787,
    label: "prod",
    script: "ssh box.example.com -L 8787:localhost:8787 chan devserver --join",
    has_token: true,
    token: "tok_seeded_prod",
    library_id: DS_LIBRARY_ID,
    // Seeded connected so the merged view (remote windows + remote workspace
    // rows + the Disconnect action) has something real to render with no desktop.
    status: "connected",
    pending_signin: false,
    auto_hide_control: false,
    os: "linux",
    pretty_name: "Debian GNU/Linux 12 (bookworm)",
    gateway_id: null,
    gateway_url: "",
    shared: false,
    native_trust_required: false,
  },
];

// The gateway registry starts empty (the read-only and browser-test surfaces
// hold none); addGateway keeps CRUD exercisable in-memory.
const gateways: GatewayEntry[] = [];
let nextGw = 1;

// A connected devserver's served workspaces, merged into the workspace feed
// tagged with their devserver_id + library_id. Only surface while the owning
// devserver is connected (the live feed source returns connected devservers'
// workspaces); listWorkspaces filters on the devserver's `status`.
const devserverWorkspaces: WorkspaceEntry[] = [
  {
    workspace_id: "ds-1:w/api",
    path: "/srv/api",
    label: "api",
    on: true,
    status: "running",
    library_id: DS_LIBRARY_ID,
    devserver_id: "ds-1",
    prefix: "w/api",
  },
  {
    workspace_id: "ds-1:w/docs",
    path: "/srv/docs",
    label: "docs",
    on: false,
    status: "stopped",
    library_id: DS_LIBRARY_ID,
    devserver_id: "ds-1",
    prefix: "w/docs",
  },
];

// How many live terminal sessions a workspace has -- REMOTE rows keyed by
// `devserver_id:prefix`, LOCAL rows by `local:<workspace_id>`. A workspace
// listed here makes an UNFORCED off answer 409 `live_terminals` (mirroring the
// server), so the SPA + tests exercise the confirm-and-retry path; a forced off
// ignores it and turns off. Seeded on the connected `ds-1:w/api` so the
// devserver confirm is reachable in the mock SPA; local entries are added by
// the test helper below.
const liveTerminals = new Map<string, number>([["ds-1:w/api", 2]]);

/** Test-only: flag a LOCAL workspace as having N live terminal sessions so an
 * unforced `setWorkspaceOn(id, false)` answers 409 `live_terminals` (exercises
 * the local off confirm-and-retry, parity with the devserver path). A forced
 * off clears the flag. */
export function setMockLocalLiveTerminals(workspace_id: string, n: number): void {
  liveTerminals.set(`local:${workspace_id}`, n);
}

/** Test-only: drop every mock gateway (the registry seeds empty), so a suite
 * that adds one stays order-independent. */
export function resetMockGateways(): void {
  gateways.length = 0;
}

/** Re-seed the remote-workspace state the confirm-and-retry flow mutates (the
 * `ds-1:w/api` row turns off on a forced retry and drops its live-terminal
 * flag). Test-only, so a suite that exercises the flow stays order-independent;
 * unused on the live SPA path. */
export function resetMockRemoteWorkspaces(): void {
  for (const w of devserverWorkspaces) {
    w.on = w.prefix !== "w/docs";
    w.status = w.on ? "running" : "stopped";
  }
  liveTerminals.clear();
  liveTerminals.set("ds-1:w/api", 2);
}

const windows: WindowRecord[] = [
  {
    window_id: "w-local-term-1",
    library_id: "local",
    kind: "terminal",
    title: "🏠 Terminal Window 1",
    ordinal: 1,
    workspace_path: null,
    prefix: "t/local-1",
    token: "tok_local_term",
    persisted: true,
    connected: true,
    active_transfer: false,
    control: false,
  },
  {
    window_id: "w-local-notes-1",
    library_id: "local",
    kind: "workspace",
    title: "🏠 notes Window 1",
    ordinal: 1,
    workspace_path: "/home/hacker/notes",
    prefix: "w/notes",
    token: "tok_local_notes",
    persisted: true,
    connected: true,
    active_transfer: false,
    control: false,
  },
  {
    // The devserver's connect control terminal: control:true, ordinal 0 → the
    // feed pins it FIRST in the ds1 group (the desktop mints it).
    window_id: "w-ds1-control",
    library_id: DS_LIBRARY_ID,
    kind: "terminal",
    title: "🌐 Control terminal",
    ordinal: 0,
    workspace_path: null,
    prefix: "t/ds1-control",
    token: "tok_ds1_control",
    persisted: false,
    connected: true,
    active_transfer: false,
    control: true,
  },
  {
    // Seeded hidden window: a buried devserver window -- webview destroyed
    // (connected:false) and persisted hidden -- so the feed renders a "Hidden
    // windows" section and an EyeOff ("Show window") toggle.
    window_id: "w-ds1-term-1",
    library_id: DS_LIBRARY_ID,
    kind: "terminal",
    title: "🏠 Terminal Window 1",
    ordinal: 1,
    workspace_path: null,
    prefix: "t/ds1-1",
    token: "",
    persisted: true,
    connected: false,
    active_transfer: false,
    control: false,
    hidden: true,
  },
  {
    window_id: "w-ds1-api-1",
    library_id: DS_LIBRARY_ID,
    kind: "workspace",
    title: "🏠 api Window 1",
    ordinal: 1,
    workspace_path: "/srv/api",
    prefix: "w/api",
    token: "tok_ds1_api",
    persisted: true,
    connected: true,
    active_transfer: false,
    control: false,
  },
];

const subscribers = new Set<(set: WindowSet) => void>();

function notify(): void {
  const set: WindowSet = { windows: windows.map((w) => ({ ...w })) };
  for (const fn of subscribers) fn(set);
}

/** Drop every local workspace window rooted at `path` from the feed -- mirrors
 * the backend's `discard_workspace_windows` so an off/forgotten workspace
 * leaves no ghost window records. */
function discardWorkspaceWindows(path: string): void {
  for (let i = windows.length - 1; i >= 0; i--) {
    const w = windows[i]!;
    if (w.kind === "workspace" && w.library_id === "local" && w.workspace_path === path) {
      windows.splice(i, 1);
    }
  }
}

function publicDevserver(ds: MockDevserver): DevserverEntry {
  // Never echo the token; report only whether one is stored (write-only wire).
  return {
    id: ds.id,
    url: ds.url,
    host: ds.host,
    port: ds.port,
    label: ds.label,
    script: ds.script,
    has_token: ds.has_token,
    library_id: ds.library_id,
    status: ds.status,
    pending_signin: ds.pending_signin,
    auto_hide_control: ds.auto_hide_control,
    os: ds.os,
    pretty_name: ds.pretty_name,
    gateway_id: ds.gateway_id,
    gateway_url: ds.gateway_url,
    shared: ds.shared,
    native_trust_required: ds.native_trust_required,
  };
}

/** The merged workspace feed: local rows + every connected devserver's served
 * workspaces (the live feed source supplies only connected devservers'). */
function mergedWorkspaces(): WorkspaceEntry[] {
  const connectedIds = new Set(
    devservers.filter((d) => d.status === "connected").map((d) => d.id),
  );
  const remote = devserverWorkspaces.filter((w) => w.devserver_id && connectedIds.has(w.devserver_id));
  return [...workspaces, ...remote].map((w) => ({ ...w }));
}

// A small async hop so the SPA exercises its loading paths the way it will
// against the network, and so optimistic UI has a frame to settle.
function tick<T>(value: T): Promise<T> {
  return Promise.resolve(value);
}

export const mockApi: LibraryApi = {
  listWorkspaces: () => tick(mergedWorkspaces()),

  addLocalWorkspace: (path, label) => {
    const workspace_id = `ws-${nextWs++}`;
    const entry: WorkspaceEntry = {
      workspace_id,
      path,
      label: (label ?? "").trim(),
      on: true,
      status: "running",
      library_id: "local",
      devserver_id: null,
      prefix: workspace_id,
    };
    workspaces.push(entry);
    return tick({ ...entry });
  },

  setWorkspaceOn: (id, on, force) => {
    const ws = workspaces.find((w) => w.workspace_id === id);
    // Mirror the server: an UNFORCED off of a workspace with live terminals
    // answers 409 live_terminals; a forced off (or no live terminals) proceeds.
    const liveKey = `local:${id}`;
    if (!on && !force && liveTerminals.has(liveKey)) {
      return Promise.reject(
        new ApiError(
          409,
          JSON.stringify({ error: "live_terminals", active_terminals: liveTerminals.get(liveKey) }),
        ),
      );
    }
    if (ws) {
      ws.on = on;
      // The live mount settles synchronously here (no real backend to mount):
      // on -> running, off -> stopped. The launcher's spinner during the click
      // is the optimistic bridge; a real backend would report `starting` first.
      ws.status = on ? "running" : "stopped";
    }
    // Turning a workspace off PURGES its workspace windows from the feed,
    // mirroring the backend's discard_workspace_windows (off + forget) -- no
    // stale window records linger. On does not restore them (the user opens
    // new ones).
    if (!on && ws) {
      discardWorkspaceWindows(ws.path);
      liveTerminals.delete(liveKey);
    }
    notify();
    return tick(undefined);
  },

  removeWorkspace: (id) => {
    const i = workspaces.findIndex((w) => w.workspace_id === id);
    if (i >= 0) {
      discardWorkspaceWindows(workspaces[i]!.path);
      workspaces.splice(i, 1);
      notify();
    }
    return tick(undefined);
  },

  listDevservers: () => tick(devservers.map(publicDevserver)),

  addDevserver: (input) => {
    const ds: MockDevserver = {
      id: `ds-${nextDs++}`,
      url: input.url ?? `http://${input.host}:${input.port}`,
      host: input.host,
      port: input.port,
      label: input.label ?? "",
      script: input.script ?? "",
      has_token: !!input.token,
      token: input.token ?? "",
      // No library id until the desktop connects this devserver for the first time.
      library_id: null,
      // A freshly added devserver is disconnected until the desktop dials it.
      status: "disconnected",
      pending_signin: false,
      auto_hide_control: input.auto_hide_control ?? false,
      // OS is unknown until the first connect surfaces the self-report.
      os: "",
      pretty_name: null,
      // A registry add is always a plain row; gateway rows are synthesized.
      gateway_id: null,
      gateway_url: "",
      shared: false,
      native_trust_required: false,
    };
    devservers.push(ds);
    return tick(publicDevserver(ds));
  },

  updateDevserver: (id, input) => {
    const ds = devservers.find((d) => d.id === id);
    if (!ds) throw new Error(`unknown devserver ${id}`);
    ds.host = input.host;
    ds.port = input.port;
    ds.label = input.label ?? "";
    ds.script = input.script ?? "";
    ds.auto_hide_control = input.auto_hide_control ?? false;
    // A token omitted on edit leaves the stored one unchanged (the write-only
    // contract): only a non-empty token replaces it. Clearing is explicit.
    if (input.token) {
      ds.token = input.token;
      ds.has_token = true;
    } else if (input.clear_token) {
      ds.token = "";
      ds.has_token = false;
    }
    return tick(publicDevserver(ds));
  },

  removeDevserver: (id) => {
    const i = devservers.findIndex((d) => d.id === id);
    if (i >= 0) devservers.splice(i, 1);
    return tick(undefined);
  },

  // The mock has no desktop to dial, so connecting just marks the devserver
  // connected (its served-workspace rows then merge into the feed) and its
  // existing windows live, then pushes the feed -- enough for the mock SPA and
  // tests to see the connect action take effect. A real surface runs the
  // connect command and dials the URL through the desktop bridge.
  connectDevserver: (id) => {
    const ds = devservers.find((d) => d.id === id);
    if (ds) {
      ds.status = "connected";
      if (ds.library_id) {
        for (const w of windows) if (w.library_id === ds.library_id) w.connected = true;
      }
      notify();
    }
    return tick(undefined);
  },

  // Disconnect drops the live connection: the devserver's windows detach and
  // its served-workspace rows leave the merged feed (mergedWorkspaces filters
  // on `status`). The registry entry stays (Connect can redial).
  disconnectDevserver: (id) => {
    const ds = devservers.find((d) => d.id === id);
    if (ds) {
      ds.status = "disconnected";
      if (ds.library_id) {
        for (let i = windows.length - 1; i >= 0; i--) {
          const w = windows[i]!;
          if (w.library_id !== ds.library_id) continue;
          if (w.control) windows.splice(i, 1);
          else w.connected = false;
        }
      }
      notify();
    }
    return tick(undefined);
  },

  grantDevserverNativeTrust: (id) => {
    const ds = devservers.find((d) => d.id === id);
    if (!ds || !ds.gateway_id || !ds.shared) {
      return Promise.reject(new ApiError(409, "native trust requires a shared gateway row"));
    }
    ds.native_trust_required = false;
    return tick(undefined);
  },

  revokeDevserverNativeTrust: (id) => {
    const ds = devservers.find((d) => d.id === id);
    if (!ds || !ds.gateway_id || !ds.shared) {
      return Promise.reject(new ApiError(409, "native trust requires a shared gateway row"));
    }
    ds.native_trust_required = true;
    ds.status = "disconnected";
    notify();
    return tick(undefined);
  },

  openDevserverTerminal: (id) => {
    const ds = devservers.find((d) => d.id === id);
    if (ds?.library_id) {
      const ordinal =
        windows.filter((w) => w.library_id === ds.library_id && w.kind === "terminal").length + 1;
      windows.push({
        window_id: `w-${id}-term-${windows.length + 1}`,
        library_id: ds.library_id,
        kind: "terminal",
        title: `🌐 Terminal Window ${ordinal}`,
        ordinal,
        workspace_path: null,
        prefix: `t/${id}-${ordinal}`,
        token: "tok_remote_term",
        persisted: true,
        connected: true,
        active_transfer: false,
        control: false,
      });
      notify();
    }
    return tick(undefined);
  },

  // Open a window onto one of a connected devserver's served workspaces (by its
  // remote path): mint a remote workspace window and push the feed.
  openDevserverWorkspace: (id, path) => {
    const ds = devservers.find((d) => d.id === id);
    if (ds?.library_id) {
      const base = path.split("/").filter(Boolean).pop() ?? "workspace";
      windows.push({
        window_id: `w-${id}-ws-${windows.length + 1}`,
        library_id: ds.library_id,
        kind: "workspace",
        title: `🌐 ${base} Window 1`,
        ordinal: 1,
        workspace_path: path,
        prefix: `w/${base}`,
        token: "tok_remote_ws",
        persisted: true,
        connected: true,
        active_transfer: false,
        control: false,
      });
      notify();
    }
    return tick(undefined);
  },

  // Turn a connected devserver's served workspace on/off by its mounted prefix.
  // An UNFORCED off of a workspace with seeded live terminals answers 409
  // live_terminals (like the server), so the launcher opens its confirm dialog;
  // a forced off clears the live-terminal flag and turns off.
  setDevserverWorkspaceOn: (id, prefix, on, force) => {
    const ws = devserverWorkspaces.find((w) => w.devserver_id === id && w.prefix === prefix);
    const key = `${id}:${prefix}`;
    if (!on && !force && liveTerminals.has(key)) {
      return Promise.reject(
        new ApiError(
          409,
          JSON.stringify({ error: "live_terminals", active_terminals: liveTerminals.get(key) }),
        ),
      );
    }
    if (!on && force) liveTerminals.delete(key);
    if (ws) {
      ws.on = on;
      ws.status = on ? "running" : "stopped";
    }
    notify();
    return tick(undefined);
  },

  // Forget (unmount + drop) a connected devserver's served workspace by prefix:
  // remove the row + any of its windows, then push the feed.
  forgetDevserverWorkspace: (id, prefix, _force) => {
    const i = devserverWorkspaces.findIndex((w) => w.devserver_id === id && w.prefix === prefix);
    if (i >= 0) devserverWorkspaces.splice(i, 1);
    notify();
    return tick(undefined);
  },

  listGateways: () => tick(gateways.map((g) => ({ ...g }))),

  addGateway: (input) => {
    const gw: GatewayEntry = {
      id: `gw-mock${nextGw++}`,
      url: input.url,
      label: (input.label ?? "").trim(),
      enabled: true,
      status: "disconnected",
      pending_signin: false,
      devserver_count: 0,
      last_error: null,
    };
    gateways.push(gw);
    notify();
    return tick({ ...gw });
  },

  // Rename only: the URL is the gateway's identity, so update never touches it
  // (the real registry refuses a different origin).
  updateGateway: (id, input) => {
    const gw = gateways.find((g) => g.id === id);
    if (!gw) throw new Error(`unknown gateway ${id}`);
    gw.label = (input.label ?? "").trim();
    notify();
    return tick({ ...gw });
  },

  removeGateway: (id) => {
    const i = gateways.findIndex((g) => g.id === id);
    if (i >= 0) {
      gateways.splice(i, 1);
      notify();
    }
    return tick(undefined);
  },

  // The mock has no desktop to discover/sign in through, so connect just marks
  // the gateway connected (and disconnect back), mirroring the devserver mock.
  connectGateway: (id) => {
    const gw = gateways.find((g) => g.id === id);
    if (gw) {
      gw.status = "connected";
      gw.enabled = true;
      notify();
    }
    return tick(undefined);
  },

  disconnectGateway: (id) => {
    const gw = gateways.find((g) => g.id === id);
    if (gw) {
      gw.status = "disconnected";
      gw.enabled = false;
      notify();
    }
    return tick(undefined);
  },

  // The mock has no native dialog, so it returns a canned path as if the user
  // picked one. A real desktop opens the OS folder picker; cancel returns null.
  pickFolder: () => tick("/Users/you/picked-folder"),

  listWindows: () => tick(windows.map((w) => ({ ...w }))),

  createWindow: (kind, opts) => {
    const workspacePath = opts?.workspacePath;
    const localTerminals = windows.filter(
      (w) => w.library_id === "local" && w.kind === "terminal",
    ).length;
    const ordinal = kind === "terminal" ? localTerminals + 1 : 1;
    const base = workspacePath ? workspacePath.split("/").filter(Boolean).pop() : null;
    const rec: WindowRecord = {
      window_id: `w-local-${kind}-${windows.length + 1}`,
      library_id: "local",
      kind,
      title: kind === "terminal" ? `🏠 Terminal Window ${ordinal}` : `🏠 ${base} Window ${ordinal}`,
      ordinal,
      workspace_path: kind === "workspace" ? (workspacePath ?? null) : null,
      prefix: `t/local-${windows.length + 1}`,
      token: "tok_local",
      persisted: true,
      connected: true,
      active_transfer: false,
      control: false,
      ...(opts?.origin ? { origin: opts.origin } : {}),
    };
    windows.push(rec);
    notify();
    return tick({ ...rec });
  },

  // The mock has no desktop, so open/hide just flip the in-memory window's
  // `connected` and push the feed -- enough for the mock SPA and tests to see the
  // status dot react. A real surface drives the native window through the bridge.
  // Bridge ops: on the real desktop these funnel through bury/unbury,
  // which persists `hidden` and (un)spawns the webview. The mock mirrors both so
  // the feed's Open/Hidden split + the connection dot stay coherent.
  openWindow: (id) => {
    const w = windows.find((x) => x.window_id === id);
    if (w) {
      w.hidden = false;
      w.connected = true;
    }
    notify();
    return tick(undefined);
  },

  hideWindow: (id) => {
    const w = windows.find((x) => x.window_id === id);
    if (w) {
      w.hidden = true;
      w.connected = false;
    }
    notify();
    return tick(undefined);
  },

  closeWindow: (id) => {
    const i = windows.findIndex((w) => w.window_id === id);
    if (i >= 0) windows.splice(i, 1);
    notify();
    return tick(undefined);
  },

  // The web-op close and visibility flip the mock uses in place of the desktop
  // bridge ops: discard drops the record, visibility mirrors open/hide's
  // hidden+connected split. `actingWindowId` is a no-op in the mock (no gate).
  discardWindow: (id) => {
    const i = windows.findIndex((w) => w.window_id === id);
    if (i >= 0) {
      windows.splice(i, 1);
      notify();
    }
    return tick(undefined);
  },

  setWindowVisibility: (id, hidden) => {
    const w = windows.find((x) => x.window_id === id);
    if (w) {
      w.hidden = hidden;
      w.connected = !hidden;
    }
    notify();
    return tick(undefined);
  },

  setWindowLabel: (id, label) => {
    const w = windows.find((x) => x.window_id === id);
    if (w) w.label = label.trim();
    notify();
    return tick(undefined);
  },

  watchWindows: (onSet) => {
    subscribers.add(onSet);
    // Full snapshot on subscribe, mirroring the live watch socket.
    onSet({ windows: windows.map((w) => ({ ...w })) });
    return () => {
      subscribers.delete(onSet);
    };
  },
};
