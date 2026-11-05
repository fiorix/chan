// The auto-hide rule is judged per side. Three terminals on side A show the
// strip; sending the active one to side B turns the pane over to a side with
// one tab and no strip; flipping back to A, now with two, shows it; a second
// send leaves A with one and B with two, and the strip shows only while B is
// the visible side. Every flip is observed with the flip helper, since a
// reading taken mid-turn would be the leaving side's. Send to side is a
// registry command with no host-bus case, so it runs from the launcher as a
// user runs it; the flips run from the bus.

import { armFlip, paneFlip } from "../lib/flip.mjs";
import {
  closeEveryTerminal,
  dispatchCommand,
  readPaneStrip,
  readPaneStripPreference,
  selectLauncherCommand,
  stripHidden,
  stripShown,
  waitPaneStrip,
  writePaneStripPreference,
} from "../lib/pane-strip.mjs";

function check(condition, message) {
  if (!condition) throw new Error(message);
}

export default {
  name: "pane-strip-auto-hide-sides",
  async run(ctx) {
    const { page } = ctx;
    const token = new URL(ctx.serverUrl).searchParams.get("t") ?? "";
    await page.waitForSelector(".pane .tabs", { timeout: 30_000 });
    const paneId = await page.$eval(".pane", (pane) => pane.getAttribute("data-pane-id"));
    check(paneId, "the pane has no data-pane-id");
    const original = await readPaneStripPreference(page, token);
    check(!original.on, `the suite's server starts with pane_strip_auto_hide on: ${JSON.stringify(original)}`);
    const start = await readPaneStrip(page);
    check(start.tabs.length === 0 && start.side === "A", `the check needs an empty pane on side A; it holds ${JSON.stringify(start)}`);

    // A turn of the pane, then a reading taken once it has settled. The
    // observer is armed after the launcher's typing and before the run.
    async function turn(label, command, expect) {
      const fromLauncher = command === "app.tab.sendToB";
      if (fromLauncher) await selectLauncherCommand(page, "Send tab to side B");
      const flip = await armFlip(page, paneFlip(paneId));
      if (fromLauncher) await page.keyboard.press("Enter");
      else await dispatchCommand(page, command);
      await flip.settled(label);
      await flip.assertSettled(label);
      const state = await waitPaneStrip(page, label, expect);
      await ctx.shot(`201-${label.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`);
      return state;
    }

    try {
      await writePaneStripPreference(page, token, true);
      await waitPaneStrip(page, "the empty pane after the preference turned on", stripHidden);
      for (let n = 1; n <= 3; n++) {
        await dispatchCommand(page, "app.terminal.toggle");
        await waitPaneStrip(page, `terminal ${n}`, (s) => s.terminals === n && s.tabs.length === n);
      }
      const three = await waitPaneStrip(page, "three terminals on A", (s) => s.side === "A" && s.tabs.length === 3 && stripShown(s));
      await ctx.shot("201-three-on-a");

      const bOne = await turn("send one to B", "app.tab.sendToB",
        (s) => s.side === "B" && s.tabs.length === 1 && stripHidden(s));
      const aTwo = await turn("back to A with two", "app.pane.flip",
        (s) => s.side === "A" && s.tabs.length === 2 && stripShown(s));
      const bTwo = await turn("send another to B", "app.tab.sendToB",
        (s) => s.side === "B" && s.tabs.length === 2 && stripShown(s));
      const aOne = await turn("A with one", "app.pane.flip",
        (s) => s.side === "A" && s.tabs.length === 1 && stripHidden(s));
      const bTwoAgain = await turn("B with two again", "app.pane.flip",
        (s) => s.side === "B" && s.tabs.length === 2 && stripShown(s));
      check(bTwoAgain.terminals === 3, `the pane should still mount three terminals; it holds ${JSON.stringify(bTwoAgain)}`);
      return { three, bOne, aTwo, bTwo, aOne, bTwoAgain };
    } finally {
      await closeEveryTerminal(page, "cleanup", token).catch(() => {});
      await writePaneStripPreference(page, token, original.on);
    }
  },
};
