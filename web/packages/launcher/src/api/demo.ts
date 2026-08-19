import {
  ApiError,
  type DevserverEntry,
  type DevserverInput,
  type GatewayEntry,
  type GatewayInput,
  type LibraryApi,
  type WindowRecord,
  type WindowSet,
  type WorkspaceEntry,
} from "./library";

interface DemoDevserver extends DevserverEntry {
  token: string;
}

export interface LauncherDemoApi extends LibraryApi {
  reset(): void;
  // Null when the variant seeds no devservers, so there is nothing to flash.
  attentionDevserverId: string | null;
}

const LIMA_LIBRARY_ID = "lib-lima";
const WINDOWS_LIBRARY_ID = "lib-windows";
const LINUX_LIBRARY_ID = "lib-linux";
// The control terminal that slow-flashes for attention belongs to a
// disconnected remote whose control script died: the dead control row stays
// mounted so the user can open it and read the death reason, and the shared
// attention state turns the devserver's machine icon red.
const ATTENTION_DEVSERVER_ID = "ds-linux";

interface Seed {
  workspaces: WorkspaceEntry[];
  devservers: DemoDevserver[];
  devserverWorkspaces: WorkspaceEntry[];
  gateways: GatewayEntry[];
  windows: WindowRecord[];
  liveTerminals: [string, number][];
  nextWs: number;
  nextDs: number;
}

function seed(): Seed {
  return {
    nextWs: 1,
    nextDs: 1,
    workspaces: [
      {
        workspace_id: "ws-secret",
        path: "/Users/hacker/dev/my-secret-project",
        label: "",
        on: true,
        status: "running",
        library_id: "local",
        devserver_id: null,
        prefix: "ws-secret",
      },
      {
        workspace_id: "ws-openclaw",
        path: "/Users/hacker/dev/github.com/openclaw/openclaw",
        label: "",
        on: false,
        status: "stopped",
        library_id: "local",
        devserver_id: null,
        prefix: "ws-openclaw",
      },
    ],
    devservers: [
      {
        id: "ds-lima",
        url: "http://127.0.0.1:9001",
        host: "127.0.0.1",
        port: 9001,
        label: "lima-vm",
        script: "limactl shell chan -- chan devserver join",
        has_token: false,
        token: "",
        library_id: LIMA_LIBRARY_ID,
        status: "connected",
        pending_signin: false,
        // Auto-hide ticked and the connect succeeded, so the control
        // terminal below is seeded hidden: the clean fully-green remote.
        auto_hide_control: true,
        os: "linux",
        pretty_name: "Ubuntu 24.04.1 LTS",
        gateway_id: null,
        gateway_url: "",
        shared: false,
        native_trust_required: false,
      },
      {
        id: "ds-windows",
        url: "http://127.0.0.1:9002",
        host: "127.0.0.1",
        port: 9002,
        label: "windows-tunnel",
        script: "ssh windows-tunnel -L 9002:localhost:8787 chan devserver join",
        has_token: false,
        token: "",
        library_id: WINDOWS_LIBRARY_ID,
        status: "connected",
        pending_signin: false,
        auto_hide_control: false,
        os: "windows",
        pretty_name: "Windows 11 Pro",
        gateway_id: null,
        gateway_url: "",
        shared: false,
        native_trust_required: false,
      },
      {
        id: ATTENTION_DEVSERVER_ID,
        url: "http://127.0.0.1:9003",
        host: "127.0.0.1",
        port: 9003,
        label: "linux-tunnel",
        script: "ssh linux-tunnel -L 9003:localhost:8787 chan devserver join",
        has_token: false,
        token: "",
        library_id: LINUX_LIBRARY_ID,
        // The attention scenario: it connected once (so the OS is known),
        // then the tunnel dropped and the control script died. No workspaces.
        status: "disconnected",
        pending_signin: false,
        auto_hide_control: false,
        os: "linux",
        pretty_name: "Debian GNU/Linux 13",
        gateway_id: null,
        gateway_url: "",
        shared: false,
        native_trust_required: false,
      },
    ],
    // One sample gateway so the Gateways screen has a badge to render in the
    // demo embed. Connected with a quiet roster; the demo mints no roster rows.
    gateways: [
      {
        id: "gw-demo1a2b",
        url: "https://gw.chan.app",
        label: "chan.app",
        enabled: true,
        status: "connected",
        pending_signin: false,
        devserver_count: 1,
        last_error: null,
      },
    ],
    devserverWorkspaces: [
      {
        workspace_id: "ds-lima:w/linux",
        path: "/home/hacker.guest/dev/github.com/torvals/linux",
        label: "",
        on: true,
        status: "running",
        library_id: LIMA_LIBRARY_ID,
        devserver_id: "ds-lima",
        prefix: "w/linux",
      },
      {
        workspace_id: "ds-lima:w/systemd",
        path: "/home/hacker.guest/dev/github.com/systemd/systemd",
        label: "",
        on: true,
        status: "running",
        library_id: LIMA_LIBRARY_ID,
        devserver_id: "ds-lima",
        prefix: "w/systemd",
      },
      {
        workspace_id: "ds-windows:w/explorerpatcher",
        path: "C:\\Users\\hacker\\dev\\github.com\\valinet\\ExplorerPatcher",
        label: "ExplorerPatcher",
        on: false,
        status: "stopped",
        library_id: WINDOWS_LIBRARY_ID,
        devserver_id: "ds-windows",
        prefix: "w/explorerpatcher",
      },
    ],
    windows: [
      terminal("w-local-term-1", "local", "Terminal Window 1", 1, "t/local-1", true),
      terminal("w-local-term-2", "local", "Terminal Window 2", 2, "t/local-2", true),
      workspaceWindow("w-secret-1", "local", "secret Window 1", 1, "/Users/hacker/dev/my-secret-project", "w/secret", true),
      workspaceWindow("w-secret-2", "local", "secret Window 2", 2, "/Users/hacker/dev/my-secret-project", "w/secret-2", false),
      // Auto-hidden after lima's successful connect (connected:false seeds it hidden).
      terminal("w-lima-control", LIMA_LIBRARY_ID, "Control terminal", 0, "control/lima", false, true),
      terminal("w-windows-control", WINDOWS_LIBRARY_ID, "Control terminal", 0, "t/windows-control", true, true),
      // linux-tunnel's DEAD control row: the script exited, so the webview is
      // gone (connected:false) but the row stays VISIBLE to flash for
      // attention, overriding the factory's hidden = !connected coupling.
      { ...terminal("control-terminal-ds-linux", LINUX_LIBRARY_ID, "Control terminal", 0, "control/linux", false, true), hidden: false },
    ],
    liveTerminals: [["ds-lima:w/systemd", 2]],
  };
}

// The manual's first-run mock: just the local machine, nothing created yet, so
// the reader performs the New-terminal / New-workspace steps themselves.
function emptySeed(): Seed {
  return {
    nextWs: 1,
    nextDs: 1,
    workspaces: [],
    devservers: [],
    devserverWorkspaces: [],
    gateways: [],
    windows: [],
    liveTerminals: [],
  };
}

function terminal(
  window_id: string,
  library_id: string,
  title: string,
  ordinal: number,
  prefix: string,
  connected: boolean,
  control = false,
): WindowRecord {
  return {
    window_id,
    library_id,
    kind: "terminal",
    title: `${library_id === "local" ? "🏠" : "🌐"} ${title}`,
    ordinal,
    workspace_path: null,
    prefix,
    token: "tok_demo",
    persisted: true,
    connected,
    active_transfer: false,
    control,
    hidden: !connected,
  };
}

function workspaceWindow(
  window_id: string,
  library_id: string,
  title: string,
  ordinal: number,
  workspace_path: string,
  prefix: string,
  connected: boolean,
): WindowRecord {
  return {
    window_id,
    library_id,
    kind: "workspace",
    title: `${library_id === "local" ? "🏠" : "🌐"} ${title}`,
    ordinal,
    workspace_path,
    prefix,
    token: "tok_demo",
    persisted: true,
    connected,
    active_transfer: false,
    control: false,
    hidden: !connected,
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function publicDevserver(ds: DemoDevserver): DevserverEntry {
  const { token: _token, ...pub } = ds;
  return { ...pub };
}

function tick<T>(value: T): Promise<T> {
  return Promise.resolve(value);
}

export type LauncherDemoVariant = "populated" | "empty" | "devserver";

export type LauncherDemoOptions = {
  /// Fired whenever the demo opens/focuses a window row. The marketing embed
  /// hooks this to open the frontend-only workspace demo overlay; the demo
  /// state change (hidden/connected) still happens either way.
  onOpenWindow?: (id: string) => void;
  /// "populated" is the home hero's library fixture; "empty" is the manual's
  /// first-run mock (local machine only, nothing created yet); "devserver" is
  /// the same empty seed with the Add-devserver dialog opened on mount.
  variant?: LauncherDemoVariant;
};

export function createLauncherDemoApi(opts: LauncherDemoOptions = {}): LauncherDemoApi {
  let workspaces: WorkspaceEntry[] = [];
  let devservers: DemoDevserver[] = [];
  let devserverWorkspaces: WorkspaceEntry[] = [];
  let gateways: GatewayEntry[] = [];
  let windows: WindowRecord[] = [];
  let liveTerminals = new Map<string, number>();
  let nextWs = 1;
  let nextDs = 1;
  let nextGw = 1;
  const subscribers = new Set<(set: WindowSet) => void>();

  const startsEmpty = opts.variant === "empty" || opts.variant === "devserver";

  function reset(): void {
    const s = startsEmpty ? emptySeed() : seed();
    workspaces = clone(s.workspaces);
    devservers = clone(s.devservers);
    devserverWorkspaces = clone(s.devserverWorkspaces);
    gateways = clone(s.gateways);
    windows = clone(s.windows);
    liveTerminals = new Map(s.liveTerminals);
    nextWs = s.nextWs;
    nextDs = s.nextDs;
    nextGw = 1;
    notify();
  }

  function notify(): void {
    const set = { windows: windows.map((w) => ({ ...w })) };
    for (const fn of subscribers) fn(set);
  }

  function mergedWorkspaces(): WorkspaceEntry[] {
    const connectedIds = new Set(devservers.filter((d) => d.status === "connected").map((d) => d.id));
    return [
      ...workspaces,
      ...devserverWorkspaces.filter((w) => w.devserver_id && connectedIds.has(w.devserver_id)),
    ].map((w) => ({ ...w }));
  }

  function discardWorkspaceWindows(path: string, libraryId = "local"): void {
    for (let i = windows.length - 1; i >= 0; i--) {
      const w = windows[i]!;
      if (w.library_id === libraryId && w.kind === "workspace" && w.workspace_path === path) {
        windows.splice(i, 1);
      }
    }
  }

  reset();

  return {
    attentionDevserverId: startsEmpty ? null : ATTENTION_DEVSERVER_ID,
    reset,
    listWorkspaces: () => tick(mergedWorkspaces()),
    addLocalWorkspace: (path, label) => {
      const workspace_id = `ws-demo-${nextWs++}`;
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
      notify();
      return tick({ ...entry });
    },
    setWorkspaceOn: (id, on, force) => {
      const ws = workspaces.find((w) => w.workspace_id === id);
      const liveKey = `local:${id}`;
      if (!on && !force && liveTerminals.has(liveKey)) {
        return Promise.reject(new ApiError(409, JSON.stringify({ error: "live_terminals", active_terminals: liveTerminals.get(liveKey) })));
      }
      if (ws) {
        ws.on = on;
        ws.status = on ? "running" : "stopped";
        if (!on) discardWorkspaceWindows(ws.path);
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
    addDevserver: (input: DevserverInput) => {
      const ds: DemoDevserver = {
        id: `ds-demo-${nextDs++}`,
        url: input.url ?? `http://${input.host}:${input.port}`,
        host: input.host,
        port: input.port,
        label: input.label ?? "",
        script: input.script ?? "",
        has_token: !!input.token,
        token: input.token ?? "",
        library_id: null,
        status: "disconnected",
        pending_signin: false,
        auto_hide_control: input.auto_hide_control ?? false,
        os: "",
        pretty_name: null,
        gateway_id: null,
        gateway_url: "",
        shared: false,
        native_trust_required: false,
      };
      devservers.push(ds);
      notify();
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
      if (input.token) {
        ds.token = input.token;
        ds.has_token = true;
      } else if (input.clear_token) {
        ds.token = "";
        ds.has_token = false;
      }
      notify();
      return tick(publicDevserver(ds));
    },
    removeDevserver: (id) => {
      const ds = devservers.find((d) => d.id === id);
      if (ds?.library_id) windows = windows.filter((w) => w.library_id !== ds.library_id);
      devserverWorkspaces = devserverWorkspaces.filter((w) => w.devserver_id !== id);
      devservers = devservers.filter((d) => d.id !== id);
      notify();
      return tick(undefined);
    },
    connectDevserver: (id) => {
      const ds = devservers.find((d) => d.id === id);
      if (ds) {
        ds.status = "connected";
        if (!ds.library_id) ds.library_id = `lib-demo-${id}`;
        for (const w of windows) if (w.library_id === ds.library_id) w.connected = true;
        notify();
      }
      return tick(undefined);
    },
    disconnectDevserver: (id) => {
      const ds = devservers.find((d) => d.id === id);
      if (ds) {
        ds.status = "disconnected";
        if (ds.library_id) {
          windows = windows.filter((w) => {
            if (w.library_id !== ds.library_id) return true;
            if (w.control) return false;
            w.connected = false;
            return true;
          });
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
        const ordinal = windows.filter((w) => w.library_id === ds.library_id && w.kind === "terminal" && !w.control).length + 1;
        windows.push(terminal(`w-${id}-term-${windows.length + 1}`, ds.library_id, `Terminal Window ${ordinal}`, ordinal, `t/${id}-${ordinal}`, true));
        notify();
      }
      return tick(undefined);
    },
    openDevserverWorkspace: (id, path) => {
      const ds = devservers.find((d) => d.id === id);
      if (ds?.library_id) {
        const base = path.split("/").filter(Boolean).pop() ?? "workspace";
        const ordinal = windows.filter((w) => w.library_id === ds.library_id && w.kind === "workspace" && w.workspace_path === path).length + 1;
        windows.push(workspaceWindow(`w-${id}-ws-${windows.length + 1}`, ds.library_id, `${base} Window ${ordinal}`, ordinal, path, `w/${base}-${ordinal}`, true));
        notify();
      }
      return tick(undefined);
    },
    setDevserverWorkspaceOn: (id, prefix, on, force) => {
      const ws = devserverWorkspaces.find((w) => w.devserver_id === id && w.prefix === prefix);
      const key = `${id}:${prefix}`;
      if (!on && !force && liveTerminals.has(key)) {
        return Promise.reject(new ApiError(409, JSON.stringify({ error: "live_terminals", active_terminals: liveTerminals.get(key) })));
      }
      if (ws) {
        ws.on = on;
        ws.status = on ? "running" : "stopped";
        if (!on) discardWorkspaceWindows(ws.path, ws.library_id ?? "");
      }
      liveTerminals.delete(key);
      notify();
      return tick(undefined);
    },
    forgetDevserverWorkspace: (id, prefix, _force) => {
      const i = devserverWorkspaces.findIndex((w) => w.devserver_id === id && w.prefix === prefix);
      if (i >= 0) {
        const ws = devserverWorkspaces[i]!;
        discardWorkspaceWindows(ws.path, ws.library_id ?? "");
        devserverWorkspaces.splice(i, 1);
        notify();
      }
      return tick(undefined);
    },
    listGateways: () => tick(gateways.map((g) => ({ ...g }))),
    addGateway: (input: GatewayInput) => {
      const gw: GatewayEntry = {
        id: `gw-demo-${nextGw++}`,
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
    // Rename only, like the mock: the URL is identity and never changes.
    updateGateway: (id, input) => {
      const gw = gateways.find((g) => g.id === id);
      if (!gw) throw new Error(`unknown gateway ${id}`);
      gw.label = (input.label ?? "").trim();
      notify();
      return tick({ ...gw });
    },
    removeGateway: (id) => {
      gateways = gateways.filter((g) => g.id !== id);
      notify();
      return tick(undefined);
    },
    // No desktop to discover/sign in through: connect/disconnect just flip the
    // badge state, like the demo devservers.
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
    // The empty variants' Browse... fills a path matching the manual's
    // `chan serve ./your-project` walkthrough.
    pickFolder: () => tick(startsEmpty ? "/Users/you/dev/your-project" : "/Users/hacker/demo-reset"),
    listWindows: () => tick(windows.map((w) => ({ ...w }))),
    createWindow: (kind, opts) => {
      const workspacePath = opts?.workspacePath;
      const ordinal = windows.filter((w) => w.library_id === "local" && w.kind === kind && (kind === "terminal" || w.workspace_path === workspacePath)).length + 1;
      const base = workspacePath ? workspacePath.split("/").filter(Boolean).pop() ?? "workspace" : "local";
      const rec = kind === "terminal"
        ? terminal(`w-local-term-${windows.length + 1}`, "local", `Terminal Window ${ordinal}`, ordinal, `t/local-${windows.length + 1}`, true)
        : workspaceWindow(`w-local-ws-${windows.length + 1}`, "local", `${base} Window ${ordinal}`, ordinal, workspacePath ?? "/Users/hacker/demo", `w/${base}-${ordinal}`, true);
      windows.push(rec);
      notify();
      return tick({ ...rec });
    },
    openWindow: (id) => {
      const w = windows.find((x) => x.window_id === id);
      if (w) {
        w.hidden = false;
        w.connected = true;
      }
      notify();
      opts.onOpenWindow?.(id);
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
      windows = windows.filter((w) => w.window_id !== id);
      notify();
      return tick(undefined);
    },
    // Web-op close/visibility for the widened LibraryApi. The demo embed's
    // window manager is inert (see state/demo guard), so these are called only
    // via the interface; discard drops the record, visibility mirrors open/hide.
    discardWindow: (id) => {
      windows = windows.filter((w) => w.window_id !== id);
      notify();
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
      onSet({ windows: windows.map((w) => ({ ...w })) });
      return () => subscribers.delete(onSet);
    },
  };
}
