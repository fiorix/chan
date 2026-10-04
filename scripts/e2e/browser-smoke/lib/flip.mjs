let nextFlipId = 0;

export function paneFlip(paneId) {
  return {
    selector: `.pane[data-pane-id="${paneId}"]`,
    activeClass: "sideFlipActive",
    sideSelector: ".pane-card-inner",
    sideAttribute: "data-side-label",
  };
}

export function screenFlip() {
  return {
    selector: ".screen-flip",
    activeClass: "flipActive",
    sideSelector: ".screen-flip-inner",
    sideAttribute: "data-flip-label",
  };
}

export async function armFlip(page, preset) {
  const id = `smoke-flip-${++nextFlipId}`;
  await page.evaluate((key, config) => {
    const roots = [...document.querySelectorAll(config.selector)];
    if (roots.length !== 1) throw new Error(`flip target count is ${roots.length}: ${config.selector}`);
    if (roots[0].classList.contains(config.activeClass)) {
      throw new Error(`flip already active when armed: ${config.selector}`);
    }
    const side = roots[0].querySelector(config.sideSelector)?.getAttribute(config.sideAttribute);
    if (!side) throw new Error(`flip side missing when armed: ${config.selector}`);
    const records = window.__chanSmokeFlipRecords ??= new Map();
    const record = { config, initialSide: side, started: false, ended: false, observer: null };
    const observe = () => {
      const targets = [...document.querySelectorAll(config.selector)];
      const active = targets.some((element) => element.classList.contains(config.activeClass));
      if (active) record.started = true;
      if (record.started && !active) record.ended = true;
    };
    record.observer = new MutationObserver(observe);
    record.observer.observe(document, {
      subtree: true,
      attributes: true,
      attributeFilter: ["class", config.sideAttribute],
    });
    records.set(key, record);
  }, id, preset);

  const snapshot = () => page.evaluate((key) => {
    const record = window.__chanSmokeFlipRecords?.get(key);
    if (!record) return null;
    const { config } = record;
    const roots = [...document.querySelectorAll(config.selector)];
    return {
      initialSide: record.initialSide,
      side: roots[0]?.querySelector(config.sideSelector)?.getAttribute(config.sideAttribute) ?? null,
      active: roots.some((element) => element.classList.contains(config.activeClass)),
      started: record.started,
      ended: record.ended,
    };
  }, id);

  const disarm = () => page.evaluate((key) => {
    const records = window.__chanSmokeFlipRecords;
    const record = records?.get(key);
    record?.observer.disconnect();
    records?.delete(key);
  }, id);

  const complete = (state) => state && state.side !== state.initialSide &&
    state.started && state.ended && !state.active;

  return {
    async settled(label, timeoutMs = 10_000) {
      try {
        await page.waitForFunction(
          (key) => {
            const record = window.__chanSmokeFlipRecords?.get(key);
            if (!record) return false;
            const { config } = record;
            const roots = [...document.querySelectorAll(config.selector)];
            const side = roots[0]?.querySelector(config.sideSelector)?.getAttribute(config.sideAttribute);
            return side !== record.initialSide && record.started && record.ended &&
              !roots.some((element) => element.classList.contains(config.activeClass));
          },
          { timeout: timeoutMs, polling: "mutation" },
          id,
        );
      } catch (cause) {
        const state = await snapshot();
        const missing = !state ? "observation" : !state.started ? "flip start" :
          !state.ended || state.active ? "flip end" : "side change";
        throw new Error(`${label}: ${missing} not observed within ${timeoutMs}ms: ${JSON.stringify(state)}`, { cause });
      }
    },
    async assertSettled(label) {
      const state = await snapshot();
      await disarm();
      if (!complete(state)) throw new Error(`${label}: acted during a flip: ${JSON.stringify(state)}`);
    },
    disarm,
  };
}
