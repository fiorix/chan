const CARD = '[role="group"][aria-roledescription="card"]';
const DECK = '[role="region"][aria-roledescription="carousel"]';

async function stateOf(page, selector) {
  return page.evaluate((target, cardSelector, deckSelector) => {
    const controls = [...document.querySelectorAll(target)];
    const card = controls[0]?.closest(cardSelector);
    const deck = card?.closest(deckSelector);
    const ring = card?.parentElement;
    return {
      controls: controls.length,
      target: card?.getAttribute("aria-label") ?? null,
      current: card?.getAttribute("aria-current") === "true",
      inert: Boolean(controls[0]?.closest("[inert]")),
      deck: deck?.getAttribute("aria-label") ?? null,
      cards: [...(deck?.querySelectorAll(cardSelector) ?? [])].map((item) => ({
        label: item.getAttribute("aria-label"), current: item.getAttribute("aria-current") === "true",
      })),
      transform: ring ? getComputedStyle(ring).transform : null,
      animations: (ring?.getAnimations() ?? []).map((animation) => ({
        state: animation.playState, pending: animation.pending,
      })),
    };
  }, selector, CARD, DECK);
}

async function settle(page, selector, timeoutMs) {
  await page.evaluate((target, cardSelector, timeout) => new Promise((resolve, reject) => {
    const ring = document.querySelector(target)?.closest(cardSelector)?.parentElement;
    if (!ring) return reject(new Error("carousel ring is missing"));
    let frame;
    const timer = setTimeout(() => {
      cancelAnimationFrame(frame);
      reject(new Error(`carousel motion did not settle within ${timeout}ms`));
    }, timeout);
    const fail = (error) => { clearTimeout(timer); reject(error); };
    // The active card changes before its CSS transition starts. Flush layout and cross two frames before reading animations so that idle cannot mean not started yet.
    frame = requestAnimationFrame(() => {
      ring.getBoundingClientRect();
      frame = requestAnimationFrame(() => {
        Promise.all(ring.getAnimations().map((animation) => animation.finished)).then(() => {
          clearTimeout(timer);
          resolve();
        }, fail);
      });
    });
  }), selector, CARD, timeoutMs);
}

// A side card's contents are inert. The deck's own navigation brings the requested control forward and its transform must finish before a pointer can reach it.
export async function showCarouselCard(page, selector, timeoutMs = 10_000) {
  try {
    await page.waitForSelector(selector, { timeout: timeoutMs });
    let state = await stateOf(page, selector);
    if (state.controls !== 1 || !state.target || !state.deck) {
      throw new Error("the control must name one carousel card");
    }
    const limit = state.cards.length;
    for (let turn = 0; turn <= limit; turn += 1) {
      await settle(page, selector, timeoutMs);
      state = await stateOf(page, selector);
      if (state.controls !== 1 || !state.target || !state.deck) throw new Error("the carousel control changed during the turn");
      if (state.current && !state.inert) return;
      if (turn === limit) break;
      const current = state.cards.find((card) => card.current)?.label;
      if (!current) throw new Error("the deck has no current card");
      const handle = await page.evaluateHandle((target, deckSelector) =>
        document.querySelector(target)?.closest(deckSelector)?.querySelector('button[aria-label="Next card"]'),
      selector, DECK);
      try {
        const next = handle.asElement();
        if (!next) throw new Error("the deck has no Next card button");
        await next.click();
      } finally {
        await handle.dispose();
      }
      await page.waitForFunction((target, deckSelector, cardSelector, previous) => {
        const deck = document.querySelector(target)?.closest(deckSelector);
        return [...(deck?.querySelectorAll(cardSelector) ?? [])].some((card) =>
          card.getAttribute("aria-current") === "true" && card.getAttribute("aria-label") !== previous);
      }, { timeout: timeoutMs }, selector, DECK, CARD, current);
    }
    throw new Error("the requested card did not become interactive after a full turn");
  } catch (cause) {
    const state = await stateOf(page, selector).catch(() => null);
    throw new Error(`carousel control ${selector} is not ready: ${cause.message}; ${JSON.stringify(state)}`, { cause });
  }
}
