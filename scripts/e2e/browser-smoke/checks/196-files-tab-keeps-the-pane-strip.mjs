// A Files tab beside a terminal tab must leave the pane's card with no
// scrollable overflow of its own: the folder list scrolls inside its
// scroller, and a focused or revealed row never moves the pane's tab strip.
// Read where a hidden strip comes from: the card's scrollHeight against its
// clientHeight, and the strip's top against the card's, before and after the
// list is focused, worked with the keyboard, and its last row revealed.

function check(condition, message) {
  if (!condition) throw new Error(message);
}

export default {
  name: "files-tab-keeps-the-pane-strip",
  async run(ctx) {
    const { page } = ctx;
    const command = (name) =>
      page.evaluate((n) => window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: n } })), name);
    const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const read = () =>
      page.evaluate(() => {
        const pane = document.querySelector(".pane");
        const face = pane?.querySelector(".pane-card-face");
        const tabs = pane?.querySelector(".tabs");
        if (!face || !tabs) return null;
        const f = face.getBoundingClientRect();
        const t = tabs.getBoundingClientRect();
        return {
          scrollHeight: face.scrollHeight,
          clientHeight: face.clientHeight,
          scrollTop: face.scrollTop,
          stripAtTop: Math.abs(t.top - f.top) <= 1,
          stripHeight: Math.round(t.height),
          tabs: [...tabs.querySelectorAll(".tab")].map((tab) => tab.getAttribute("title") || tab.textContent.trim()),
          rows: document.querySelectorAll(".pane .tree-wrap .directory-list > li").length,
        };
      });
    const assertFlat = (state, label) => {
      check(state, `${label}: no pane card or tab strip`);
      check(state.tabs.length === 2, `${label}: the strip lists ${JSON.stringify(state.tabs)}, not both tabs`);
      check(
        state.scrollHeight === state.clientHeight,
        `${label}: the pane card holds ${state.scrollHeight}px of scrollable content in ${state.clientHeight}px`,
      );
      check(state.scrollTop === 0, `${label}: the pane card is scrolled by ${state.scrollTop}px`);
      check(state.stripAtTop, `${label}: the tab strip is not at the pane card's top`);
    };

    await page.waitForSelector(".pane .tabs", { timeout: 30_000 });
    await command("app.terminal.toggle");
    await page.waitForSelector(".pane .terminal-tab", { timeout: 30_000 });
    await command("app.files.toggle");
    await page.waitForSelector(".pane .tree-wrap .directory-list > li", { timeout: 30_000 });
    await pause(500);
    const opened = await read();
    assertFlat(opened, "Files tab open");
    check(opened.rows > 10, `the seed folder lists ${opened.rows} rows; the probe needs a list taller than its scroller`);

    // Focus the list through a row, walk it, reveal its last row.
    const row = await page.$(".pane .tree-wrap .directory-list > li .row, .pane .tree-wrap .directory-list > li button");
    check(row, "no row to click in the folder list");
    await row.click();
    for (const key of ["ArrowDown", "ArrowDown", "End", "ArrowUp", "Home", "End"]) {
      await page.keyboard.press(key);
      await pause(120);
    }
    await page.evaluate(() => {
      const rows = document.querySelectorAll(".pane .tree-wrap .directory-list > li");
      const last = rows[rows.length - 1];
      last?.scrollIntoView({ block: "nearest" });
      last?.querySelector("button, [tabindex]")?.focus?.();
    });
    await pause(300);
    const worked = await read();
    assertFlat(worked, "after focusing and walking the list");
    await ctx.shot("files-tab-with-strip", page);
  },
};
