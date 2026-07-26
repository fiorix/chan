// Whole-Hybrid tab rotation and empty-side close behavior.
//
// A dedicated split keeps this check independent of the pane state left by
// earlier checks. Side A and side B each receive two distinct tabs. Next and
// previous must traverse side A's tab order followed by side B's tab order,
// with one visit per tab and full-order wrapping. Closing an empty visible
// side must reveal the populated opposite side and flash its A/B toggle.

async function dispatchCommand(page, name) {
  await page.evaluate((commandName) => {
    window.dispatchEvent(
      new CustomEvent("chan:command", { detail: { name: commandName } }),
    );
  }, name);
}

function paneSelector(paneId) {
  return `.pane[data-pane-id="${paneId}"]`;
}

function tabSelector(paneId) {
  return `${paneSelector(paneId)} > .pane-card > .pane-card-inner > .pane-card-face > .tabs > [role="tab"]`;
}

async function settle(page) {
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      }),
  );
}

async function paneState(page, paneId) {
  return page.$eval(paneSelector(paneId), (pane) => {
    const toggle = pane.querySelector(".side-toggle");
    if (!toggle) throw new Error("target pane has no side toggle");
    const tabs = [
      ...pane.querySelectorAll(
        ":scope > .pane-card > .pane-card-inner > .pane-card-face > .tabs > [role='tab']",
      ),
    ];
    const activeIndex = tabs.findIndex(
      (tab) => tab.getAttribute("aria-selected") === "true",
    );
    return {
      side: toggle.textContent?.trim() ?? "",
      tabs: tabs.map((tab) => tab.querySelector(".path")?.textContent?.trim() ?? ""),
      activeIndex,
      flash: toggle.classList.contains("side-toggle-flash"),
    };
  });
}

async function waitForSide(page, paneId, side) {
  await page.waitForFunction(
    (id, wanted) =>
      document
        .querySelector(`.pane[data-pane-id="${id}"] .side-toggle`)
        ?.textContent?.trim() === wanted,
    { timeout: 10_000 },
    paneId,
    side,
  );
}

async function waitForTabCount(page, paneId, count) {
  await page.waitForFunction(
    (id, wanted) =>
      document.querySelectorAll(
        `.pane[data-pane-id="${id}"] > .pane-card > .pane-card-inner > .pane-card-face > .tabs > [role="tab"]`,
      ).length === wanted,
    { timeout: 10_000 },
    paneId,
    count,
  );
}

async function ensureSide(page, paneId, side) {
  const state = await paneState(page, paneId);
  if (state.side === side) return;
  await page.click(`${paneSelector(paneId)} .side-toggle`);
  await waitForSide(page, paneId, side);
  await settle(page);
}

async function selectVisibleTab(page, paneId, index) {
  const tabs = await page.$$(tabSelector(paneId));
  const target = tabs[index];
  if (!target) throw new Error(`pane ${paneId} has no visible tab at index ${index}`);
  await target.click();
  await settle(page);
}

async function closeVisibleTab(page, paneId) {
  const before = (await paneState(page, paneId)).tabs.length;
  await dispatchCommand(page, "app.tab.close");
  await waitForTabCount(page, paneId, before - 1);
  await settle(page);
}

function expectedRotation(entries, start, delta) {
  return entries.map((_, step) => {
    const index = (start + delta * (step + 1) + entries.length * 2) % entries.length;
    return entries[index];
  });
}

function compareRotation(failures, label, actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures.push(
      `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

export default {
  name: "tab-rotation-pane-flip",
  async run(ctx) {
    const { page } = ctx;
    const failures = [];
    const originalPaneIds = await page.$$eval(".pane", (panes) =>
      panes.map((pane) => pane.getAttribute("data-pane-id")).filter(Boolean),
    );

    await dispatchCommand(page, "app.pane.splitRight");
    await page.waitForFunction(
      (count) => document.querySelectorAll(".pane").length === count + 1,
      { timeout: 10_000 },
      originalPaneIds.length,
    );
    const paneId = await page.$$eval(
      ".pane",
      (panes, prior) =>
        panes
          .map((pane) => pane.getAttribute("data-pane-id"))
          .find((id) => id && !prior.includes(id)) ?? null,
      originalPaneIds,
    );
    if (!paneId) throw new Error("split did not expose a new pane id");

    await dispatchCommand(page, "app.files.toggle");
    await waitForTabCount(page, paneId, 1);
    await dispatchCommand(page, "app.dashboard.open");
    await waitForTabCount(page, paneId, 2);
    const sideA = await paneState(page, paneId);

    await page.click(`${paneSelector(paneId)} .side-toggle`);
    await waitForSide(page, paneId, "B");
    await settle(page);
    await dispatchCommand(page, "app.graph.toggle");
    await waitForTabCount(page, paneId, 1);
    await dispatchCommand(page, "app.files.toggle");
    await waitForTabCount(page, paneId, 2);
    const sideB = await paneState(page, paneId);

    const ordered = [
      ...sideA.tabs.map((_, activeIndex) => ({ side: "A", activeIndex })),
      ...sideB.tabs.map((_, activeIndex) => ({ side: "B", activeIndex })),
    ];
    if (ordered.length !== 4) {
      throw new Error(`tab seeding did not produce four tabs: ${JSON.stringify(ordered)}`);
    }

    await ensureSide(page, paneId, "A");
    await selectVisibleTab(page, paneId, sideA.tabs.length - 1);
    const start = sideA.tabs.length - 1;
    const nextActual = [];
    for (let step = 0; step < ordered.length; step += 1) {
      await dispatchCommand(page, "app.tab.next");
      await settle(page);
      const state = await paneState(page, paneId);
      nextActual.push({ side: state.side, activeIndex: state.activeIndex });
    }
    const nextExpected = expectedRotation(ordered, start, 1);
    compareRotation(failures, "next rotation", nextActual, nextExpected);

    await ensureSide(page, paneId, "A");
    await selectVisibleTab(page, paneId, sideA.tabs.length - 1);
    const prevActual = [];
    for (let step = 0; step < ordered.length; step += 1) {
      await dispatchCommand(page, "app.tab.prev");
      await settle(page);
      const state = await paneState(page, paneId);
      prevActual.push({ side: state.side, activeIndex: state.activeIndex });
    }
    const prevExpected = expectedRotation(ordered, start, -1);
    compareRotation(failures, "previous rotation", prevActual, prevExpected);

    await ensureSide(page, paneId, "A");
    while ((await paneState(page, paneId)).tabs.length > 0) {
      await closeVisibleTab(page, paneId);
    }
    await dispatchCommand(page, "app.tab.close");
    let flashObserved = true;
    try {
      await page.waitForFunction(
        (id) =>
          document
            .querySelector(`.pane[data-pane-id="${id}"] .side-toggle`)
            ?.classList.contains("side-toggle-flash") === true,
        { timeout: 2_000 },
        paneId,
      );
    } catch {
      flashObserved = false;
    }
    const closeState = await paneState(page, paneId);
    if (closeState.side !== "B") {
      failures.push(`empty-side close: expected side B, got side ${closeState.side}`);
    }
    if (!flashObserved) {
      failures.push("empty-side close: A/B toggle did not flash");
    }
    if (JSON.stringify(closeState.tabs) !== JSON.stringify(sideB.tabs)) {
      failures.push(
        `empty-side close: expected ${JSON.stringify(sideB.tabs)}, got ${JSON.stringify(closeState.tabs)}`,
      );
    }
    await ctx.shot("rotation-and-empty-close");

    await dispatchCommand(page, "app.pane.kill");
    await page.waitForFunction(
      (id) => !document.querySelector(`.pane[data-pane-id="${id}"]`),
      { timeout: 10_000 },
      paneId,
    );

    if (failures.length > 0) {
      throw new Error(failures.join("; "));
    }

    return {
      order: ordered,
      next: nextActual,
      previous: prevActual,
      emptyClose: closeState,
    };
  },
};
