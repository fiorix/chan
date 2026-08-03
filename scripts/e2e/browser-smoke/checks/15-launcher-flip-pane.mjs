// The Command Launcher must close itself before dispatching Flip pane. The
// pane command refuses to run while another overlay is on top, so stale
// launcher stack state leaves the visible Hybrid side unchanged.

const LAUNCHER_SELECTOR = '[role="dialog"][aria-label="Command launcher"]';
const LAUNCHER_INPUT_SELECTOR = `${LAUNCHER_SELECTOR} input[role="combobox"]`;
const SELECTED_TITLE_SELECTOR = `${LAUNCHER_SELECTOR} [role="option"][aria-selected="true"] .deck-result-title`;

async function dispatchCommand(page, name) {
  await page.evaluate((commandName) => {
    window.dispatchEvent(
      new CustomEvent("chan:command", { detail: { name: commandName } }),
    );
  }, name);
}

async function paneState(page, paneId) {
  return page.$eval(`.pane[data-pane-id="${paneId}"]`, (pane) => {
    const toggle = pane.querySelector(".side-toggle");
    if (!toggle) throw new Error("target pane has no side toggle");
    return {
      side: toggle.textContent?.trim() ?? "",
      title: toggle.getAttribute("title") ?? "",
      cardSide: pane.querySelector(".pane-card-inner")?.getAttribute("data-side-label") ?? "",
      tabs: [...pane.querySelectorAll('[role="tab"] .path')].map(
        (tab) => tab.textContent?.trim() ?? "",
      ),
    };
  });
}

async function waitForSide(page, paneId, side) {
  try {
    await page.waitForFunction(
      (id, wanted) =>
        document
          .querySelector(`.pane[data-pane-id="${id}"] .side-toggle`)
          ?.textContent?.trim() === wanted,
      { timeout: 10_000 },
      paneId,
      side,
    );
  } catch (cause) {
    const actual = await page
      .$eval(
        `.pane[data-pane-id="${paneId}"] .side-toggle`,
        (toggle) => toggle.textContent?.trim() ?? "empty",
      )
      .catch(() => "missing");
    throw new Error(`pane ${paneId} stayed on side ${actual}, expected ${side}`, { cause });
  }
}

async function waitForFlipSettle(page, paneId) {
  await page.waitForFunction(
    (id) =>
      !document.querySelector(`.pane[data-pane-id="${id}"].sideFlipActive`),
    { timeout: 10_000 },
    paneId,
  );
}

export default {
  name: "launcher-flip-pane",
  async run(ctx) {
    const { page } = ctx;
    await page.bringToFront();
    const paneId = await page.$eval(".pane", (pane) => pane.getAttribute("data-pane-id"));
    if (!paneId) throw new Error("pane has no data-pane-id");
    const pane = `.pane[data-pane-id="${paneId}"]`;

    // The opposite side is created through the same user path as the pane
    // chrome: select empty B, then spawn ordinary content into the visible
    // side. No test-only layout state is injected.
    await page.click(`${pane} .side-toggle`);
    await waitForSide(page, paneId, "B");
    await waitForFlipSettle(page, paneId);
    await dispatchCommand(page, "app.dashboard.open");
    await page.waitForFunction(
      (id) =>
        document.querySelectorAll(`.pane[data-pane-id="${id}"] [role="tab"]`).length > 0,
      { timeout: 10_000 },
      paneId,
    );
    const sideB = await paneState(page, paneId);
    if (!sideB.title.startsWith("Flip to side A")) {
      throw new Error(`unexpected B-side toggle title: ${sideB.title}`);
    }
    if (JSON.stringify(sideB.tabs) !== JSON.stringify(["Dashboard"])) {
      throw new Error(`B side was not seeded with Dashboard: ${JSON.stringify(sideB.tabs)}`);
    }

    await page.click(`${pane} .side-toggle`);
    await waitForSide(page, paneId, "A");
    await waitForFlipSettle(page, paneId);
    const sideA = await paneState(page, paneId);
    if (sideA.cardSide !== "A" || !sideA.title.startsWith("Flip to side B")) {
      throw new Error(`pane did not return to side A: ${JSON.stringify(sideA)}`);
    }
    await ctx.shot("side-a-ready");

    // Open the real Command Launcher through the host command bus, type the
    // exact command title, and prove that the selected row is Flip pane before
    // Enter dispatches it.
    await dispatchCommand(page, "app.launcher.toggle");
    await page.waitForSelector(LAUNCHER_INPUT_SELECTOR, { timeout: 10_000 });
    await page.type(LAUNCHER_INPUT_SELECTOR, "Flip pane");
    await page.waitForFunction(
      (selector) => document.querySelector(selector)?.textContent?.trim() === "Flip pane",
      { timeout: 10_000 },
      SELECTED_TITLE_SELECTOR,
    );
    await ctx.shot("launcher-selected");
    await page.keyboard.press("Enter");

    await waitForSide(page, paneId, "B");
    await waitForFlipSettle(page, paneId);
    const flipped = await paneState(page, paneId);
    if (flipped.cardSide !== "B") {
      throw new Error(`pane card still shows side ${flipped.cardSide}, expected B`);
    }
    if (!flipped.title.startsWith("Flip to side A")) {
      throw new Error(`unexpected flipped toggle title: ${flipped.title}`);
    }
    if (JSON.stringify(flipped.tabs) !== JSON.stringify(sideB.tabs)) {
      throw new Error(
        `visible B tabs changed: before=${JSON.stringify(sideB.tabs)} after=${JSON.stringify(flipped.tabs)}`,
      );
    }
    await ctx.shot("flipped-to-b");

    return {
      before: sideA,
      after: flipped,
    };
  },
};
