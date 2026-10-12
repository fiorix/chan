// Installed before the app. Retain only terminal identity and geometry, never
// the socket URL, spawn environment, input bytes or authentication fields.
export function installSizeObserver() {
  const NativeSocket = window.WebSocket;
  const sockets = new Map();
  const records = [];
  let ordinal = 0;
  let overflow = false;
  const grid = (cols, rows) => Number.isInteger(cols) && cols > 0 && Number.isInteger(rows) && rows > 0
    ? { cols, rows } : null;
  const box = (element) => {
    if (!element) return null;
    const value = element.getBoundingClientRect();
    return { x: value.x, y: value.y, width: value.width, height: value.height };
  };
  const view = (entry) => {
    const tab = document.querySelector(`[data-terminal-tab-id="${CSS.escape(entry.tab)}"]`);
    const pane = tab?.closest(".pane");
    const host = tab?.querySelector(".terminal-host");
    const screen = host?.querySelector(".xterm-screen") ?? host?.querySelector("canvas");
    const viewport = host?.querySelector(".xterm-viewport");
    const style = host ? getComputedStyle(host) : null;
    const padding = style ? {
      left: parseFloat(style.paddingLeft), right: parseFloat(style.paddingRight),
      top: parseFloat(style.paddingTop), bottom: parseFloat(style.paddingBottom),
    } : null;
    return {
      socket: entry.socket, name: entry.name, tab: entry.tab, session: entry.session,
      pane: pane?.getAttribute("data-pane-id") ?? null,
      connected: entry.peer.readyState === NativeSocket.OPEN,
      visible: !!host && tab.classList.contains("active") && style.visibility === "visible" && host.clientWidth > 0 && host.clientHeight > 0,
      backend: host?.querySelector(".xterm-screen") ? "xterm" : screen ? "ghostty" : null,
      grid: entry.grid, paneBox: box(pane), hostBox: box(host), screenBox: box(screen),
      hostWidth: host?.clientWidth ?? 0, hostHeight: host?.clientHeight ?? 0, padding,
      scrollbar: viewport ? viewport.offsetWidth - viewport.clientWidth : 0,
    };
  };
  const append = (record) => {
    if (records.length >= 100_000) { overflow = true; return; }
    records.push({ pageMs: performance.now(), ...record });
  };
  window.WebSocket = class extends NativeSocket {
    constructor(url, protocols) {
      super(url, protocols);
      const parsed = new URL(url, location.href);
      if (parsed.pathname !== "/api/terminal/ws") return;
      const query = parsed.searchParams;
      const entry = { peer: this, socket: ++ordinal, name: query.get("tab_name"),
        tab: query.get("tab_id"), session: query.get("session"),
        grid: grid(Number(query.get("cols")), Number(query.get("rows"))) };
      sockets.set(this, entry);
      append({ kind: "attach", view: view(entry) });
      this.addEventListener("message", ({ data }) => {
        if (typeof data !== "string") return;
        let frame;
        try { frame = JSON.parse(data); } catch { return; }
        if (frame.type === "session") entry.session = frame.id;
      });
      this.addEventListener("close", () => {
        append({ kind: "close", view: view(entry) });
        sockets.delete(this);
      });
    }
    send(data) {
      // Read after native send accepted the frame. This adds a layout read,
      // but never changes a frame or calls any fitter or resize method.
      super.send(data);
      const entry = sockets.get(this);
      if (!entry || typeof data !== "string") return;
      let frame;
      try { frame = JSON.parse(data); } catch { return; }
      if (frame.type !== "resize") return;
      entry.grid = grid(frame.cols, frame.rows);
      append({ kind: "resize", view: view(entry) });
    }
  };
  const timer = setInterval(() => {
    append({ kind: "sample", views: [...sockets.values()].map(view) });
  }, 50);
  window.__terminalSizeObserver = {
    drain() { return { records: records.splice(0), overflow }; },
    snapshot() { return [...sockets.values()].map(view); },
    stop() { clearInterval(timer); },
  };
}
