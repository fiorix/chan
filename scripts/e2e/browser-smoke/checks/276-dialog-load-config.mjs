// Load and Bootstrap a hand-edited team through the real dialog, then read
// the file on disk. Edited Load and New exercise the ordinary save path.

import { createHash } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { closeEveryTerminal, dispatchCommand } from "../lib/pane-strip.mjs";
import { maskTokens } from "../lib/token-mask.mjs";

const DIR_INPUT = '.team-dialog input[list="team-dir-suggestions"]';
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

async function startFocusTrace(page) {
  await page.evaluate(() => {
    if (window.__dialogload276Focus) throw new Error("dialogload focus recorder already installed");
    const trace = { events: [], dropped: 0 };
    const describe = (node) => node instanceof Element ? {
      tag: node.tagName,
      id: node.id,
      className: node.getAttribute("class") ?? "",
      tab: node.closest("[data-terminal-tab-id]")?.getAttribute("data-terminal-tab-id") ?? null,
    } : null;
    const record = (event) => {
      if (trace.events.length >= 256) { trace.dropped++; return; }
      trace.events.push({ type: event.type, at: performance.now(), target: describe(event.target), related: describe(event.relatedTarget) });
    };
    document.addEventListener("focusin", record, true);
    document.addEventListener("focusout", record, true);
    record({ type: "start", target: document.activeElement });
    window.__dialogload276Focus = {
      stop() {
        document.removeEventListener("focusin", record, true);
        document.removeEventListener("focusout", record, true);
        delete window.__dialogload276Focus;
        return trace;
      },
    };
  });
}

// Keep only identity and readiness metadata, never socket URLs or payloads.
async function watchLeadSocket(page, windowId) {
  const cdp = await page.createCDPSession();
  const sockets = new Map();
  let overflow = false;
  let changed = () => {};
  cdp.on("Network.webSocketCreated", ({ requestId, url }) => {
    const parsed = new URL(url);
    if (!parsed.pathname.endsWith("/api/terminal/ws") || parsed.searchParams.get("window_id") !== windowId) return;
    if (sockets.size >= 16) { overflow = true; changed(); return; }
    sockets.set(requestId, { tab: parsed.searchParams.get("tab_id"), session: null, ready: false, closed: false });
    changed();
  });
  cdp.on("Network.webSocketFrameReceived", ({ requestId, response }) => {
    const socket = sockets.get(requestId);
    if (!socket || response.opcode !== 1) return;
    let frame;
    try { frame = JSON.parse(response.payloadData); } catch { return; }
    if (frame.type === "session") { socket.session = frame.id; socket.ready = false; }
    if (frame.type === "ready") socket.ready = typeof socket.session === "string" && socket.session.length > 0;
    changed();
  });
  cdp.on("Network.webSocketClosed", ({ requestId }) => {
    const socket = sockets.get(requestId);
    if (socket) socket.closed = true;
    changed();
  });
  try { await cdp.send("Network.enable"); } catch (error) { await cdp.detach(); throw error; }
  return {
    snapshot: () => ({ overflow, sockets: [...sockets.values()] }),
    close: () => cdp.detach(),
    wait(tab, oldSessions, timeout) {
      return new Promise((resolve, reject) => {
        const finish = (error, socket) => {
          clearTimeout(timer);
          changed = () => {};
          if (error) reject(new Error(error)); else resolve({ ...socket });
        };
        const timer = setTimeout(() => finish("created lead did not receive session and ready frames"), timeout);
        changed = () => {
          const matches = [...sockets.values()].filter((socket) => socket.tab === tab);
          if (overflow || matches.length > 1) return finish("created lead socket identity is ambiguous");
          const socket = matches[0];
          if (socket?.closed) return finish("created lead socket closed before readiness");
          if (socket?.session && oldSessions.includes(socket.session)) return finish("created lead reused an existing session");
          if (socket?.ready) finish(null, socket);
        };
        changed();
      });
    },
  };
}

async function settleLead(page, api, windowId, before, watcher) {
  const deadline = Date.now() + 30_000;
  const remaining = () => {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error("created lead readiness deadline expired");
    return left;
  };
  const handle = await page.waitForFunction((oldTabs) => {
    const created = [...document.querySelectorAll(".terminal-tab")].filter((node) => !oldTabs.includes(node.getAttribute("data-terminal-tab-id")));
    if (created.length > 1) throw new Error("created lead tab identity is ambiguous");
    const node = created[0];
    if (!node?.classList.contains("active")) return false;
    const renderer = node.querySelector(".terminal-host canvas, .terminal.xterm .xterm-screen");
    const box = renderer?.getBoundingClientRect();
    if (!box || box.width <= 0 || box.height <= 0) return false;
    const tab = node.getAttribute("data-terminal-tab-id");
    return tab ? { tab, renderer: renderer.tagName, width: box.width, height: box.height } : false;
  }, { timeout: remaining() }, before.tabs);
  const renderer = await handle.jsonValue();
  await handle.dispose();
  const socket = await watcher.wait(renderer.tab, before.sessions, remaining());
  const roster = await api("/api/terminals/roster", undefined, "GET", remaining());
  const created = roster.sessions.filter((session) => session.window_id === windowId && !before.sessions.includes(session.id));
  if (created.length !== 1 || created[0].id !== socket.session) throw new Error("created lead session delta disagrees with its socket");
  // Initialization queues a focus microtask and Ghostty queues a zero-delay
  // retry. Cross a timer task after readiness; elapsed time is not the test.
  let timer;
  try {
    await Promise.race([
      page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0))),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("created lead timer barrier timed out")), remaining()); }),
    ]);
  } finally { clearTimeout(timer); }
  const confirmed = await watcher.wait(renderer.tab, before.sessions, remaining());
  if (confirmed.session !== socket.session) throw new Error("created lead session changed during readiness");
  return { ...renderer, session: socket.session, ready: socket.ready };
}

async function mode(page, name) {
  for (const button of await page.$$(".team-dialog .team-realestate-mode")) {
    if (await button.evaluate((node, expected) => node.textContent?.trim() === expected, name)) {
      await button.click();
      return;
    }
  }
  throw new Error(`team mode ${name} is absent`);
}

async function input(page, selector, value) {
  await page.click(selector, { count: 3 });
  const selected = await page.$eval(selector, (node) => ({
    value: node.value,
    selectionStart: node.selectionStart,
    selectionEnd: node.selectionEnd,
    focused: document.activeElement === node,
  }));
  if (!selected.focused) throw new Error(`team input ${selector}: focus lost before Backspace`);
  if (selected.selectionStart !== 0 || selected.selectionEnd !== selected.value.length) {
    throw new Error(`team input ${selector}: full selection failed (${selected.selectionStart}:${selected.selectionEnd}/${selected.value.length})`);
  }
  await page.keyboard.press("Backspace");
  const cleared = await page.$eval(selector, (node) => ({ value: node.value, focused: document.activeElement === node }));
  if (cleared.value !== "") throw new Error(`team input ${selector}: Backspace left ${JSON.stringify(cleared.value)}`);
  if (!cleared.focused) throw new Error(`team input ${selector}: focus lost before typing`);
  await page.keyboard.type(value);
  const typed = await page.$eval(selector, (node) => node.value);
  if (typed !== value) throw new Error(`team input ${selector}: typed value ${JSON.stringify(typed)}, expected ${JSON.stringify(value)}`);
  await page.keyboard.press("Tab");
}

export default {
  name: "dialog-load-config",
  async run(ctx) {
    const { page } = ctx;
    const token = new URL(ctx.serverUrl).searchParams.get("t") ?? "";
    const windowId = await page.evaluate(() => new URL(location.href).searchParams.get("w") || sessionStorage.getItem("chan.session.window"));
    if (!windowId) throw new Error("dialogload page has no window id");
    const report = { legs: [], pageErrors: [], cleanupErrors: [] };
    const save = () => writeFileSync(join(ctx.outDir, "276-dialog-load-config.json"), JSON.stringify(report, null, 2));
    const pageError = (error) => report.pageErrors.push(maskTokens(error?.stack ?? String(error)));
    page.on("pageerror", pageError);
    const api = async (path, body, method = "POST", timeout = 20_000) => {
      const url = new URL(path, ctx.serverUrl);
      const response = await fetch(url, {
        method,
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeout),
      });
      if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
      const text = await response.text();
      return text ? JSON.parse(text) : {};
    };

    try {
      for (const kind of ["unchanged", "edited", "new"]) {
        const dir = `dialog-load-276-${kind}-${Date.now().toString(36)}`;
        const leg = { kind, dir, passed: false, error: null };
        report.legs.push(leg);
        const requests = [];
        const onRequest = (request) => {
          if (request.method() === "POST" && new URL(request.url()).pathname.endsWith("/api/team-config/write")) {
            requests.push(JSON.parse(request.postData()));
          }
        };
        page.on("request", onRequest);
        let watcher;
        let tracing = false;
        try {
          await api("/api/team-config/write", {
            dir,
            config: {
              team_name: "Hand written name",
              host_name: "Saved host",
              host_handle: "@@SavedHost",
              tab_group: dir,
              auto_prefix_at: true,
              mcp_env: false,
              created_at: "2026-01-01T00:00:00Z",
              members: [{ handle: `@@${dir}`, command: "bash --noprofile --norc", env: {}, is_lead: true }],
            },
            brief_content: "Keep this brief.",
          });
          const configPath = join(ctx.workspaceDir, dir, "config.toml");
          const generated = readFileSync(configPath, "utf8");
          const lines = generated.split("\n");
          const teamName = lines.findIndex((line) => line.startsWith("team_name = "));
          if (teamName < 0) throw new Error("generated config lacks team_name");
          const [nameLine] = lines.splice(teamName, 1);
          const host = lines.findIndex((line) => line.startsWith("host_handle = "));
          if (host < 0) throw new Error("generated config lacks host_handle");
          lines.splice(host + 1, 0, nameLine);
          // Derive the fixture from this server's serializer, then hand-edit
          // the first key, its order and an unmodelled root key.
          const before = `# Keep this hand edit.\ncustom_note = "not a modeled field"\n${lines.join("\n")}`;
          writeFileSync(configPath, before);
          await api("/api/team-config/read", { dir });
          const bootstrapPath = join(ctx.workspaceDir, dir, "bootstrap.md");
          const bootstrapBefore = readFileSync(bootstrapPath, "utf8");
          writeFileSync(join(ctx.outDir, `276-${kind}-before.toml`), before);

          leg.leadBefore = {
            tabs: await page.$$eval(".terminal-tab", (nodes) => nodes.map((node) => node.getAttribute("data-terminal-tab-id"))),
            sessions: (await api("/api/terminals/roster", undefined, "GET")).sessions.filter((session) => session.window_id === windowId).map((session) => session.id),
          };
          watcher = await watchLeadSocket(page, windowId);
          await startFocusTrace(page);
          tracing = true;
          await dispatchCommand(page, "app.terminal.teamWork");
          await page.waitForSelector(".team-dialog", { timeout: 15_000 });
          leg.leadReady = await settleLead(page, api, windowId, leg.leadBefore, watcher);
          await mode(page, "Load");
          await input(page, DIR_INPUT, dir);
          await page.waitForFunction((expected) => {
            const found = document.querySelector(".team-load-file")?.textContent?.trim();
            return found === `${expected}/config.toml` && !document.querySelector(".team-dialog-bootstrap")?.disabled;
          }, { timeout: 15_000 }, dir);
          if (kind === "edited") {
            await input(page, '.team-dialog input[placeholder="Neo"]', "Edited host");
          } else if (kind === "new") {
            await mode(page, "New");
          }
          await ctx.shot(`276-${kind}-before-bootstrap`);
          await page.click(".team-dialog-bootstrap");
          await page.waitForSelector(".team-dialog", { hidden: true, timeout: 30_000 });
          await ctx.shot(`276-${kind}-after-bootstrap`);

          const after = readFileSync(configPath, "utf8");
          const saved = await api("/api/team-config/read", { dir });
          writeFileSync(join(ctx.outDir, `276-${kind}-after.toml`), after);
          leg.beforeSha256 = sha256(before);
          leg.afterSha256 = sha256(after);
          leg.requests = requests.map((request) => ({ dir: request.dir, keep_config: request.keep_config ?? false, keep_bootstrap: request.keep_bootstrap ?? false }));
          leg.savedHost = saved.host_name;
          leg.bootstrapKept = readFileSync(bootstrapPath, "utf8") === bootstrapBefore;
          if (requests.length !== 1) throw new Error(`expected one dialog write, read ${requests.length}`);
          if (requests[0].dir !== dir) throw new Error(`dialog write dir=${JSON.stringify(requests[0].dir)}, expected ${JSON.stringify(dir)}`);
          const preserve = kind === "unchanged";
          if (preserve && after !== before) throw new Error("unchanged Load rewrote config.toml bytes");
          if (Boolean(requests[0].keep_config) !== preserve) throw new Error(`keep_config=${Boolean(requests[0].keep_config)}, expected ${preserve}`);
          if (Boolean(requests[0].keep_bootstrap) !== (kind !== "new")) throw new Error("bootstrap preservation request disagrees with mode");
          if (!preserve && (after === before || after.includes("custom_note") || after.includes("# Keep this hand edit."))) throw new Error(`${kind} did not replace the hand-edited config`);
          if (saved.host_name !== (kind === "edited" ? "Edited host" : "Saved host")) throw new Error("saved host differs from the dialog");
          if (leg.bootstrapKept !== (kind !== "new")) throw new Error("bootstrap file preservation disagrees with mode");
          leg.passed = true;
        } catch (error) {
          leg.error = maskTokens(error?.stack ?? String(error));
          try {
            const state = await page.evaluate((dirSelector) => {
              const describe = (node) => node ? {
                tag: node.tagName,
                id: node.id,
                className: node.getAttribute("class") ?? "",
                value: typeof node.value === "string" ? node.value : null,
                selectionStart: node.selectionStart ?? null,
                selectionEnd: node.selectionEnd ?? null,
              } : null;
              return {
                modeButtons: [...document.querySelectorAll(".team-dialog .team-realestate-mode")]
                  .map((button) => button.textContent?.trim() ?? ""),
                windowName: window.name,
                directoryInput: describe(document.querySelector(dirSelector)),
                activeElement: describe(document.activeElement),
                loadError: document.querySelector(".team-load-error")?.textContent?.trim() ?? "",
                resolvedPath: document.querySelector(".team-load-file")?.textContent?.trim() ?? "",
              };
            }, DIR_INPUT);
            const maskElement = (element) => element ? {
              ...element,
              tag: maskTokens(element.tag),
              id: maskTokens(element.id),
              className: maskTokens(element.className),
              value: element.value === null ? null : maskTokens(element.value),
            } : null;
            leg.failureState = {
              modeButtons: state.modeButtons.map((label) => maskTokens(label)),
              windowName: maskTokens(state.windowName),
              directoryInput: maskElement(state.directoryInput),
              activeElement: maskElement(state.activeElement),
              loadError: maskTokens(state.loadError),
              resolvedPath: maskTokens(state.resolvedPath),
            };
          } catch (evidenceError) {
            leg.failureStateError = maskTokens(evidenceError?.stack ?? String(evidenceError));
          }
          try {
            await ctx.shot(`276-${kind}-failure`);
          } catch (evidenceError) {
            leg.failureScreenshotError = maskTokens(evidenceError?.stack ?? String(evidenceError));
          }
        } finally {
          page.off("request", onRequest);
          if (tracing) {
            try {
              const trace = await page.evaluate(() => window.__dialogload276Focus.stop());
              leg.focusTrace = JSON.parse(JSON.stringify(trace, (_, value) => typeof value === "string" ? maskTokens(value) : value));
            } catch (error) {
              report.cleanupErrors.push(maskTokens(error?.stack ?? String(error)));
            }
          }
          if (watcher) {
            leg.leadSockets = watcher.snapshot();
            try { await watcher.close(); } catch (error) { report.cleanupErrors.push(maskTokens(error?.stack ?? String(error))); }
          }
          try {
            if (await page.$(".team-dialog")) {
              await page.click(".team-dialog-cancel");
              await page.waitForSelector(".team-dialog", { hidden: true, timeout: 15_000 });
            }
          } catch (error) {
            report.cleanupErrors.push(maskTokens(error?.stack ?? String(error)));
          }
          try {
            await closeEveryTerminal(page, `dialogload ${kind}`, token);
          } catch (error) {
            report.cleanupErrors.push(maskTokens(error?.stack ?? String(error)));
          }
          // A busy dialog can block UI cancellation. Reap only sessions
          // belonging to this check's window, independently of that UI.
          try {
            const roster = await api("/api/terminals/roster", undefined, "GET");
            for (const session of roster.sessions.filter((session) => session.window_id === windowId)) {
              await api(`/api/terminals/${encodeURIComponent(session.id)}`, undefined, "DELETE");
            }
            const remaining = await api("/api/terminals/roster", undefined, "GET");
            if (remaining.sessions.some((session) => session.window_id === windowId)) throw new Error("dialogload cleanup left sessions behind");
          } catch (error) {
            report.cleanupErrors.push(maskTokens(error?.stack ?? String(error)));
          }
          save();
        }
        if (report.cleanupErrors.length) break;
      }
    } finally {
      page.off("pageerror", pageError);
      for (const leg of report.legs) {
        try {
          rmSync(join(ctx.workspaceDir, leg.dir), { recursive: true, force: true });
          leg.directoryRemoved = true;
        } catch (error) {
          report.cleanupErrors.push(maskTokens(error?.stack ?? String(error)));
        }
      }
      save();
    }
    const failures = report.legs.filter((leg) => !leg.passed);
    if (report.legs.length !== 3 || failures.length || report.pageErrors.length || report.cleanupErrors.length) {
      throw new Error(`dialogload failed: ${failures.map((leg) => `${leg.kind}: ${leg.error}`).join("; ")}; page errors ${report.pageErrors.length}; cleanup errors ${report.cleanupErrors.length}`);
    }
  },
};
