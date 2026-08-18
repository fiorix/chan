// Item 7: two live clients on one Excalidraw scene. Concurrent draws
// converge on the authority (element counts + content hash), collab
// presence surfaces through the peers pill (cursor frames), a
// source-mode PUT against the live session propagates with a bumped
// version, and killing one client leaves the other working (with a
// cursor-gone cleanup on the survivor).

import { createHash } from "node:crypto";

const BOARD = "board.excalidraw";

async function openFileBrowser(page) {
  const open = await page.$(".file-tree, [role=tree]");
  if (open) return;
  await page.evaluate(() => {
    window.dispatchEvent(
      new CustomEvent("chan:command", { detail: { name: "app.files.toggle" } }),
    );
  });
  await page.waitForSelector('[role="treeitem"]', { timeout: 15_000 });
}

async function selectTreeFile(page, filename) {
  const clicked = await page.evaluate((name) => {
    const row = [
      ...document.querySelectorAll('[role="treeitem"] button.name'),
    ].find((b) => b.textContent?.trim() === name);
    if (!row) return false;
    row.click();
    return true;
  }, filename);
  if (!clicked) throw new Error(`tree row not found: ${filename}`);
}

async function openBoard(page) {
  await page.bringToFront();
  await openFileBrowser(page);
  await selectTreeFile(page, BOARD);
  // A tree click selects into the Details inspector; the Open button
  // is what mounts the tab.
  const opened = await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "Open",
    );
    if (!btn) return false;
    btn.click();
    return true;
  });
  if (!opened) throw new Error("inspector Open button not found");
  // The React island lazy-loads on first canvas activation.
  await page.waitForSelector(".excalidraw-host canvas", { timeout: 60_000 });
}

/// The authority's view of the scene, read from the page context with
/// the page's own `?t=` token (the GET divert serves the live
/// session's file form under the session CAS token).
async function fetchScene(page) {
  return page.evaluate(async (path) => {
    // The SPA stows the boot token in sessionStorage and cleans the URL.
    const t =
      sessionStorage.getItem("chan.token") ??
      new URLSearchParams(location.search).get("t");
    const res = await fetch(
      `/api/fs/${path}?t=${encodeURIComponent(t ?? "")}`,
    );
    if (!res.ok) throw new Error(`GET ${path}: ${res.status}`);
    const body = await res.json();
    return { content: body.content, mtimeNs: body.mtime_ns ?? null };
  }, BOARD);
}

async function pollElementCount(page, expected, timeoutMs = 20_000) {
  const start = Date.now();
  for (;;) {
    const { content } = await fetchScene(page);
    const n = JSON.parse(content).elements.length;
    if (n === expected) return content;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`authority holds ${n} elements, expected ${expected}`);
    }
    await new Promise((r) => setTimeout(r, 400));
  }
}

// Two-page discipline: a HIDDEN tab stops delivering rAF, which hangs
// puppeteer's element screenshots (IntersectionObserver inside
// scrollIntoViewIfNeeded) and default raf-polling waits forever. Every
// helper that touches a page's rendering or input foregrounds it
// first, and waits poll on an interval instead of rAF.

async function canvasHash(page) {
  await page.bringToFront();
  const host = await page.$(".excalidraw-host");
  const shot = await host.screenshot();
  return createHash("sha256").update(shot).digest("hex");
}

/// Wiggle the pointer over the canvas so cursor frames fan to peers.
async function wigglePointer(page) {
  await page.bringToFront();
  const host = await page.$(".excalidraw-host");
  const box = await host.boundingBox();
  for (let i = 0; i < 4; i++) {
    await page.mouse.move(
      box.x + box.width * (0.3 + i * 0.1),
      box.y + box.height * (0.4 + i * 0.05),
    );
    await new Promise((r) => setTimeout(r, 120));
  }
}

/// Draw one shape with the real tool flow: hotkey, then a drag.
async function drawShape(page, tool, dx, dy) {
  await page.bringToFront();
  const host = await page.$(".excalidraw-host");
  const box = await host.boundingBox();
  // Focus an empty corner first so the hotkey reaches the canvas.
  await page.mouse.click(box.x + box.width * 0.85, box.y + box.height * 0.85);
  await page.keyboard.press(tool);
  const x0 = box.x + box.width / 2 + dx;
  const y0 = box.y + box.height / 2 + dy;
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move(x0 + 110, y0 + 70, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.press("Escape");
}

async function waitPeersPill(page, timeoutMs = 20_000) {
  await page.waitForFunction(
    () => {
      const pill = document.querySelector(".peers-pill");
      return pill !== null && Number(pill.textContent) >= 1;
    },
    { timeout: timeoutMs, polling: 250 },
  );
}

export default {
  name: "excalidraw-collab",
  async run(ctx) {
    const { page, browser, serverUrl } = ctx;
    const details = {};

    await openBoard(page);
    await ctx.shot("client-a-board");

    // Second client: an explicit &w= makes it a distinct window so
    // presence counts it as a peer.
    const page2 = await browser.newPage();
    try {
      await page2.goto(`${serverUrl}&w=smoke-collab-w2`, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await page2.waitForSelector(".pane", { timeout: 30_000 });
      await openBoard(page2);
      await page.bringToFront();
      await ctx.shot("client-a-after-b-joined");

      // Presence: pointer moves fan cursor frames; both sides show the
      // peers pill (cursor state, not just an open socket).
      await wigglePointer(page);
      await wigglePointer(page2);
      await waitPeersPill(page);
      await waitPeersPill(page2);
      await page.bringToFront();
      await ctx.shot("client-a-peer-pill");
      details.presence = "peers pill on both clients";

      // Concurrent draws converge on the authority. The canvas hashes
      // are repaint evidence (element + pointer overlays both
      // contribute); the authority count + hash is the convergence
      // proof.
      const bBaseline = await canvasHash(page2);
      await drawShape(page, "r", -140, -40);
      await pollElementCount(page, 3);
      const bAfterA = await canvasHash(page2);
      if (bAfterA === bBaseline) {
        throw new Error("client B canvas never repainted after A's draw");
      }

      const aBaseline = await canvasHash(page);
      await drawShape(page2, "o", 60, 40);
      await pollElementCount(page, 4);
      const aAfterB = await canvasHash(page);
      if (aAfterB === aBaseline) {
        throw new Error("client A canvas never repainted after B's draw");
      }
      await page.bringToFront();
      await ctx.shot("client-a-converged");

      // Stable authority: two consecutive reads hash identically once
      // both pushes settled.
      const read1 = await pollElementCount(page, 4);
      const read2 = (await fetchScene(page2)).content;
      const h1 = createHash("sha256").update(read1).digest("hex");
      const h2 = createHash("sha256").update(read2).digest("hex");
      if (h1 !== h2) throw new Error("authority content unstable across reads");
      details.convergedSha256 = h1;
      details.convergedElements = 4;

      // Source-mode PUT against the live session: the body becomes the
      // authority, the touched element's version bumps past every
      // stored one, and the change fans live. CAS races the ~800ms
      // flush debounce, so retry the GET+PUT loop on 409.
      const putResult = await page.evaluate(async (path) => {
        const t =
          sessionStorage.getItem("chan.token") ??
          new URLSearchParams(location.search).get("t");
        const url = `/api/fs/${path}?t=${encodeURIComponent(t ?? "")}`;
        for (let attempt = 0; attempt < 5; attempt++) {
          const get = await fetch(url);
          if (!get.ok) throw new Error(`GET ${path}: ${get.status}`);
          const body = await get.json();
          const scene = JSON.parse(body.content);
          const rect = scene.elements.find((e) => e.id === "smoke-rect-1");
          if (!rect) throw new Error("seed rectangle missing from authority");
          const versionBefore = rect.version;
          rect.strokeColor = "#2f9e44";
          const putUrl = new URL(url, location.origin);
          if (body.mtime_ns != null) {
            putUrl.searchParams.set("expected_mtime_ns", body.mtime_ns);
          }
          if (body.authority_version != null) {
            putUrl.searchParams.set(
              "authority_version",
              String(body.authority_version),
            );
          }
          const put = await fetch(putUrl, {
            method: "PUT",
            headers: { "content-type": "text/plain; charset=utf-8" },
            body: JSON.stringify(scene, null, 2),
          });
          if (put.status === 409 || put.status === 428) continue;
          if (!put.ok) {
            throw new Error(`PUT ${path}: ${put.status} ${await put.text()}`);
          }
          return { versionBefore, attempts: attempt + 1 };
        }
        throw new Error("PUT kept losing the CAS race after 5 attempts");
      }, BOARD);

      const afterPut = JSON.parse((await fetchScene(page)).content);
      const rect = afterPut.elements.find((e) => e.id === "smoke-rect-1");
      if (rect.strokeColor !== "#2f9e44") {
        throw new Error(
          `PUT edit not adopted: strokeColor ${rect.strokeColor}`,
        );
      }
      if (!(rect.version > putResult.versionBefore)) {
        throw new Error(
          `replace did not bump the version (${putResult.versionBefore} -> ${rect.version})`,
        );
      }
      details.putPropagation = {
        attempts: putResult.attempts,
        versionBefore: putResult.versionBefore,
        versionAfter: rect.version,
      };
      await page.bringToFront();
      await ctx.shot("client-a-after-put");

      // Kill one client outright: the survivor sees the cursor-gone
      // cleanup (pill disappears) and keeps mutating the scene.
      await page2.close();
      await page.bringToFront();
      await page.waitForFunction(
        () => document.querySelector(".peers-pill") === null,
        { timeout: 20_000, polling: 250 },
      );
      await drawShape(page, "d", 40, -120);
      await pollElementCount(page, 5);
      details.survivorElements = 5;
      await ctx.shot("client-a-survivor");
      return details;
    } finally {
      if (!page2.isClosed()) await page2.close().catch(() => {});
    }
  },
};
