// `cs export` end to end. The CLI sends the Export control request, a live
// browser window renders and uploads the PDF, and the CLI names that window.
// The document leg exercises the runner's window. The deck legs hold a second
// live window open and prove that each explicit caller renders its own export.

import { existsSync } from "node:fs";
import { join } from "node:path";

const WINDOW_B = "smoke-check-30-b";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export default {
  name: "pdf-cs-export",
  async run(ctx) {
    const socket = ctx.controlSocket;
    if (!socket) ctx.skip("control socket not found for the server pid");
    const windowA = new URL(ctx.page.url()).searchParams.get("w") ?? "";
    assert(windowA === "smoke-check-30", `unexpected runner window ${windowA}`);

    async function exportPdf(source, output, windowId) {
      const started = Date.now();
      let result;
      try {
        result = await ctx.exec(
          ctx.chanBin,
          ["shell", "export", source, "--out", output],
          {
            cwd: ctx.workspaceDir,
            env: {
              ...process.env,
              CHAN_CONTROL_SOCKET: socket,
              CHAN_WINDOW_ID: windowId,
            },
            timeout: 120_000,
          },
        );
      } catch (error) {
        const outputText = `${error.stdout ?? ""}${error.stderr ?? ""}`;
        throw new Error(`cs export failed: ${error.message}\n${outputText}`);
      }
      const stdout = result.stdout.trim();
      const stderr = result.stderr.trim();
      assert(stdout === output, `${source}: stdout named ${stdout}, expected ${output}`);
      if (!stderr.includes(`export rendered in window ${windowId}`)) {
        const actual = /export rendered in window (\S+)/.exec(stderr)?.[1] ?? "unknown";
        throw new Error(`deck export rendered in ${actual}, not the caller's ${windowId}; stderr=${stderr}`);
      }
      const bytes = await ctx.pollFile(join(ctx.workspaceDir, output), 90_000);
      return { bytes, stdout, stderr, durationMs: Date.now() - started };
    }

    const document = await exportPdf("doc.md", "doc.pdf", windowA);
    const { PDFDocument } = await import("pdf-lib");
    const count = (await PDFDocument.load(document.bytes)).getPageCount();
    assert(count >= 2, `doc.pdf: expected >=2 pages, got ${count}`);
    const documentPages = await ctx.assertPdf(document.bytes, {
      pages: count,
      orientation: "portrait",
    });
    await ctx.shot("cs-exported");

    const pageB = await ctx.browser.newPage();
    try {
      await pageB.goto(`${ctx.serverUrl}&w=${WINDOW_B}`, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await pageB.waitForSelector(".pane", { timeout: 30_000 });
      await ctx.waitWindowLive(WINDOW_B);

      const uploads = { [windowA]: [], [WINDOW_B]: [] };
      const watch = (page, id) => page.on("request", (request) => {
        if (request.method() === "POST" &&
            new URL(request.url()).pathname === "/api/fs/upload") {
          uploads[id].push(Date.now());
        }
      });
      watch(ctx.page, windowA);
      watch(pageB, WINDOW_B);

      async function deckLeg(output, caller) {
        assert(!existsSync(join(ctx.workspaceDir, output)), `${output} already exists`);
        const beforeA = uploads[windowA].length;
        const beforeB = uploads[WINDOW_B].length;
        const exported = await exportPdf("deck-169.md", output, caller);
        const afterA = uploads[windowA].length - beforeA;
        const afterB = uploads[WINDOW_B].length - beforeB;
        assert(
          caller === windowA ? afterA > 0 : afterB > 0,
          caller === windowA
            ? "the runner's window did not upload the caller's export"
            : "the second window did not upload the caller's export",
        );
        assert(
          caller === windowA ? afterB === 0 : afterA === 0,
          caller === windowA
            ? "the second window uploaded the caller's export"
            : "the runner's window uploaded the second window's export",
        );
        const pages = await ctx.assertPdf(exported.bytes, {
          pages: 3,
          orientation: "landscape",
        });
        return { stdout: exported.stdout, stderr: exported.stderr, durationMs: exported.durationMs, pages, uploads: { runner: afterA, second: afterB } };
      }

      const deckA = await deckLeg("smoke-30-deck.pdf", windowA);
      const deckB = await deckLeg("smoke-30-deck-b.pdf", WINDOW_B);
      return {
        document: { stdout: document.stdout, stderr: document.stderr, durationMs: document.durationMs, pages: documentPages },
        deckA,
        deckB,
      };
    } finally {
      await pageB.close().catch(() => {});
    }
  },
};
