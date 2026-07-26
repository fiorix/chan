// Content REMOVAL through the filesystem, with an editor open on the
// file. The rest of the external-edit family only ever swaps
// equal-length markers, so nothing else in this suite proves that a
// file getting SHORTER reaches the editor at all.
//
// This is the shape an agent produces when it edits a file directly
// rather than through chan's MCP server: delete a line, drop a word,
// rewrite a section, sometimes empty the file outright, often in quick
// succession. Every one of those has to converge in the open tab
// within a bounded time and without needing a further filesystem
// event to shake it loose.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TS = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Convergence is normally sub-second; a truncation additionally waits
// out the corroboration delay that protects against a non-atomic
// replace being read mid-flight.
const BUDGET_MS = 8000;

const HEAD = `SHRINK-HEAD-${TS}`;
const BODY = [
  `alpha-${TS}`,
  `bravo-${TS}`,
  `charlie-${TS}`,
  `delta-${TS}`,
  `echo-${TS}`,
];
const full = () => [HEAD, ...BODY].join("\n") + "\n";

async function editorText(page) {
  return page.evaluate(() => {
    const el = document.querySelector(".cm-content");
    return el ? (el.textContent ?? "") : null;
  });
}

// Resolve once the editor text satisfies `predSrc` (a JS expression
// over `t`). Returns elapsed ms, or null if it never did.
async function waitEditor(page, predSrc, timeoutMs) {
  const t0 = Date.now();
  try {
    await page.waitForFunction(
      (src) => {
        const el = document.querySelector(".cm-content");
        if (!el) return false;
        return new Function("t", `return (${src})`)(el.textContent ?? "");
      },
      { timeout: timeoutMs, polling: 200 },
      predSrc,
    );
    return Date.now() - t0;
  } catch {
    return null;
  }
}

export default {
  name: "external-shrink-convergence",
  async run(ctx) {
    const socket = ctx.controlSocket;
    if (!socket) ctx.skip("control socket not found for the server pid");
    const { browser, serverUrl } = ctx;
    const token = new URL(serverUrl).searchParams.get("t");

    const file = "shrink.md";
    const writeDisk = (text) =>
      writeFileSync(join(ctx.workspaceDir, file), text);
    const disk = () => readFileSync(join(ctx.workspaceDir, file), "utf8");

    const page = await browser.newPage();
    try {
      writeDisk(full());
      await page.goto(`${serverUrl}&w=smoke-shrink`, {
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

      await page.bringToFront();
      await ctx.exec(ctx.chanBin, ["shell", "open", file], {
        cwd: ctx.workspaceDir,
        env,
        timeout: 30_000,
      });
      if ((await waitEditor(page, `t.includes("echo-${TS}")`, 30_000)) === null) {
        throw new Error("initial open did not show the seeded body");
      }
      await sleep(1500);

      const evidence = { steps: [] };
      const failures = [];
      const record = (step, ms, detail = {}) => {
        const ok = ms !== null;
        evidence.steps.push({ step, convergedMs: ms, ok, ...detail });
        console.log(
          `[smoke:63] ${step}: ${JSON.stringify({ convergedMs: ms, ok, ...detail })}`,
        );
        if (!ok) failures.push(step);
      };

      // 1. Partial shrink: drop a line that predates the open tab.
      writeDisk(
        [HEAD, ...BODY.filter((l) => !l.startsWith("charlie"))].join("\n") + "\n",
      );
      record("delete-line", await waitEditor(page, `!t.includes("charlie-${TS}")`, BUDGET_MS));

      // 2. Grow, then 3. shrink back to the exact prior bytes. The
      // restore is the case that regressed: it looks identical to
      // content the session already adopted.
      await sleep(500);
      const grown = [`${HEAD} EXTRA`, ...BODY.filter((l) => !l.startsWith("charlie"))]
        .join("\n") + "\n";
      writeDisk(grown);
      record("append-word", await waitEditor(page, `t.includes("EXTRA")`, BUDGET_MS));

      await sleep(500);
      writeDisk([HEAD, ...BODY.filter((l) => !l.startsWith("charlie"))].join("\n") + "\n");
      record("restore-prior-bytes", await waitEditor(page, `!t.includes("EXTRA")`, BUDGET_MS));

      // 4. Rapid alternation, the way an agent iterating on a file
      // looks. Each pass restores bytes seen moments earlier.
      let cycleMs = null;
      for (let i = 0; i < 3; i += 1) {
        const base = [HEAD, ...BODY.filter((l) => !l.startsWith("charlie"))].join("\n") + "\n";
        writeDisk(base.replace(HEAD, `${HEAD} CYCLE${i}`));
        if ((await waitEditor(page, `t.includes("CYCLE${i}")`, BUDGET_MS)) === null) {
          break;
        }
        writeDisk(base);
        cycleMs = await waitEditor(page, `!t.includes("CYCLE${i}")`, BUDGET_MS);
        if (cycleMs === null) break;
      }
      record("rapid-add-remove-cycles", cycleMs, { cycles: 3 });

      // 5. Truncate to empty. Suspicious enough to corroborate, not
      // suspicious enough to refuse.
      await sleep(500);
      writeDisk("");
      record(
        "truncate-to-empty",
        await waitEditor(page, `t.replace(/\\u200b/g, "").trim() === ""`, BUDGET_MS),
        { diskIsEmpty: disk() === "" },
      );

      // 6. Content written back after the truncation still lands.
      await sleep(500);
      writeDisk(`REFILL-${TS}\n`);
      record("refill-after-empty", await waitEditor(page, `t.includes("REFILL-${TS}")`, BUDGET_MS));

      const api = await apiRead();
      evidence.apiMatchesDisk = api.includes(`REFILL-${TS}`);
      if (!evidence.apiMatchesDisk) failures.push("api-read-stale");

      if (failures.length) {
        throw new Error(
          `external shrink did not converge: ${failures.join(", ")} :: ${JSON.stringify(evidence.steps)}`,
        );
      }
      return evidence;
    } finally {
      if (!page.isClosed()) await page.close().catch(() => {});
    }
  },
};
