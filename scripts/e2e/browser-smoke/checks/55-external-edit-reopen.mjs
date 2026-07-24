// Repro: `cs open` shows stale content after an external disk edit.
//
// Scenario reported against v0.75: a file opened in the editor via
// `cs open`, then edited on disk outside the editor, keeps showing the
// OLD version on every later `cs open`, and the indexing notification
// pops each time.
//
// This check walks that exact path and records evidence at each step:
// what the editor shows, what the disk holds, what a SECOND fresh
// client sees (server-side stale session vs tab-buffer staleness), and
// whether the indexing pill appears. It fails when the externally
// written content never reaches the editor.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const FILE = "ext-edit.md";
const V1 = `SMOKE-EXT-V1-${Date.now()}`;
const V2 = `SMOKE-EXT-V2-${Date.now()}`;

async function editorText(page) {
  return page.evaluate(() => {
    const el = document.querySelector(".cm-content");
    return el ? (el.textContent ?? "") : null;
  });
}

async function diskText(ctx) {
  return readFileSync(join(ctx.workspaceDir, FILE), "utf8");
}

// Watch for the indexing pill (AppStatusBar) for `ms`, polling on an
// interval; returns true if "indexing"/"reindexing" ever showed.
async function sawIndexingPill(page, ms) {
  const t0 = Date.now();
  let seen = false;
  while (Date.now() - t0 < ms) {
    const hit = await page.evaluate(() =>
      /indexing|reindexing/i.test(document.body.innerText ?? ""),
    );
    if (hit) seen = true;
    await new Promise((r) => setTimeout(r, 120));
  }
  return seen;
}

export default {
  name: "cs-open-stale-after-external-edit",
  async run(ctx) {
    const socket = ctx.controlSocket;
    if (!socket) ctx.skip("control socket not found for the server pid");
    const { page, browser, serverUrl } = ctx;
    await page.bringToFront();

    const windowId = await page.evaluate(
      () =>
        new URL(location.href).searchParams.get("w")?.trim() ||
        window.sessionStorage.getItem("chan.session.window")?.trim() ||
        "",
    );
    if (!windowId) throw new Error("could not resolve the page's window id");
    const env = {
      ...process.env,
      CHAN_CONTROL_SOCKET: socket,
      CHAN_WINDOW_ID: windowId,
    };
    const csOpen = () =>
      ctx.exec(ctx.chanBin, ["shell", "open", FILE], {
        cwd: ctx.workspaceDir,
        env,
        timeout: 30_000,
      });

    const evidence = { v1: V1, v2: V2, steps: [] };
    const record = (step, data) => {
      evidence.steps.push({ step, ...data });
      console.log(`[smoke:55] ${step}: ${JSON.stringify(data)}`);
    };

    // 1. Seed the file on disk, open it via cs open.
    writeFileSync(join(ctx.workspaceDir, FILE), `${V1}\n`);
    await csOpen();
    await page.waitForFunction(
      (m) => {
        const el = document.querySelector(".cm-content");
        return el !== null && (el.textContent ?? "").includes(m);
      },
      { timeout: 30_000, polling: 250 },
      V1,
    );
    record("opened-via-cs-open", { editorShowsV1: true });
    await ctx.shot("after-first-open");

    // Let the doc session attach settle before the external edit.
    await new Promise((r) => setTimeout(r, 1500));

    // 2. Edit the file on disk, outside the editor.
    writeFileSync(join(ctx.workspaceDir, FILE), `${V2}\n`);
    const pillAfterEdit = await sawIndexingPill(page, 4000);
    record("after-external-edit", { pillAfterEdit });

    // 3. Give the watcher + reconciler every chance to merge the
    // external write into the open editor.
    let editorAfter = null;
    let mergedLive = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 10_000) {
      editorAfter = await editorText(page);
      if (editorAfter?.includes(V2)) {
        mergedLive = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    const diskAfter = await diskText(ctx);
    record("after-merge-window", {
      mergedLive,
      editorShows: editorAfter?.includes(V2)
        ? "v2"
        : editorAfter?.includes(V1)
          ? "v1"
          : "neither",
      diskShows: diskAfter.includes(V2) ? "v2" : diskAfter.includes(V1) ? "v1" : "neither",
    });
    await ctx.shot("after-external-edit");

    // 4. The reported repro: `cs open` again.
    await csOpen();
    const pillAfterReopen = await sawIndexingPill(page, 4000);
    const editorReopen = await editorText(page);
    const diskReopen = await diskText(ctx);
    record("after-second-cs-open", {
      pillAfterReopen,
      editorShows: editorReopen?.includes(V2)
        ? "v2"
        : editorReopen?.includes(V1)
          ? "v1"
          : "neither",
      diskShows: diskReopen.includes(V2)
        ? "v2"
        : diskReopen.includes(V1)
          ? "v1"
          : "neither",
    });
    await ctx.shot("after-second-cs-open");

    // 5. A fresh client distinguishes server-side staleness from a
    // stale tab buffer: page2 loads the file through GET /api/files.
    const page2 = await browser.newPage();
    try {
      await page2.goto(`${serverUrl}&w=smoke-ext-w2`, {
        waitUntil: "networkidle2",
        timeout: 60_000,
      });
      await page2.waitForSelector(".pane", { timeout: 30_000 });
      const w2 = await page2.evaluate(
        () =>
          new URL(location.href).searchParams.get("w")?.trim() ||
          window.sessionStorage.getItem("chan.session.window")?.trim() ||
          "",
      );
      await ctx.exec(ctx.chanBin, ["shell", "open", FILE], {
        cwd: ctx.workspaceDir,
        env: { ...env, CHAN_WINDOW_ID: w2 },
        timeout: 30_000,
      });
      await page2.waitForSelector(".cm-content", { timeout: 30_000 });
      await new Promise((r) => setTimeout(r, 1500));
      const fresh = await editorText(page2);
      record("fresh-client", {
        editorShows: fresh?.includes(V2)
          ? "v2"
          : fresh?.includes(V1)
            ? "v1"
            : "neither",
      });
      await ctx.shot("fresh-client", page2);
    } finally {
      if (!page2.isClosed()) await page2.close().catch(() => {});
    }

    const last = evidence.steps.find((s) => s.step === "after-second-cs-open");
    const fresh = evidence.steps.find((s) => s.step === "fresh-client");
    if (last.editorShows !== "v2" || fresh.editorShows !== "v2") {
      throw new Error(
        `stale content after external edit: ${JSON.stringify(evidence.steps)}`,
      );
    }
    return evidence;
  },
};
