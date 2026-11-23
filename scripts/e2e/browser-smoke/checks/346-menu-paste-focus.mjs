// Proves that menu paste rechecks the active tab and focused pane after
// clipboard readText answers. Hold the native answer, switch tabs, then
// deliver it: the destination program gets the paste and the new holder
// keeps the keyboard, with no new DECSET 1004 report in either program.
// Chrome may refuse focus on a hidden tab even without the app guard. That
// leg is unavailable as regression proof; the visible other-pane leg and
// a public focus() control remain independent and keep their own verdicts.

import assert from "node:assert/strict";
import { installHeldClipboard, readHeldClipboard } from "../lib/terminal-focus-clipboard.mjs";
import { drainPointerInput, pointerInputSince } from "../lib/terminal-pointer.mjs";
import {
  assertKeyboard, clearFocus, clickTerminal, enableFocusReports,
  readFocus, runFocusCheck, settleFocus, waitFocus,
} from "../lib/terminal-focus.mjs";

async function selectTab(page, terminal) {
  await page.click(`.pane[data-pane-id="${terminal.row.pane}"] .tabs .tab[title="${terminal.name}"] > [role="tab"]`);
  await settleFocus(page);
  const reading = await readFocus(page, terminal.query);
  assertKeyboard(reading, "terminal");
  assert.equal(reading.terminal.tabActive, true);
}

async function menuPaste(page, terminal) {
  const point = await page.$eval(`${terminal.query} .terminal-host > canvas`, (canvas) => {
    const box = canvas.getBoundingClientRect();
    return { x: box.left + 20, y: box.top + 20 };
  });
  await page.mouse.click(point.x, point.y, { button: "right" });
  const menu = ".terminal-tab-menu-bubble";
  await page.waitForSelector(menu, { visible: true, timeout: 10_000 });
  for (const row of await page.$$(`${menu} button.mbtn`)) {
    const label = await row.$eval(".mbtn-label", (element) => element.textContent?.trim() ?? "");
    if (label !== "Paste") continue;
    await row.click();
    await page.waitForSelector(menu, { hidden: true, timeout: 10_000 });
    return;
  }
  assert.fail("the terminal menu has no Paste row");
}

export default {
  name: "menu-paste-focus",
  run(ctx) {
    return runFocusCheck(ctx, 346, async ({ page, shell, open, leg, restore }) => {
      const panes = async () => JSON.parse((await shell(["pane", "list", "--json"])).stdout);
      const initial = await panes();
      assert.equal(initial.panes.length, 1);
      await shell(["pane", "new", "right", "--pane", initial.panes[0].id]);
      const split = await waitFocus("two panes", panes, (read) => read.panes.length === 2);
      const left = split.panes.find((pane) => pane.id === initial.panes[0].id);
      const right = split.panes.find((pane) => pane.id !== initial.panes[0].id);
      assert.ok(left && right);
      const source = await open("source", ["--pane", left.id]);
      const samePane = await open("same-pane", ["--pane", left.id]);
      const otherPane = await open("other-pane", ["--pane", right.id]);
      for (const terminal of [source, samePane, otherPane]) await enableFocusReports(terminal);
      restore("restore clipboard reader", () => page.evaluate(() => window.__heldClipboard?.restore()));

      for (const [name, target, hidden] of [["same-pane-tab", samePane, true], ["other-pane-tab", otherPane, false]]) {
        await leg(name, async (result) => {
          try {
            await selectTab(page, source);
            const text = `paste-346-${name}`;
            await page.evaluate(async (text) => {
              await navigator.clipboard.writeText(text);
              if (await navigator.clipboard.readText() !== text) throw new Error("clipboard seed did not read back");
            }, text);
            result.instrument = await page.evaluate(installHeldClipboard);
            if (!result.instrument.available) {
              throw Object.assign(new Error(result.instrument.reason), { code: "FOCUS_UNAVAILABLE" });
            }
            const sourceBeforeRead = source.fixture.records.length;
            await menuPaste(page, source);
            result.held = await waitFocus("the native read is held before delivery", () => readHeldClipboard(page),
              (read) => read?.calls === 1 && read.nativeStatus === "fulfilled" && read.delivered === 0 && !read.released);
            assert.equal(pointerInputSince(source.fixture, sourceBeforeRead).includes(text), false, "the held paste has not arrived");
            if (hidden) await selectTab(page, target);
            else await clickTerminal(page, target.query);
            await drainPointerInput(source.fixture);
            await drainPointerInput(target.fixture);
            await clearFocus(page);
            result.before = { source: await readFocus(page, source.query), target: await readFocus(page, target.query) };
            assertKeyboard(result.before.target, "terminal");
            assert.equal(result.before.target.terminal.paneFocused, true);
            assert.equal(result.before.source.terminal.containsFocus, false);
            assert.equal(result.before.source.terminal.tabActive, !hidden);
            const sourceIndex = source.fixture.records.length, targetIndex = target.fixture.records.length;
            await page.evaluate(() => window.__heldClipboard.release());
            await source.fixture.waitFor(() => pointerInputSince(source.fixture, sourceIndex).includes(text));
            await settleFocus(page);
            result.sourceReceipt = await drainPointerInput(source.fixture, "", sourceIndex);
            result.targetReceipt = await drainPointerInput(target.fixture, "", targetIndex);
            result.delivered = await readHeldClipboard(page);
            result.after = { source: await readFocus(page, source.query), target: await readFocus(page, target.query) };
            assert.equal(result.delivered.calls, 1);
            assert.equal(result.delivered.delivered, 1, "the clipboard answer is delivered once");
            assert.equal(result.sourceReceipt.input, text, "the original program receives exactly the paste and no focus report");
            assert.equal(result.targetReceipt.input, "", "the current program receives no paste or focus report");
            assertKeyboard(result.after.target, "terminal");
            assert.deepEqual(result.after.target.active, result.before.target.active, "the same element keeps the keyboard");
            assert.equal(result.after.source.terminal.textareaFocused, false);
            assert.equal(result.after.source.terminal.containsFocus, false);
            assert.deepEqual(result.after.source.events.filter((event) => event.type === "focusin" && event.target.tab === source.row.tab), [],
              "the delayed paste never takes the keyboard, even transiently");
            result.behaviorPassed = true;
            if (hidden) {
              // This is an instrument control after the measured callback,
              // not a substitute for the user's tab switch or app behavior.
              const index = source.fixture.records.length;
              await source.term.evaluate((terminal) => terminal.focus());
              await settleFocus(page);
              result.chromeControl = { focus: await readFocus(page, source.query), receipt: await drainPointerInput(source.fixture, "", index) };
              if (!result.chromeControl.focus.terminal.containsFocus) {
                throw Object.assign(new Error("Chrome refuses public focus() on the hidden source; same-pane DOM/PTY readings cannot distinguish the late-focus guard"),
                  { code: "FOCUS_UNAVAILABLE" });
              }
              assert.equal(result.chromeControl.receipt.input, "\x1b[I", "the hidden-source control can expose a focus steal");
            }
          } finally {
            await page.evaluate(() => window.__heldClipboard?.restore());
          }
        });
      }
      await leg("visible-source-focus-control", async (result) => {
        await selectTab(page, source);
        await clickTerminal(page, otherPane.query);
        await drainPointerInput(source.fixture);
        await drainPointerInput(otherPane.fixture);
        const sourceIndex = source.fixture.records.length, targetIndex = otherPane.fixture.records.length;
        await clearFocus(page);
        await source.term.evaluate((terminal) => terminal.focus());
        await settleFocus(page);
        result.source = await readFocus(page, source.query);
        result.other = await readFocus(page, otherPane.query);
        result.sourceReceipt = await drainPointerInput(source.fixture, "", sourceIndex);
        result.targetReceipt = await drainPointerInput(otherPane.fixture, "", targetIndex);
        assertKeyboard(result.source, "terminal");
        assert.equal(result.sourceReceipt.input, "\x1b[I", "the visible source's public focus can steal the keyboard");
        assert.equal(result.targetReceipt.input, "\x1b[O", "the other program can observe the steal");
        await clickTerminal(page, otherPane.query);
      });
    });
  },
};
