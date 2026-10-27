let nextCardFlipId = 0;

// A card keeps its back label through the turn, so the page flip helper's
// label-change guard cannot settle it. Observe this card's active class alone.
export async function armCardFlip(page, selector) {
  const id = `smoke-card-flip-${++nextCardFlipId}`;
  await page.evaluate((key, target) => {
    const roots = [...document.querySelectorAll(target)];
    if (roots.length !== 1) throw new Error(`card flip target count is ${roots.length}: ${target}`);
    if (roots[0].classList.contains("flipActive")) {
      throw new Error(`card flip already active when armed: ${target}`);
    }
    const records = window.__chanSmokeCardFlipRecords ??= new Map();
    const record = { selector: target, started: false, ended: false, observer: null };
    record.observer = new MutationObserver(() => {
      const active = roots[0].classList.contains("flipActive");
      if (active) record.started = true;
      if (record.started && !active) record.ended = true;
    });
    record.observer.observe(roots[0], { attributes: true, attributeFilter: ["class"] });
    records.set(key, record);
  }, id, selector);

  const snapshot = () => page.evaluate((key) => {
    const record = window.__chanSmokeCardFlipRecords?.get(key);
    if (!record) return null;
    const roots = [...document.querySelectorAll(record.selector)];
    return {
      count: roots.length,
      active: roots[0]?.classList.contains("flipActive") ?? false,
      started: record.started,
      ended: record.ended,
    };
  }, id);

  const disarm = () => page.evaluate((key) => {
    const records = window.__chanSmokeCardFlipRecords;
    const record = records?.get(key);
    record?.observer.disconnect();
    records?.delete(key);
  }, id);

  return {
    async settled(label, timeoutMs = 10_000) {
      try {
        await page.waitForFunction(
          (key) => {
            const record = window.__chanSmokeCardFlipRecords?.get(key);
            if (!record) return false;
            const roots = [...document.querySelectorAll(record.selector)];
            return roots.length === 1 && record.started && record.ended &&
              !roots[0].classList.contains("flipActive");
          },
          { timeout: timeoutMs, polling: "mutation" },
          id,
        );
      } catch (cause) {
        const state = await snapshot();
        await disarm();
        throw new Error(`${label}: card flip not settled within ${timeoutMs}ms: ${JSON.stringify(state)}`, { cause });
      }
    },
    async assertSettled(label) {
      const state = await snapshot();
      await disarm();
      if (!state || state.count !== 1 || !state.started || !state.ended || state.active) {
        throw new Error(`${label}: acted during a card flip: ${JSON.stringify(state)}`);
      }
    },
    disarm,
  };
}
