// The auto-hide preference in a workspace window. Off, an empty pane shows
// its strip as it always has. On, the strip is hidden while the visible side
// holds fewer than two tabs: the empty pane keeps its welcome with no strip
// above it, the first terminal still has none, the second brings the strip
// with both tabs, and closing one takes it away again. The preference is
// changed live through PATCH /api/config, so the page must follow it without
// a reload, and is restored to what the check found.

import {
  closeActiveTerminal,
  closeEveryTerminal,
  dispatchCommand,
  readPaneStrip,
  readPaneStripPreference,
  stripHidden,
  stripShown,
  waitPaneStrip,
  writePaneStripPreference,
} from "../lib/pane-strip.mjs";

function check(condition, message) {
  if (!condition) throw new Error(message);
}

export default {
  name: "pane-strip-auto-hide",
  async run(ctx) {
    const { page } = ctx;
    const token = new URL(ctx.serverUrl).searchParams.get("t") ?? "";
    await page.waitForSelector(".pane .tabs", { timeout: 30_000 });
    const original = await readPaneStripPreference(page, token);
    check(!original.on, `the suite's server starts with pane_strip_auto_hide on: ${JSON.stringify(original)}`);

    // Today's window: an empty pane with its strip painted above the welcome.
    const before = await waitPaneStrip(page, "the empty pane with the preference off", (s) => stripShown(s) && s.welcome);
    check(before.tabs.length === 0, `the check needs an empty pane; the strip lists ${JSON.stringify(before.tabs)}`);
    await ctx.shot("200-off-empty");

    try {
      await writePaneStripPreference(page, token, true);
      const hiddenEmpty = await waitPaneStrip(page, "the empty pane after the preference turned on", stripHidden);
      check(hiddenEmpty.welcome, `the empty pane lost its welcome when the strip hid: ${JSON.stringify(hiddenEmpty)}`);
      check(hiddenEmpty.tabs.length === 0, `the hidden strip lists tabs: ${JSON.stringify(hiddenEmpty.tabs)}`);
      await ctx.shot("200-on-empty");

      await dispatchCommand(page, "app.terminal.toggle");
      const one = await waitPaneStrip(page, "one terminal", (s) => s.terminals === 1 && s.tabs.length === 1);
      check(stripHidden(one), `a lone terminal still shows the strip: ${JSON.stringify(one)}`);
      await ctx.shot("200-on-one-terminal");

      await dispatchCommand(page, "app.terminal.toggle");
      const two = await waitPaneStrip(page, "two terminals", (s) => s.terminals === 2 && s.tabs.length === 2 && stripShown(s));
      await ctx.shot("200-on-two-terminals");

      const back = await closeActiveTerminal(page, "closing one of the two terminals");
      const oneAgain = await waitPaneStrip(page, "back to one terminal", (s) => s.terminals === 1 && s.tabs.length === 1 && stripHidden(s));
      await ctx.shot("200-on-back-to-one");

      // Off again: the lone terminal gets its strip back without a reload.
      await writePaneStripPreference(page, token, false);
      const restored = await waitPaneStrip(page, "the lone terminal after the preference turned off", (s) => s.tabs.length === 1 && stripShown(s));
      await ctx.shot("200-off-one-terminal");

      await closeEveryTerminal(page, "cleanup");
      const emptyAgain = await waitPaneStrip(page, "the emptied pane", (s) => s.terminals === 0 && stripShown(s) && s.welcome);
      return { before, hiddenEmpty, one, two, back, oneAgain, restored, emptyAgain };
    } finally {
      await writePaneStripPreference(page, token, original.on);
      await closeEveryTerminal(page, "final cleanup").catch(() => {});
    }
  },
};
