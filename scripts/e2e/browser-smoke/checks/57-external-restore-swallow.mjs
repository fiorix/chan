// Root-cause probe for the reported "cs open shows the old version
// after an external edit" bug: the doc-session DiskEchoRing swallows
// an external edit that byte-exactly restores content the session put
// on disk within the last 60s (attach seed / flush / merge). The
// swallow adopts the token and clears pending_fold, and because the
// reconciler is event-driven, nothing re-checks after the 60s TTL
// lapses: the stale authority is served to the editor, to
// GET /api/files, and to every later `cs open`, forever.
//
// Walk: open V1 (seed enters the ring) -> external edit to V2 (folds
// live; both hashes now ringed) -> external RESTORE of V1 (predicted
// swallowed) -> cs open again. A final edit to V3 proves the session
// is alive and the V1-restore was specifically misclassified.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TS = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  name: "external-restore-echo-swallow",
  async run(ctx) {
    // OPEN BUG repro: the doc-session DiskEchoRing permanently swallows
    // an external edit that byte-exactly restores recently-seen content
    // (v0.68.0, 5c1b1509). Skipped by default so the suite stays green
    // while the fix is open; SMOKE_RUN_REPRO=1 runs it (red until fixed).
    if (process.env.SMOKE_RUN_REPRO !== "1") {
      ctx.skip("open echo-ring swallow repro (SMOKE_RUN_REPRO=1 to run)");
    }
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
        waitUntil: "networkidle2",
        timeout: 60_000,
      });
      await page.waitForSelector(".pane", { timeout: 30_000 });
      const wid = await page.evaluate(
        () =>
          new URL(location.href).searchParams.get("w")?.trim() ||
          window.sessionStorage.getItem("chan.session.window")?.trim() ||
          "",
      );
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

      // 1. Open V1: the attach seed notes hash(V1) in the echo ring.
      writeDisk(`${v1}\n`);
      await page.bringToFront();
      await csOpen();
      if (!(await waitEditorHas(page, v1, 30_000))) {
        throw new Error("initial open did not show v1");
      }
      await sleep(1500);
      record("opened-v1", { ok: true });

      // 2. External edit to V2: folds live (merge notes hash(V2) too).
      writeDisk(`${v2}\n`);
      const merged = await waitEditorHas(page, v2, 10_000);
      record("external-edit-v2", { mergedLive: merged });
      if (!merged) throw new Error("baseline live merge to v2 failed");
      await sleep(500);

      // 3. External RESTORE of V1, well inside the 60s ring TTL.
      // Healthy behavior: the editor follows the disk back to v1.
      writeDisk(`${v1}\n`);
      const backToV1 = await waitEditorHas(page, v1, 8000);
      const edAfterRestore = await editorText(page);
      record("external-restore-v1", {
        editorFollowed: backToV1,
        editorShows: edAfterRestore?.includes(v1)
          ? "v1"
          : edAfterRestore?.includes(v2)
            ? "v2"
            : "neither",
        diskShows: disk().includes(v1) ? "v1" : "other",
        apiShows: (await apiRead()).includes(v1) ? "v1" : "v2-or-other",
      });
      await ctx.shot("after-restore");

      // 4. The reported repro: cs open again.
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

      // 5. Discriminator: a fresh external edit to V3. If the editor
      // follows to V3, the session was alive all along and the V1
      // restore was specifically swallowed as an echo.
      writeDisk(`${v3}\n`);
      const toV3 = await waitEditorHas(page, v3, 8000);
      record("external-edit-v3", { editorFollowed: toV3 });

      // 6. (SMOKE_TTL_WAIT=1 only) Prove the staleness OUTLIVES the
      // ring's 60s TTL: restore V1 again, wait out the TTL plus margin
      // with no further disk activity, then look. The reconciler is
      // event-driven, so nothing re-checks the file once the echo
      // window lapses: a healthy system would self-heal here.
      if (process.env.SMOKE_TTL_WAIT === "1") {
        writeDisk(`${v1}\n`); // swallowed again (merge noted v1? no: v1
        // entered the ring at the seed; the v3 merge noted v3. Whether
        // this restore is swallowed or folded, the interesting read is
        // AFTER the TTL: every entry is long dead by then.
        const followedNow = await waitEditorHas(page, v1, 8000);
        record("restore-before-ttl-wait", { editorFollowed: followedNow });
        await sleep(65_000);
        const edLate = await editorText(page);
        record("after-ttl-lapse", {
          editorShows: edLate?.includes(v1)
            ? "v1"
            : edLate?.includes(v3)
              ? "v3"
              : "other",
          diskShows: disk().includes(v1) ? "v1" : "other",
          apiShows: (await apiRead()).includes(v1) ? "v1" : "other",
        });
        await ctx.shot("after-ttl-lapse");
        const late = evidence.steps.find((s) => s.step === "after-ttl-lapse");
        if (late.editorShows !== "v1") {
          throw new Error(
            `staleness outlived the 60s echo TTL: ${JSON.stringify(evidence.steps)}`,
          );
        }
      }

      const restore = evidence.steps.find((s) => s.step === "external-restore-v1");
      const reopen = evidence.steps.find((s) => s.step === "second-cs-open");
      if (!restore.editorFollowed || reopen.editorShows !== "v1") {
        throw new Error(
          `external restore swallowed by the echo ring: ${JSON.stringify(evidence.steps)}`,
        );
      }
      return evidence;
    } finally {
      if (!page.isClosed()) await page.close().catch(() => {});
    }
  },
};
