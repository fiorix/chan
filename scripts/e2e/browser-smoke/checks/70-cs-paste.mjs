// Item 2: `cs paste` end to end against the live browser window.
//
// Grant path: CDP grants clipboard permissions to the server origin, the
// page seeds its own clipboard, and the REAL cs client (chan shell paste)
// round-trips: control socket -> clipboard_read window command -> the
// SPA's single-access web read -> /api/window/reply -> raw bytes on the
// CLI's stdout (mime on stderr), exit 0.
//
// Deny path: clipboard-read is set to "denied" explicitly (CDP
// Browser.setPermission), so the browser rejects the unprompted read FAST
// (no floating button, so the SPA's 800ms paste-card threshold never
// trips): the CLI must exit nonzero QUICKLY with the hinted "clipboard
// access denied" message - never sit out the server's 30s reply window
// (exit 124), which is the wedged-look this item fixes. The paste card +
// Cancel proof is vitest's (state/pasteRequest.test.ts). Do not rely on a
// permissions reset here: Chrome 138 headless leaves the read PENDING at
// "prompt" (the paste-card path a user answers), which is not a denial and
// only proves the 30s bound.

const SEEDED_TEXT = "chan smoke clipboard payload 70";

export default {
  name: "cs-paste",
  async run(ctx) {
    const socket = ctx.controlSocket;
    if (!socket) ctx.skip("control socket not found for the server pid");
    const { page } = ctx;
    await page.bringToFront();
    // The SPA's own window id: `?w=` when the URL carries one, else the
    // per-tab sessionStorage id (`sessionWindowId()`'s exact precedence).
    // Reading only the URL breaks once an earlier check rewrites it.
    const windowId = await page.evaluate(
      () =>
        new URL(location.href).searchParams.get("w")?.trim() ||
        window.sessionStorage.getItem("chan.session.window")?.trim() ||
        "",
    );
    if (!windowId) throw new Error("could not resolve the page's window id");
    const origin = new URL(ctx.serverUrl).origin;
    const env = {
      ...process.env,
      CHAN_CONTROL_SOCKET: socket,
      CHAN_WINDOW_ID: windowId,
    };

    // ---- grant path ----
    const cdp = await page.createCDPSession();
    await cdp.send("Browser.grantPermissions", {
      origin,
      permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
    });
    await page.evaluate(
      (text) => navigator.clipboard.writeText(text),
      SEEDED_TEXT,
    );

    const granted = await ctx.exec(ctx.chanBin, ["shell", "paste"], {
      cwd: ctx.workspaceDir,
      env,
      timeout: 60_000,
    });
    if (granted.stdout !== SEEDED_TEXT) {
      throw new Error(
        `cs paste stdout mismatch: ${JSON.stringify(granted.stdout)}`,
      );
    }
    if (!/text\/plain/.test(granted.stderr)) {
      throw new Error(`cs paste stderr carries no mime: ${granted.stderr}`);
    }
    await ctx.shot("granted");

    // ---- deny path ----
    await cdp.send("Browser.setPermission", {
      origin,
      permission: { name: "clipboard-read" },
      setting: "denied",
    });
    const t0 = Date.now();
    let denied = null;
    try {
      await ctx.exec(ctx.chanBin, ["shell", "paste"], {
        cwd: ctx.workspaceDir,
        env,
        timeout: 60_000,
      });
    } catch (e) {
      denied = e;
    }
    const deniedMs = Date.now() - t0;
    if (!denied) throw new Error("cs paste succeeded after permissions reset");
    if (denied.code === 124) {
      throw new Error(
        "cs paste hit the 30s reply timeout (124) instead of a fast denial",
      );
    }
    const text = `${denied.stdout ?? ""}${denied.stderr ?? ""}`;
    if (!/clipboard access denied/i.test(text)) {
      throw new Error(`denial message missing the hint: ${text}`);
    }
    // "Fast" = the browser rejected the read; well under the server's 30s
    // bound (generous margin for a loaded machine).
    if (deniedMs > 15_000) {
      throw new Error(`denial took ${deniedMs}ms; expected a fast rejection`);
    }
    await ctx.shot("denied");

    // Restore the grant so later checks inherit a permissive page.
    await cdp.send("Browser.grantPermissions", {
      origin,
      permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
    });
    await cdp.detach().catch(() => {});
    return { deniedMs, deniedExit: denied.code ?? null };
  },
};
