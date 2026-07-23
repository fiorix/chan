// Rich Prompt over a terminal: paste an image as the FIRST action, then
// submit with Ctrl+Enter. The pasted atom is ring-selected, and the image
// widget's document-level listener treats a bubbling Mod-Enter as the View
// chord, so one press used to submit AND open the fullscreen image zoom.
// The submit binding now consumes the chord; the guard asserts the prompt
// submits (composer enters pending/cleared state) while the zoom overlay
// never appears. The file-editor View chord is jsdom-covered separately.

const RED_DOT_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

export default {
  name: "rich-prompt-paste-submit",
  async run(ctx) {
    const { page } = ctx;
    await page.bringToFront();

    await page.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent("chan:command", { detail: { name: "app.terminal.toggle" } }),
      );
    });
    await page.waitForSelector(".terminal-tab", { timeout: 30_000 });
    // Give the PTY a moment so the submit lands on a live session.
    await new Promise((r) => setTimeout(r, 2500));

    await page.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent("chan:command", { detail: { name: "terminal.richPrompt" } }),
      );
    });
    await page.waitForSelector(".rich-prompt .cm-content", { timeout: 15_000 });
    await page.waitForFunction(
      () => document.activeElement?.closest?.(".rich-prompt") != null,
      { timeout: 10_000 },
    );

    // First action: paste. The handler reads clipboardData.items, so a
    // synthetic ClipboardEvent carrying a DataTransfer File is faithful.
    await page.evaluate((b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const file = new File([bytes], "red-dot.png", { type: "image/png" });
      const dt = new DataTransfer();
      dt.items.add(file);
      document.querySelector(".rich-prompt .cm-content")?.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }),
      );
    }, RED_DOT_PNG_B64);
    await page.waitForSelector(".rich-prompt .cm-md-image-wrap", { timeout: 15_000 });
    await new Promise((r) => setTimeout(r, 600));

    const ring = await page.evaluate(
      () =>
        document.querySelector(".rich-prompt .cm-md-image-wrap")?.dataset.selected === "true",
    );
    if (!ring) throw new Error("pasted image did not ring-select; repro precondition lost");

    await page.keyboard.down("Control");
    await page.keyboard.press("Enter");
    await page.keyboard.up("Control");

    // The zoom used to open within one frame of the chord; watch a fat
    // window and simultaneously wait for evidence the submit happened.
    const t0 = Date.now();
    let submitted = false;
    while (Date.now() - t0 < 8_000) {
      const state = await page.evaluate(() => ({
        zoom: !!document.querySelector(".md-image-zoom"),
        composerText:
          document.querySelector(".rich-prompt .cm-content")?.textContent ?? null,
        promptGone: !document.querySelector(".rich-prompt"),
      }));
      if (state.zoom) {
        await ctx.shot("zoom-takeover");
        throw new Error("submit chord opened the image zoom overlay");
      }
      // Submit evidence: the composer cleared (draft delivered) or the
      // prompt reports a queued/pending state or closed entirely.
      if (state.promptGone || state.composerText === "" || state.composerText === "\n") {
        submitted = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    if (!submitted) {
      await ctx.shot("no-submit");
      throw new Error("prompt did not submit after the chord");
    }
    // A last look after the submit settled: the overlay must still be
    // absent (it used to appear in the same press).
    await new Promise((r) => setTimeout(r, 1000));
    const zoomLate = await page.evaluate(() => !!document.querySelector(".md-image-zoom"));
    if (zoomLate) {
      await ctx.shot("zoom-late");
      throw new Error("image zoom appeared after the submit settled");
    }

    // Restore the shared page: the prompt overlay and the terminal tab
    // must not leak into later checks (a lingering prompt editor is a
    // second .cm-content that steals their clicks).
    if (await page.$(".rich-prompt")) {
      await page.keyboard.press("Escape");
      await page
        .waitForFunction(() => !document.querySelector(".rich-prompt"), { timeout: 5_000 })
        .catch(() => {});
    }
    await page.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent("chan:command", { detail: { name: "app.tab.close" } }),
      );
    });
    // Closing a live terminal raises a "still running, close anyway?"
    // confirm; accept it so the tab actually goes away.
    const confirmOk = await page
      .waitForSelector('[role="dialog"] button.ok', { timeout: 5_000 })
      .catch(() => null);
    if (confirmOk) await confirmOk.click();
    await page
      .waitForFunction(() => !document.querySelector(".terminal-tab"), { timeout: 10_000 })
      .catch(() => {});
    return { submitted: true };
  },
};
