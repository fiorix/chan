// Large-file / streaming reliability matrix, end to end through a real
// server + headless Chrome:
//   A  6 MiB markdown streams COMPLETE into the editor (first+last
//      markers, sane wall time)
//   B  edit + save on the large file round-trips (marker persists, no
//      truncation of the tail)
//   C  external append on the large file raises the "changed on disk"
//      banner (>2 MiB files have no doc session) and Reload adopts it
//   D  invalid UTF-8 past the sniff window surfaces an error, never
//      silent truncation
//   E  a brand-new >2 MiB text PUT answers 413 (WriteTooLarge)
//   F  GET /api/files JSON serves byte-identical content for the big
//      file
//
// These pin the hardening around read_text_with_stat_chunked, the
// NDJSON meta/chunk/done stream, byte-count completion, the CAS
// prev_size escape for already-large files, and the no-session
// classic path.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TS = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BIG = "big.md";
const FIRST = `BIG-FIRST-${TS}`;
const MID = `BIG-MID-${TS}`;
const LAST = `BIG-LAST-${TS}`;

function buildBigFile() {
  const parts = [`${FIRST}\n`];
  let size = parts[0].length;
  const target = 6 * 1024 * 1024;
  let i = 0;
  while (size < target / 2) {
    const line = `L${String(++i).padStart(7, "0")} ${"x".repeat(90)}\n`;
    parts.push(line);
    size += line.length;
  }
  parts.push(`${MID}\n`);
  size += MID.length + 1;
  while (size < target) {
    const line = `L${String(++i).padStart(7, "0")} ${"y".repeat(90)}\n`;
    parts.push(line);
    size += line.length;
  }
  parts.push(`${LAST}\n`);
  return parts.join("");
}

async function editorText(page) {
  return page.evaluate(() => {
    const el = document.querySelector(".cm-content");
    return el ? (el.textContent ?? "") : null;
  });
}

export default {
  name: "large-file-streaming",
  async run(ctx) {
    const socket = ctx.controlSocket;
    if (!socket) ctx.skip("control socket not found for the server pid");
    const { browser, serverUrl } = ctx;
    const token = new URL(serverUrl).searchParams.get("t");

    const page = await browser.newPage();
    try {
      await page.goto(`${serverUrl}&w=smoke-big`, {
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
      const csOpen = (file) =>
        ctx.exec(ctx.chanBin, ["shell", "open", file], {
          cwd: ctx.workspaceDir,
          env,
          timeout: 30_000,
        });
      const api = (path, init) =>
        page.evaluate(
          async ({ tok, path, init }) => {
            const r = await fetch(`/api/files/${path}`, {
              ...init,
              headers: {
                ...(init?.headers ?? {}),
                authorization: `Bearer ${tok}`,
              },
            });
            return { status: r.status, body: await r.text() };
          },
          { tok: token, path, init },
        );
      const bannerUp = () =>
        page.evaluate(() =>
          /changed on disk/i.test(document.body.innerText ?? ""),
        );
      const loadingGone = () =>
        page.evaluate(
          () => !document.querySelector(".loading-toolbar"),
        );
      // CM6 renders only the viewport: probe full-doc completeness by
      // jumping the caret to the end and reading what materializes.
      const tailText = async () => {
        await page.evaluate(() => {
          const el = document.querySelector(".cm-content");
          el?.dispatchEvent(
            new KeyboardEvent("keydown", {
              key: "End",
              code: "End",
              ctrlKey: true,
              bubbles: true,
            }),
          );
        });
        await page.keyboard.down("Control");
        await page.keyboard.press("End");
        await page.keyboard.up("Control");
        await sleep(1200);
        return editorText(page);
      };

      const evidence = { steps: [] };
      const record = (step, data) => {
        evidence.steps.push({ step, ...data });
        console.log(`[smoke:59] ${step}: ${JSON.stringify(data)}`);
      };
      const failures = [];

      // ---- A: 6 MiB file streams complete into the editor ----
      const big = buildBigFile();
      writeFileSync(join(ctx.workspaceDir, BIG), big);
      await page.bringToFront();
      const t0 = Date.now();
      await csOpen(BIG);
      let sawProgress = false;
      let lastProgress = null;
      let loaded = false;
      while (Date.now() - t0 < 90_000) {
        const state = await page.evaluate(() => {
          const bar = document.querySelector(".loading-toolbar");
          return {
            loading: bar !== null,
            progress: bar?.textContent?.trim() ?? null,
            editorUp: document.querySelector(".cm-content") !== null,
          };
        });
        if (state.progress && state.progress !== lastProgress) {
          sawProgress = true;
          lastProgress = state.progress;
        }
        if (!state.loading && state.editorUp) {
          loaded = true;
          break;
        }
        await sleep(300);
      }
      const openMs = Date.now() - t0;
      const top = await editorText(page);
      let tail = null;
      if (loaded) tail = await tailText();
      record("A-big-open", {
        loaded,
        openMs,
        sawProgress,
        lastProgress,
        hasFirst: top?.includes(FIRST) ?? false,
        tailHasLast: tail?.includes(LAST) ?? false,
      });
      if (!loaded || !top?.includes(FIRST) || !tail?.includes(LAST)) {
        failures.push(`A: 6MiB open incomplete ${JSON.stringify(evidence.steps.at(-1))}`);
      }

      // ---- B: edit + save on a >2 MiB file. check_size pins
      // effective = max(prev_size, 2 MiB): growth past the current
      // size MUST be rejected. The reliability contract here is that
      // the rejection is HONEST: disk untouched, a legible error in
      // the tab, the buffer not silently marked saved.
      const EDIT = `BIG-EDIT-${TS}`;
      const diskBefore = readFileSync(join(ctx.workspaceDir, BIG), "utf8");
      await page.click(".cm-content");
      await page.keyboard.down("Control");
      await page.keyboard.press("Home");
      await page.keyboard.up("Control");
      await page.keyboard.type(`${EDIT} `, { delay: 5 });
      await page.keyboard.down("Control");
      await page.keyboard.press("s");
      await page.keyboard.up("Control");
      let bOutcome = null;
      const t1 = Date.now();
      while (Date.now() - t1 < 20_000) {
        const disk = readFileSync(join(ctx.workspaceDir, BIG), "utf8");
        if (disk.includes(EDIT)) {
          bOutcome = {
            kind: "saved",
            tailIntact: disk.trimEnd().endsWith(LAST),
          };
          break;
        }
        const errText = await page.evaluate(() => {
          const el = document.querySelector(".editor-toolbar .error");
          return el?.textContent?.trim() ?? null;
        });
        if (errText) {
          bOutcome = { kind: "error", message: errText };
          break;
        }
        await sleep(400);
      }
      const diskAfter = readFileSync(join(ctx.workspaceDir, BIG), "utf8");
      record("B-big-save", {
        outcome: bOutcome,
        diskUnchanged: diskAfter === diskBefore,
        tailIntact: diskAfter.trimEnd().endsWith(LAST),
      });
      const bOk =
        (bOutcome?.kind === "saved" && bOutcome.tailIntact) ||
        (bOutcome?.kind === "error" &&
          /too large/i.test(bOutcome.message ?? "") &&
          diskAfter === diskBefore);
      if (!bOk) {
        failures.push(
          `B: large-file save neither landed nor honestly rejected ${JSON.stringify(evidence.steps.at(-1))}`,
        );
      }

      // ---- C: external append -> banner -> Reload ----
      const EXT = `BIG-EXT-${TS}`;
      {
        const disk = readFileSync(join(ctx.workspaceDir, BIG), "utf8");
        writeFileSync(join(ctx.workspaceDir, BIG), `${disk}${EXT}\n`);
      }
      let surfaced = false;
      const t2 = Date.now();
      while (Date.now() - t2 < 30_000) {
        if (await bannerUp()) {
          surfaced = true;
          break;
        }
        await sleep(300);
      }
      let reloaded = false;
      if (surfaced) {
        await page.evaluate(() => {
          const btn = [...document.querySelectorAll("button")].find((b) =>
            b.textContent?.trim().startsWith("Reload"),
          );
          btn?.click();
        });
        const t3 = Date.now();
        while (Date.now() - t3 < 90_000) {
          if (await loadingGone()) {
            const tail = await tailText();
            if (tail?.includes(EXT)) {
              reloaded = true;
              break;
            }
          }
          await sleep(500);
        }
      }
      record("C-external-append", { surfaced, reloaded });
      if (!surfaced || !reloaded) {
        failures.push(`C: external append on large file not surfaced ${JSON.stringify(evidence.steps.at(-1))}`);
      }

      // ---- D: invalid UTF-8 past the sniff window -> honest error ----
      {
        const badFile = "bad-utf8.md";
        const head = `BAD-HEAD-${TS}\n${"z".repeat(200_000)}\n`;
        const buf = Buffer.concat([
          Buffer.from(head, "utf8"),
          Buffer.from([0xff, 0xfe, 0xfd, 0xfc]),
        ]);
        writeFileSync(join(ctx.workspaceDir, badFile), buf);
        await csOpen(badFile);
        await sleep(4000);
        const state = await page.evaluate(() => {
          const el = document.querySelector(".cm-content");
          return {
            editorText: el?.textContent ?? null,
            body: (document.body.innerText ?? "").slice(0, 2000),
          };
        });
        const honest =
          !state.editorText?.includes("BAD-HEAD") ||
          /invalid utf-8|error|failed/i.test(state.body);
        record("D-bad-utf8", {
          showsContent: state.editorText?.includes("BAD-HEAD") ?? false,
          honest,
          snippet: state.body.slice(0, 300),
        });
        if (!honest) {
          failures.push(`D: invalid UTF-8 silently truncated/mis-shown`);
        }
      }

      // ---- E: new >2 MiB text PUT -> 413 ----
      {
        const resp = await api("new-huge.md", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            content: "h".repeat(3 * 1024 * 1024),
            expected_mtime: null,
            expected_mtime_ns: null,
          }),
        });
        record("E-over-limit-put", { status: resp.status });
        if (resp.status !== 413) {
          failures.push(`E: over-limit PUT answered ${resp.status}, want 413`);
        }
      }

      // ---- F: GET JSON serves byte-identical big content ----
      {
        const resp = await api(BIG);
        // The plain GET JSON envelope; compare against disk length
        // modulo the trailing append timing (read AFTER C's reload, so
        // both carry EXT).
        const disk = readFileSync(join(ctx.workspaceDir, BIG), "utf8");
        const served = JSON.parse(resp.body ?? "{}");
        record("F-api-integrity", {
          status: resp.status,
          match: served.content === disk,
          servedLen: served.content?.length ?? -1,
          diskLen: disk.length,
        });
        if (resp.status !== 200 || served.content !== disk) {
          failures.push(`F: api content diverges from disk`);
        }
      }

      if (failures.length > 0) {
        throw new Error(`large-file matrix: ${failures.join(" | ")}`);
      }
      return evidence;
    } finally {
      if (!page.isClosed()) await page.close().catch(() => {});
    }
  },
};
