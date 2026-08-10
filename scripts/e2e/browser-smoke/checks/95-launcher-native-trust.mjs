// Shared gateway-devserver native trust, driven through the built launcher SPA
// against a purpose-built HTTP backend. The backend rejects connect until PUT
// persisted trust, so the successful browser flow proves PUT -> re-list ->
// connect ordering rather than only checking the rendered controls.

import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

const DEVSERVER_ID = `gw:feedface:bob:${"d".repeat(64)}`;

function trustBackend(distRoot) {
  const events = [];
  const devserver = {
    id: DEVSERVER_ID,
    url: "https://bob--dddddddddddd.devserver.example.test",
    host: "bob--dddddddddddd.devserver.example.test",
    port: 443,
    label: "shared-lab",
    script: "",
    has_token: false,
    library_id: null,
    status: "disconnected",
    pending_signin: false,
    auto_hide_control: false,
    os: "linux",
    pretty_name: "Shared Linux host",
    gateway_id: "gw-feedface",
    gateway_url: "https://id.example.test",
    shared: true,
    native_trust_required: true,
  };
  const gateway = {
    id: "gw-feedface",
    url: "https://id.example.test",
    label: "example gateway",
    enabled: true,
    status: "connected",
    pending_signin: false,
    devserver_count: 1,
    last_error: null,
  };

  const json = (res, body, status = 200) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  const empty = (res, status = 204) => res.writeHead(status).end();

  const server = createServer((req, res) => {
    try {
      const url = new URL(req.url, "http://launcher.test");
      const { pathname } = url;
      if (req.method === "GET" && pathname === "/api/library/workspaces") {
        json(res, []);
        return;
      }
      if (req.method === "GET" && pathname === "/api/library/devservers") {
        json(res, [{ ...devserver }]);
        return;
      }
      if (req.method === "GET" && pathname === "/api/library/gateways") {
        json(res, [{ ...gateway }]);
        return;
      }
      if (req.method === "GET" && pathname === "/api/library/windows") {
        json(res, []);
        return;
      }
      if (req.method === "GET" && pathname === "/api/library/local-theme") {
        json(res, { theme: null });
        return;
      }
      if (req.method === "GET" && pathname === "/api/library/collapsed-machines") {
        json(res, { collapsed: [] });
        return;
      }
      if (pathname.endsWith("/native-trust") && req.method === "PUT") {
        events.push("PUT native-trust");
        devserver.native_trust_required = false;
        empty(res);
        return;
      }
      if (pathname.endsWith("/native-trust") && req.method === "DELETE") {
        events.push("DELETE native-trust");
        devserver.native_trust_required = true;
        devserver.status = "disconnected";
        empty(res);
        return;
      }
      if (pathname.endsWith("/connect") && req.method === "POST") {
        events.push("POST connect");
        if (devserver.native_trust_required) {
          res.writeHead(409, { "content-type": "text/plain" }).end("native_trust_required");
          return;
        }
        devserver.status = "connected";
        devserver.library_id = "lib-shared-lab";
        empty(res);
        return;
      }
      if (pathname.startsWith("/api/")) {
        res.writeHead(404).end("not found");
        return;
      }

      let rel = normalize(pathname).replace(/^([/\\])+/, "");
      if (rel.startsWith("..")) throw new Error("traversal");
      if (!rel) rel = "index.html";
      let file = join(distRoot, rel);
      if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
      if (!existsSync(file)) file = join(distRoot, "index.html");
      res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
      res.end(readFileSync(file));
    } catch {
      res.writeHead(400).end("bad request");
    }
  });
  server.on("upgrade", (_req, socket) => socket.destroy());

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        events,
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

async function clickDialogButton(page, label) {
  const clicked = await page.evaluate((text) => {
    const dialog = document.querySelector('[role="dialog"]');
    const button = [...(dialog?.querySelectorAll("button") ?? [])].find(
      (candidate) => candidate.textContent?.trim() === text,
    );
    if (!button) return false;
    button.click();
    return true;
  }, label);
  if (!clicked) throw new Error(`dialog button not found: ${label}`);
}

export default {
  name: "launcher-native-trust",
  async run(ctx) {
    const distRoot = join(ctx.repoRoot, "web-launcher", "dist");
    if (!existsSync(join(distRoot, "index.html"))) {
      ctx.skip("launcher dist missing; run the web build before SMOKE_SKIP_BUILD=1");
    }

    const backend = await trustBackend(distRoot);
    let page = null;
    try {
      page = await ctx.browser.newPage();
      await page.goto(backend.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForSelector('[aria-label="Connect shared-lab"]', { timeout: 30_000 });
      await ctx.shot("trust-required", page);

      // Cancel is inert: no trust mutation and no pending/connect transition.
      await page.click('[aria-label="Connect shared-lab"]');
      await page.waitForSelector('[role="dialog"][aria-label="Grant native access?"]');
      const warning = await page.$eval('[role="dialog"]', (node) => node.textContent ?? "");
      for (const phrase of [
        "controls the web content",
        "read and write your clipboard",
        "read files you select",
        "save downloads",
        "control Chan windows",
        "open links in your system browser",
      ]) {
        if (!warning.includes(phrase)) throw new Error(`native warning omitted: ${phrase}`);
      }
      await ctx.shot("confirmation", page);
      await clickDialogButton(page, "Cancel");
      await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
      if (backend.events.length !== 0) {
        throw new Error(`cancel mutated backend: ${backend.events.join(", ")}`);
      }

      // Confirm must PUT trust before connect. The backend returns 409 if this
      // ordering regresses, and the observed request log pins it exactly.
      await page.click('[aria-label="Connect shared-lab"]');
      await page.waitForSelector('[role="dialog"][aria-label="Grant native access?"]');
      await clickDialogButton(page, "Grant native access");
      await page.waitForSelector('[aria-label="Disconnect shared-lab"]', { timeout: 15_000 });
      await page.waitForSelector('[aria-label="Revoke native access for shared-lab"]');
      if (backend.events.join("|") !== "PUT native-trust|POST connect") {
        throw new Error(`wrong trust/connect order: ${backend.events.join(" -> ")}`);
      }
      await ctx.shot("trusted-connected", page);

      // DELETE waits for teardown in the production route. The harness mirrors
      // the response state: disconnected and trust-required again.
      await page.click('[aria-label="Revoke native access for shared-lab"]');
      await page.waitForSelector('[aria-label="Connect shared-lab"]', { timeout: 15_000 });
      await page.waitForFunction(
        () => !document.querySelector('[aria-label="Revoke native access for shared-lab"]'),
      );
      if (backend.events.join("|") !== "PUT native-trust|POST connect|DELETE native-trust") {
        throw new Error(`wrong revoke sequence: ${backend.events.join(" -> ")}`);
      }
      await ctx.shot("revoked", page);

      return { requestOrder: backend.events, screenshots: 4 };
    } finally {
      if (page) await page.close().catch(() => {});
      await backend.close();
    }
  },
};
