// An errored mermaid block's face is click-through to the failing
// source line. CM6 otherwise maps widget clicks to the nearest fence
// edge, which made the blamed line unreachable by mouse (and ArrowUp
// from the invisible opener landing exited above the diagram). The
// guard: click the echoed error row, assert the caret landed ON the
// blamed line by typing a marker there, then ArrowUp must stay inside
// the block.

const DOC = "mermaid-err.md";
const BLAMED = "B -->|no| D[Bad; label, x] - E";
const LINE_ABOVE = "A --> B";

async function armProbe(page) {
  await page.evaluate(() => {
    const events = { mutations: [], selections: [], presses: [] };
    window.__mermaidErrorProbe = events;
    let measuredRow = null;
    window.__mermaidErrorCaptureRow = (row) => { measuredRow = row; };
    const path = (node) => {
      const parts = [];
      for (let el = node instanceof Element ? node : node?.parentElement; el && parts.length < 6; el = el.parentElement) {
        parts.push(`${el.tagName.toLowerCase()}${el.className && typeof el.className === "string" ? `.${el.className.trim().replaceAll(/\s+/g, ".")}` : ""}`);
      }
      return parts.join(" > ");
    };
    const theme = () => ({
      root: document.documentElement.getAttribute("data-theme"),
      tab: document.querySelector(".tabs .tab.active")?.getAttribute("data-theme"),
    });
    const note = (kind, node) => {
      if (events.mutations.length >= 100) return;
      events.mutations.push({ at: performance.now(), kind, node: path(node), ...theme() });
    };
    const observe = (records) => {
      for (const record of records) {
        for (const [kind, nodes] of [["added", record.addedNodes], ["removed", record.removedNodes]]) {
          for (const node of nodes) {
            if (!(node instanceof Element)) continue;
            if (node.matches(".cm-editor, .cm-md-diagram-rendered")) note(kind, node);
            for (const nested of node.querySelectorAll(".cm-editor, .cm-md-diagram-rendered")) note(kind, nested);
          }
        }
      }
    };
    new MutationObserver(observe).observe(document, { childList: true, subtree: true });
    document.addEventListener("selectionchange", () => {
      if (events.selections.length >= 100) return;
      const line = getSelection()?.anchorNode?.parentElement?.closest(".cm-line");
      events.selections.push({ at: performance.now(), line: line?.textContent ?? null });
    });
    window.addEventListener("mousedown", (event) => {
      const target = event.target;
      events.presses.push({
        at: event.timeStamp,
        phase: "capture",
        target: path(target),
        inErrorBody: target instanceof Element && !!target.closest(".cm-md-diagram-body.cm-md-diagram-error"),
        bodyText: document.querySelector(".cm-md-diagram-body.cm-md-diagram-error")?.textContent ?? null,
        measuredRowConnected: measuredRow?.isConnected ?? null,
        currentRowConnected: !!document.querySelector(".cm-md-diagram-error-src")?.isConnected,
      });
    }, true);
    window.addEventListener("mousedown", (event) => {
      events.presses.push({ at: event.timeStamp, phase: "bubble", target: path(event.target) });
    });
  });
}

async function geometry(page, markMeasured = false) {
  return page.evaluate((mark) => {
    const row = document.querySelector(".cm-md-diagram-error-src");
    const block = row?.closest(".cm-md-diagram-rendered");
    if (!row || !block) return null;
    if (mark) window.__mermaidErrorCaptureRow?.(row);
    const rect = (element) => {
      const r = element.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    };
    const r = row.getBoundingClientRect();
    const x = r.x + r.width / 2;
    const y = r.y + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    const animations = [];
    for (let el = block; el && animations.length < 40; el = el.parentElement) {
      for (const animation of el.getAnimations({ subtree: true })) {
        animations.push({ element: el.className, state: animation.playState, time: animation.currentTime });
      }
    }
    return { at: performance.now(), row: rect(row), block: rect(block), hit: hit?.className ?? null, hitIsRow: hit === row, animations };
  }, markMeasured);
}

async function stableRowCenter(page) {
  return page.evaluate(async () => {
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
    const snap = () => {
      const row = document.querySelector(".cm-md-diagram-error-src");
      const block = row?.closest(".cm-md-diagram-rendered");
      if (!row || !block) return null;
      const r = row.getBoundingClientRect();
      return { row, block, x: r.x + r.width / 2, y: r.y + r.height / 2,
        rect: [r.x, r.y, r.width, r.height] };
    };
    const deadline = performance.now() + 10_000;
    let last = "row vanished";
    while (performance.now() < deadline) {
      const first = snap();
      await frame();
      const second = snap();
      await frame();
      const third = snap();
      if (!first || !second || !third) continue;
      const stable = JSON.stringify(first.rect) === JSON.stringify(second.rect) &&
        JSON.stringify(second.rect) === JSON.stringify(third.rect);
      const running = third.block.getAnimations({ subtree: true })
        .some((animation) => animation.playState === "running");
      const hit = document.elementFromPoint(third.x, third.y);
      last = JSON.stringify({ stable, running, hit: hit?.className ?? null, rect: third.rect });
      if (stable && !running && hit === third.row) {
        return { x: third.x, y: third.y, at: performance.now() };
      }
    }
    throw new Error(`error row was not under pointer after stable frames: ${last}`);
  });
}

async function probe(page, steps, geometryAtMeasurement, geometryBeforePress) {
  return { steps, geometryAtMeasurement, geometryBeforePress,
    geometryAtCapture: await geometry(page),
    page: await page.evaluate(() => ({
      timeOrigin: performance.timeOrigin,
      events: window.__mermaidErrorProbe ?? null,
    })) };
}

async function caretLine(page) {
  return page.evaluate(() =>
    getSelection()?.anchorNode?.parentElement?.closest(".cm-line")?.textContent ?? null);
}

async function openFile(page, filename, steps) {
  await page.bringToFront();
  if (!(await page.$(".file-tree, [role=tree]"))) {
    await page.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent("chan:command", { detail: { name: "app.files.toggle" } }),
      );
    });
    await page.waitForSelector('[role="treeitem"]', { timeout: 15_000 });
  }
  const clicked = await page.evaluate((name) => {
    const row = [...document.querySelectorAll('[role="treeitem"] button.name')].find(
      (b) => b.textContent?.trim() === name,
    );
    if (!row) return false;
    row.click();
    return true;
  }, filename);
  if (!clicked) throw new Error(`tree row not found: ${filename}`);
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll("button")].some((b) => b.textContent?.trim() === "Open"),
    { timeout: 15_000, polling: 200 },
  );
  await armProbe(page);
  await page.evaluate(() => {
    [...document.querySelectorAll("button")]
      .find((b) => b.textContent?.trim() === "Open")
      ?.click();
  });
  steps.push({ name: "Open-click", at: Date.now() });
  await page.waitForSelector(".cm-content", { timeout: 30_000 });
}

async function lineWithMarker(page, text, marker) {
  return page.evaluate(
    ({ text, marker }) =>
      [...document.querySelectorAll(".cm-line")].some(
        (l) => l.textContent?.includes(text) && l.textContent?.includes(marker),
      ),
    { text, marker },
  );
}

export default {
  name: "mermaid-error-nav",
  async run(ctx) {
    const { page } = ctx;
    const steps = [{ name: "check-start", at: Date.now() }];
    let measured = null;
    let beforePress = null;
    try {
      await openFile(page, DOC, steps);
      steps.push({ name: "cm-content", at: Date.now() });

      // The renderer fails async; the face carries the echoed source row.
      await page.waitForSelector(".cm-md-diagram-error-src", { timeout: 30_000 });
      steps.push({ name: "error-row-first-sight", at: Date.now() });

      measured = await geometry(page, true);
      steps.push({ name: "measurement", at: Date.now() });
      await page.bringToFront();
      const center = await stableRowCenter(page);
      beforePress = await geometry(page);
      steps.push({ name: "press-request", at: Date.now(), pageAt: center.at });
      await page.mouse.click(center.x, center.y);
      steps.push({ name: "after-press", at: Date.now(), caret: await caretLine(page) });
      await page.evaluate(() => new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve))));
      steps.push({ name: "two-frames-after-press", at: Date.now(), caret: await caretLine(page) });

      // The click de-renders the block and lands the caret on the blamed
      // line; a typed marker proves the landing in user-visible terms.
      await page.waitForFunction(
        () => !document.querySelector(".cm-md-diagram-rendered"),
        { timeout: 15_000, polling: 200 },
      );
      steps.push({ name: "de-render", at: Date.now() });
      await page.keyboard.press("End");
      steps.push({ name: "after-End", at: Date.now(), caret: await caretLine(page) });
      await page.keyboard.type(" %HIT%", { delay: 10 });
      if (!(await lineWithMarker(page, "D[Bad", "%HIT%"))) {
        await ctx.shot("landed-elsewhere");
        throw new Error("click on the error row did not land the caret on the blamed line");
      }

      // ArrowUp stays inside the block (the old behavior exited above the
      // opener because the caret invisibly sat at the block start).
      await page.keyboard.press("ArrowUp");
      await page.keyboard.press("End");
      await page.keyboard.type(" %UP%", { delay: 10 });
      if (!(await lineWithMarker(page, LINE_ABOVE, "%UP%"))) {
        await ctx.shot("arrowup-escaped");
        throw new Error("ArrowUp from the blamed line left the code block");
      }

      return { blamed: BLAMED, probe: await probe(page, steps, measured, beforePress) };
    } catch (cause) {
      const evidence = await probe(page, steps, measured, beforePress).catch((captureError) =>
        ({ captureError: String(captureError) }));
      throw new Error(`${cause.message}; probe=${JSON.stringify(evidence)}`, { cause });
    }
  },
};
