// `cs export` end to end. The real CLI (cs is a
// chan symlink, so `chan shell export` is the same code path) sends
// the Export control request; the server pushes the export-job
// window_command to the live browser window; the SPA renders, uploads
// the PDF into the workspace, and replies. Asserts the workspace file.
//
// Skips (does not fail) when the `cs export` subcommand is absent, so
// the harness stays green-runnable against a build without it.

import { join } from "node:path";

export default {
  name: "pdf-cs-export",
  async run(ctx) {
    const socket = ctx.controlSocket;
    if (!socket) ctx.skip("control socket not found for the server pid");

    // The window id rides the workspace URL (?w=...); export targets
    // the most recently active live window server-side, but the cs
    // client refuses to run outside a chan terminal without these.
    const windowId = new URL(ctx.page.url()).searchParams.get("w") ?? "";

    let stdout = "";
    let stderr = "";
    try {
      // cwd matters: the CLI resolves <path> against the working
      // directory like it would inside a chan terminal.
      const res = await ctx.exec(ctx.chanBin, ["shell", "export", "doc.md"], {
        cwd: ctx.workspaceDir,
        env: {
          ...process.env,
          CHAN_CONTROL_SOCKET: socket,
          CHAN_WINDOW_ID: windowId,
        },
        timeout: 120_000,
      });
      stdout = res.stdout;
      stderr = res.stderr;
    } catch (e) {
      const text = `${e.stdout ?? ""}${e.stderr ?? ""}`;
      if (/unrecognized|unexpected|unknown|invalid.*export/i.test(text)) {
        ctx.skip(`cs export not available yet: ${text.split("\n")[0]}`);
      }
      throw new Error(`cs export failed: ${e.message}\n${text}`);
    }

    const out = join(ctx.workspaceDir, "doc.pdf");
    const bytes = await ctx.pollFile(out, 90_000);
    const { PDFDocument } = await import("pdf-lib");
    const count = (await PDFDocument.load(bytes)).getPageCount();
    if (count < 2) throw new Error(`doc.pdf: expected >=2 pages, got ${count}`);
    const summary = await ctx.assertPdf(bytes, {
      pages: count,
      orientation: "portrait",
    });
    await ctx.shot("cs-exported");
    return { stdout: stdout.trim(), stderr: stderr.trim(), pages: summary };
  },
};
