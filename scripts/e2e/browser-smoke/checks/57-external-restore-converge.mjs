// An external edit that byte-exactly restores content the session
// recently adopted from disk must converge at watcher speed, the same
// as any other external edit. The restore shape is what undo, revert,
// `git checkout` and filesystem-editing agents all produce, so it
// cannot be treated as a suspect echo of the session's own writes.
// Convergence has to reach the editor, GET /api/files, and later
// `cs open` calls without another filesystem event.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TS = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Generous next to the sub-second convergence this asserts, but tight
// enough to fail loudly if a restore ever falls back to being held for
// the self-write echo window.
const CONVERGE_BUDGET_MS = 8000;

async function editorText(page) {
  return page.evaluate(() => {
    const el = document.querySelector(".cm-content");
    return el ? (el.textContent ?? "") : null;
  });
}

async function waitEditorHas(page, marker, timeoutMs) {
  try {
    await page.waitForFunction(
      (m) => {
        const el = document.querySelector(".cm-content");
        return el !== null && (el.textContent ?? "").includes(m);
      },
      { timeout: timeoutMs, polling: 200 },
      marker,
    );
    return true;
  } catch {
    return false;
  }
}

export default {
  name: "external-restore-converges",
  async run(ctx) {
    const socket = ctx.controlSocket;
    if (!socket) ctx.skip("control socket not found for the server pid");
    const { browser, serverUrl } = ctx;
    const token = new URL(serverUrl).searchParams.get("t");

    const file = "restore.md";
    const v1 = `RESTORE-V1-${TS}`;
    const v2 = `RESTORE-V2-${TS}`;
    const v3 = `RESTORE-V3-${TS}`;
    const disk = () => readFileSync(join(ctx.workspaceDir, file), "utf8");
    const writeDisk = (text) =>
      writeFileSync(join(ctx.workspaceDir, file), text);

    const page = await browser.newPage();
    try {
      await page.goto(`${serverUrl}&w=smoke-restore`, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await page.waitForSelector(".pane", { timeout: 30_000 });
      const wid = await page.evaluate(
        () =>
          new URL(location.href).searchParams.get("w")?.trim() ||
          window.sessionStorage.getItem("chan.session.window")?.trim() ||
          "",
      );
      // The pane is mounted; the server does not necessarily know this window
      // yet, and everything below addresses it by id.
      await ctx.waitWindowLive(wid);
      const env = {
        ...process.env,
        CHAN_CONTROL_SOCKET: socket,
        CHAN_WINDOW_ID: wid,
      };
      const csOpen = () =>
        ctx.exec(ctx.chanBin, ["shell", "open", file], {
          cwd: ctx.workspaceDir,
          env,
          timeout: 30_000,
        });
      const apiRead = () =>
        page.evaluate(
          async ({ tok, file }) => {
            const r = await fetch(`/api/files/${file}`, {
              headers: { authorization: `Bearer ${tok}` },
            });
            if (!r.ok) return `HTTP ${r.status}`;
            return (await r.json()).content ?? "";
          },
          { tok: token, file },
        );

      const evidence = { steps: [] };
      const record = (step, data) => {
        evidence.steps.push({ step, ...data });
        console.log(`[smoke:57] ${step}: ${JSON.stringify(data)}`);
      };

      // 1. Open V1. The attach read enters the session's echo ring.
      writeDisk(`${v1}\n`);
      await page.bringToFront();
      await csOpen();
      if (!(await waitEditorHas(page, v1, 30_000))) {
        throw new Error("initial open did not show v1");
      }
      await sleep(1500);
      record("opened-v1", { ok: true });

      // 2. External edit to V2. Novel content, the easy direction.
      writeDisk(`${v2}\n`);
      const merged = await waitEditorHas(page, v2, 10_000);
      record("external-edit-v2", { mergedLive: merged });
      if (!merged) throw new Error("baseline live merge to v2 failed");
      await sleep(500);

      // 3. External RESTORE of V1. Byte-identical to what the session
      // adopted at open, and it must still converge promptly.
      writeDisk(`${v1}\n`);
      const restoreStarted = Date.now();
      const backToV1 = await waitEditorHas(page, v1, CONVERGE_BUDGET_MS);
      const edAfterRestore = await editorText(page);
      record("external-restore-v1", {
        editorFollowed: backToV1,
        elapsedMs: Date.now() - restoreStarted,
        editorShows: edAfterRestore?.includes(v1) ? "v1" : "other",
        diskShows: disk().includes(v1) ? "v1" : "other",
        apiShows: (await apiRead()).includes(v1) ? "v1" : "other",
      });
      await ctx.shot("after-restore");

      // 4. A later cs open must share the converged authority.
      await csOpen();
      await sleep(2000);
      const edReopen = await editorText(page);
      record("second-cs-open", {
        editorShows: edReopen?.includes(v1)
          ? "v1"
          : edReopen?.includes(v2)
            ? "v2"
            : "neither",
        apiShows: (await apiRead()).includes(v1) ? "v1" : "v2-or-other",
      });

      // 5. A fresh external edit still folds through the live session.
      writeDisk(`${v3}\n`);
      const toV3 = await waitEditorHas(page, v3, 8000);
      record("external-edit-v3", { editorFollowed: toV3 });

      const restore = evidence.steps.find(
        (s) => s.step === "external-restore-v1",
      );
      const reopen = evidence.steps.find((s) => s.step === "second-cs-open");
      if (
        !restore.editorFollowed ||
        restore.apiShows !== "v1" ||
        reopen.editorShows !== "v1" ||
        !toV3
      ) {
        throw new Error(
          `external restore did not converge: ${JSON.stringify(evidence.steps)}`,
        );
      }
      return evidence;
    } finally {
      if (!page.isClosed()) await page.close().catch(() => {});
    }
  },
};
