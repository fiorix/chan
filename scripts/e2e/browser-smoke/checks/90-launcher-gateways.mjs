// The launcher's Gateways screen, demo-backed: the manual page's launcher
// embed runs the real SPA against the in-memory demo backend on the default
// (desktop) surface, so the flip toggle and gateway mutations work with no
// desktop process. The check flips Computers -> Gateways, adds a gateway
// through the URL-only form, asserts its badge renders and connects, then
// raises a synthetic desktop error over the launcher-notice channel (a Tauri
// event bridge shim injected before the SPA boots) and asserts the corner
// notice bubble renders, expands, and dismisses.
//
// The marketing dist is rebuilt from the current sources unless
// SMOKE_SKIP_BUILD=1 (then a stale-but-present dist is accepted), and served
// from a throwaway static file server.

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
  ".txt": "text/plain",
};

/// Serve `root` on an ephemeral loopback port; directories resolve to their
/// index.html. Resolves with { url, close }.
function serveStatic(root) {
  const server = createServer((req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, "http://x").pathname);
      let rel = normalize(pathname).replace(/^([/\\])+/, "");
      if (rel.startsWith("..")) throw new Error("traversal");
      let file = join(root, rel);
      if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
      if (!existsSync(file)) {
        res.writeHead(404).end("not found");
        return;
      }
      res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
      res.end(readFileSync(file));
    } catch {
      res.writeHead(400).end("bad request");
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

export default {
  name: "launcher-gateways",
  async run(ctx) {
    const distRoot = join(ctx.repoRoot, "web", "packages", "marketing", "dist");
    if (process.env.SMOKE_SKIP_BUILD === "1") {
      if (!existsSync(join(distRoot, "manual", "index.html"))) {
        ctx.skip("marketing dist missing and SMOKE_SKIP_BUILD=1");
      }
    } else {
      // The demo bundle embeds @chan/launcher source, so a rebuild is what
      // makes this check test the code under review, not a stale dist.
      await ctx.exec("npm", ["run", "build", "-w", "@chan/marketing"], {
        cwd: join(ctx.repoRoot, "web"),
        timeout: 300_000,
      });
    }

    const site = await serveStatic(distRoot);
    let page = null;
    try {
      page = await ctx.browser.newPage();
      // A minimal Tauri event bridge, installed before any SPA module runs:
      // the launcher subscribes launcher-notice through it, and the check
      // fires the synthetic payload back through the captured listener.
      await page.evaluateOnNewDocument(() => {
        const listeners = {};
        window.__smokeTauri = { listeners };
        window.__TAURI__ = {
          event: {
            listen: (name, cb) => {
              listeners[name] = cb;
              return Promise.resolve(() => {
                delete listeners[name];
              });
            },
          },
        };
      });

      await page.goto(`${site.url}/manual/`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForSelector("#launcher-demo.mounted", { timeout: 30_000 });
      await page.waitForSelector(".topbar button.title-toggle", { timeout: 30_000 });

      // Flip Computers -> Gateways: the toggle relabels and the (empty)
      // gateways screen swaps in. Then WAIT for the 520ms turn to settle
      // (flipActive drops on animationend): clicking mid-flip misses -- the
      // content is rotated away from its static coordinates. The settle also
      // proves the animation runs and completes in a real browser.
      await page.click(".topbar button.title-toggle");
      await page.waitForSelector(".gateways-screen", { timeout: 10_000 });
      await page.waitForFunction(
        () => {
          const shell = document.querySelector("[class*='screen-flip']");
          return !!shell && !shell.classList.contains("flipActive");
        },
        { timeout: 10_000 },
      );
      const emptyHint = await page.$eval(".gateways-screen", (el) => el.textContent ?? "");
      if (!emptyHint.includes("No gateways yet")) {
        throw new Error("expected the empty-state hint on the fresh gateways screen");
      }
      await ctx.shot("gateways-empty", page);

      // Add a gateway through the URL-only form.
      await page.click("button[class*='add-gateway']");
      await page.waitForSelector('input[placeholder="https://gateway.example.com"]', {
        timeout: 10_000,
      });
      await page.type('input[placeholder="https://gateway.example.com"]', "https://gw.example");
      await page.type('input[placeholder="Defaults to the URL host"]', "smoke-gw");
      await page.click("[class*='dialog-footer'] button[class*='primary']");
      await page.waitForFunction(
        () =>
          [...document.querySelectorAll("[class*='gateway-card']")].some((c) =>
            c.textContent?.includes("smoke-gw"),
          ),
        { timeout: 10_000 },
      );
      await ctx.shot("gateway-added", page);

      // Connect it: the demo flips the badge live.
      await page.click('[aria-label="Connect gateway smoke-gw"]');
      await page.waitForSelector("[class*='gateway-card'] [class*='status-dot'][class*='live']", {
        timeout: 10_000,
      });
      await page.waitForSelector('[aria-label="Disconnect gateway smoke-gw"]', {
        timeout: 10_000,
      });
      await ctx.shot("gateway-connected", page);

      // Synthetic desktop error over the launcher-notice channel -> a corner
      // bubble with the gateway source chip; expand, then dismiss.
      await page.evaluate(() => {
        const deliver = window.__smokeTauri.listeners["launcher-notice"];
        if (!deliver) throw new Error("the SPA never subscribed launcher-notice");
        deliver({
          payload: {
            id: "ntc-smoke",
            kind: "error",
            source: { type: "gateway", id: "gw-smoke", label: "smoke-gw" },
            title: "Roster poll failed",
            message: "synthetic smoke error: the roster poll failed three times",
            at: Date.now(),
          },
        });
      });
      await page.waitForSelector('[class*="notice-bubble"][role="alert"]', { timeout: 10_000 });
      const bubbleText = await page.$eval(
        '[class*="notice-bubble"][role="alert"]',
        (el) => el.textContent ?? "",
      );
      if (!bubbleText.includes("gateway smoke-gw") || !bubbleText.includes("Roster poll failed")) {
        throw new Error(`notice bubble missing source/title: ${bubbleText}`);
      }
      await ctx.shot("notice-bubble", page);

      await page.click("[class*='nb-body']");
      await page.waitForFunction(
        () =>
          document
            .querySelector("[class*='nb-body']")
            ?.getAttribute("aria-expanded") === "true",
        { timeout: 10_000 },
      );
      await page.click('[class*="notice-bubble"] [aria-label="Dismiss"]');
      await page.waitForFunction(
        () => !document.querySelector('[class*="notice-bubble"]'),
        { timeout: 10_000 },
      );

      return {
        page: "/manual/ (empty-variant launcher demo)",
        added: "smoke-gw",
        connected: true,
        noticeBubble: "rendered, expanded, dismissed",
      };
    } finally {
      if (page) await page.close().catch(() => {});
      await site.close();
    }
  },
};
