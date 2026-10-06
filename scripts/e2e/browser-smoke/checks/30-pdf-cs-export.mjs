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
    const evidence = {
      document: null, deckA: null, deckB: null, exports: [],
      uploads: { [windowA]: [], [WINDOW_B]: [] },
    };
    let pageB = null;
    const watch = (page, id) => page.on("request", (request) => {
      if (request.method() === "POST" &&
          new URL(request.url()).pathname === "/api/fs/upload") {
        evidence.uploads[id].push(Date.now());
      }
    });
    watch(ctx.page, windowA);

    async function exportPdf(source, output, windowId) {
      const started = Date.now();
      const leg = { source, output, windowId, startedAt: new Date(started).toISOString() };
      evidence.exports.push(leg);
      ctx.mark("export:start", { source, output, windowId });
      try {
        let result;
        try {
          result = await ctx.exec(
            ctx.chanBin,
            source === "doc.md"
              ? ["shell", "export", source]
              : ["shell", "export", source, "--out", output],
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
        const actual = /^export rendered in window (\S+)$/m.exec(stderr)?.[1] ?? "unknown";
        if (actual !== windowId) {
          const kind = source === "doc.md" ? "document" : "deck";
          throw new Error(`${kind} export rendered in ${actual}, not the caller's ${windowId}; stderr=${stderr}`);
        }
        const bytes = await ctx.pollFile(join(ctx.workspaceDir, output), 90_000);
        leg.status = "complete";
        return { bytes, stdout, stderr, durationMs: Date.now() - started };
      } catch (error) {
        leg.status = "failed";
        leg.error = error.message;
        throw error;
      } finally {
        leg.durationMs = Date.now() - started;
        leg.uploadCount = evidence.uploads[windowId].length;
        ctx.mark("export:finish", { ...leg });
      }
    }

    try {
      const document = await exportPdf("doc.md", "doc.pdf", windowA);
      evidence.document = { stdout: document.stdout, stderr: document.stderr, durationMs: document.durationMs };
      const { PDFDocument } = await import("pdf-lib");
      const count = (await PDFDocument.load(document.bytes)).getPageCount();
      assert(count >= 2, `doc.pdf: expected >=2 pages, got ${count}`);
      const documentPages = await ctx.assertPdf(document.bytes, {
        pages: count,
        orientation: "portrait",
      });
      evidence.document.pages = documentPages;
      await ctx.shot("cs-exported");

      pageB = await ctx.browser.newPage();
      await pageB.goto(`${ctx.serverUrl}&w=${WINDOW_B}`, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await pageB.waitForSelector(".pane", { timeout: 30_000 });
      await ctx.waitWindowLive(WINDOW_B);

      watch(pageB, WINDOW_B);

      async function deckLeg(output, caller) {
        assert(!existsSync(join(ctx.workspaceDir, output)), `${output} already exists`);
        const beforeA = evidence.uploads[windowA].length;
        const beforeB = evidence.uploads[WINDOW_B].length;
        const exported = await exportPdf("deck-169.md", output, caller);
        const afterA = evidence.uploads[windowA].length - beforeA;
        const afterB = evidence.uploads[WINDOW_B].length - beforeB;
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
      evidence.deckA = deckA;
      const deckB = await deckLeg("smoke-30-deck-b.pdf", WINDOW_B);
      evidence.deckB = deckB;
      return {
        document: evidence.document,
        deckA,
        deckB,
      };
    } catch (error) {
      error.smokeDetails = {
        ...evidence,
        pages: [
          await ctx.capturePage(ctx.page, "export-runner"),
          ...(pageB && !pageB.isClosed() ? [await ctx.capturePage(pageB, "export-second")] : []),
        ],
      };
      throw error;
    } finally {
      if (pageB && !pageB.isClosed()) await pageB.close().catch(() => {});
    }
  },
};
