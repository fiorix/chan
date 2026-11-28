// The status pill is fixed at the window's top right, above every pane, so
// while it shows the index section (a build, a reindex, a rebuild after a
// directory rename) a pointer click on a control under it lands on the pill
// instead: its body opens the indexing dashboard. The index state is the
// workspace's, not the check's; another check's rename can start a rebuild
// that outlives it.

const PILL = "[data-app-status-pill]";
const INDEX_SECTION = 'button[aria-label="open indexing dashboard"]';

/// Whether a reading has the pill, holding the index section, overlapping
/// the control's box. The box, not the click point, decides: the pill's
/// width follows its text, so a pill beside the click point can reach it
/// before the click lands. With no control, no pill, or a pill without the
/// index section there is nothing to wait for, and the click goes ahead as
/// it would have without the wait.
export function indexPillCovers({ control, pill }) {
  if (!control || !pill?.index) return false;
  return pill.left < control.right && control.left < pill.right &&
    pill.top < control.bottom && control.top < pill.bottom;
}

async function readCover(page, selector) {
  return page.evaluate(({ selector, pillSelector, indexSelector }) => {
    const box = (el) => {
      const rect = el.getBoundingClientRect();
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    };
    const control = document.querySelector(selector);
    const pill = document.querySelector(pillSelector);
    return {
      control: control ? box(control) : null,
      pill: pill ? {
        ...box(pill),
        index: Boolean(pill.querySelector(indexSelector)),
        text: pill.textContent.replace(/\s+/g, " ").trim(),
      } : null,
    };
  }, { selector, pillSelector: PILL, indexSelector: INDEX_SECTION });
}

/// Wait until the status pill's index section no longer covers the first
/// element `selector` matches, the one `page.click(selector)` would press.
/// A pill still over it at the bound is an environment error naming the
/// pill: the check never got to make its click, so it neither passed nor
/// failed. A wait that happened is logged with its length.
export async function waitIndexPillClear(page, selector, { timeout = 120_000, interval = 250 } = {}) {
  const started = Date.now();
  let reading = await readCover(page, selector);
  if (!indexPillCovers(reading)) return reading;
  const first = reading.pill.text;
  while (indexPillCovers(reading)) {
    if (Date.now() - started >= timeout) {
      throw Object.assign(
        new Error(`the index status pill ${JSON.stringify(reading.pill.text)} still covers ${selector} after ${timeout} ms`),
        { smokeEnvironment: true, smokeDetails: { selector, reading } },
      );
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
    reading = await readCover(page, selector);
  }
  console.log(`[smoke]   waited ${Date.now() - started} ms for the index status pill ${JSON.stringify(first)} to leave ${selector}`);
  return reading;
}
