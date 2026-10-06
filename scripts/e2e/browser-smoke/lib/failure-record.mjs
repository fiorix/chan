import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { maskTokens } from "./token-mask.mjs";

const MAX_EVENTS = 4000;
const MAX_TEXT = 1000;
const SLOW_REQUEST_MS = 5000;
const RESOURCE_FILES = [
  "cpu.max", "cpu.stat", "cpu.pressure", "memory.max", "memory.current",
  "memory.events", "memory.pressure", "io.pressure",
];

function safeText(value) {
  return maskTokens(value).slice(0, MAX_TEXT);
}

export function resourceSample(root = process.env.SMOKE_CGROUP_ROOT || "/sys/fs/cgroup") {
  const files = {};
  for (const name of RESOURCE_FILES) {
    try {
      files[name] = readFileSync(join(root, name), "utf8").trim();
    } catch (error) {
      files[name] = `unavailable: ${error.code ?? error.message}`;
    }
  }
  return { root, files };
}

export class FailureRecord {
  constructor(name, outDir, clock = Date.now, sample = resourceSample) {
    this.name = name;
    this.outDir = outDir;
    this.clock = clock;
    this.sample = sample;
    this.events = [];
    this.pages = new Map();
    this.dropped = 0;
    this.timer = null;
    this.mark("check:start");
  }

  mark(type, data = {}) {
    if (this.events.length === MAX_EVENTS) {
      // Keep the start and the newest evidence even when a noisy socket
      // produces more frames than the bounded record can hold.
      const discard = MAX_EVENTS / 2;
      this.events.splice(1, discard);
      this.dropped += discard;
    }
    this.events.push({ at: new Date(this.clock()).toISOString(), type, ...data });
  }

  startResources() {
    const take = () => {
      try {
        this.mark("guest:resources", this.sample());
      } catch (error) {
        this.mark("guest:resources-error", { error: safeText(error.message) });
      }
    };
    take();
    this.timer = setInterval(take, 1000);
    this.timer.unref();
  }

  stopResources() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async observePage(page, label = `page-${this.pages.size + 1}`) {
    if (this.pages.has(page)) return;
    const record = { label, requests: new Map(), sockets: new Map() };
    this.pages.set(page, record);
    this.mark("page:open", { page: label });
    page.on("console", (message) => {
      if (["warn", "warning", "error"].includes(message.type())) {
        this.mark("page:console", { page: label, level: message.type(), text: safeText(message.text()) });
      }
    });
    page.on("pageerror", (error) => {
      this.mark("page:error", { page: label, error: safeText(error.stack ?? error.message) });
    });
    page.on("request", (request) => {
      if (request.resourceType?.() === "websocket") return;
      record.requests.set(request, { at: this.clock(), method: request.method(), url: safeText(request.url()) });
    });
    page.on("response", (response) => {
      const request = response.request();
      const pending = record.requests.get(request);
      if (pending) pending.status = response.status();
      if (response.status() >= 400) {
        this.mark("page:http-error", { page: label, method: request.method(), url: safeText(request.url()), status: response.status() });
      }
    });
    const finished = (request, failure) => {
      const pending = record.requests.get(request);
      if (!pending) return;
      record.requests.delete(request);
      const durationMs = this.clock() - pending.at;
      const url = new URL(pending.url);
      if (url.pathname === "/api/fs" && url.searchParams.has("dir")) {
        this.mark("page:listing", { page: label, ...pending, durationMs, failure: failure ? safeText(failure) : null });
      }
      if (durationMs >= SLOW_REQUEST_MS || failure) {
        this.mark("page:request", { page: label, ...pending, durationMs, failure: failure ? safeText(failure) : null });
      }
    };
    page.on("requestfinished", (request) => finished(request, null));
    page.on("requestfailed", (request) => finished(request, request.failure()?.errorText ?? "unknown"));

    try {
      const session = await page.createCDPSession();
      session.on("Network.webSocketCreated", ({ requestId, url }) => {
        record.sockets.set(requestId, { url: safeText(url), state: "created" });
        this.mark("socket:create", { page: label, requestId, url: safeText(url) });
      });
      session.on("Network.webSocketHandshakeResponseReceived", ({ requestId, response }) => {
        const socket = record.sockets.get(requestId);
        if (socket) socket.state = `open:${response.status}`;
        this.mark("socket:open", { page: label, requestId, status: response.status });
      });
      session.on("Network.webSocketFrameReceived", ({ requestId, response }) => {
        let frame = null;
        try { frame = JSON.parse(response.payloadData); } catch {}
        this.mark("socket:frame", {
          page: label, requestId, frameType: safeText(frame?.type ?? "non-json"),
          frameKind: frame?.kind ? safeText(frame.kind) : null,
          eventKind: frame?.event?.kind ? safeText(frame.event.kind) : null,
          eventPath: typeof frame?.event?.path === "string" ? safeText(frame.event.path) : null,
          eventIsDir: frame?.event?.is_dir === true,
          path: frame?.path ? safeText(frame.path) : null,
          dir: frame?.dir ? safeText(frame.dir) : null,
          windowId: frame?.window_id || frame?.w ? safeText(frame.window_id ?? frame.w) : null,
        });
      });
      session.on("Network.webSocketClosed", ({ requestId }) => {
        const socket = record.sockets.get(requestId);
        if (socket) socket.state = "closed";
        this.mark("socket:close", { page: label, requestId });
      });
      await session.send("Network.enable");
    } catch (error) {
      this.mark("page:cdp-unavailable", { page: label, error: safeText(error.message) });
    }
  }

  pending() {
    return [...this.pages.values()].map(({ label, requests, sockets }) => ({
      page: label,
      requests: [...requests.values()].map((request) => ({ ...request, ageMs: this.clock() - request.at })),
      sockets: [...sockets.entries()].map(([id, value]) => ({ id, ...value })),
    }));
  }

  write() {
    this.stopResources();
    this.mark("check:end");
    const path = join(this.outDir, `${this.name}.timeline.json`);
    writeFileSync(path, JSON.stringify(
      { name: this.name, events: this.events, pending: this.pending(), dropped: this.dropped },
      (_key, value) => typeof value === "string" ? maskTokens(value) : value,
      2,
    ));
    return path;
  }
}
