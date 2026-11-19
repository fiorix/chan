// Shared pieces of the keyboard-owner checks: a survey raised through
// `cs terminal survey` and read back later, the keyboard's place named by the
// surface that holds the active element, and a cleanup that answers whatever
// survey a failed leg left up.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const WINDOW_CARD = ".survey-overlay:not(.per-terminal) .survey-card";
export const terminalCard = (tab) => `.terminal-tab[data-terminal-tab-id="${tab}"] .survey-overlay.per-terminal .survey-card`;

/// Raise a survey without awaiting it: `cs terminal survey` blocks until the
/// survey resolves, so the call's outcome lands in `result` when it does.
/// `cs` is the check's `chan shell terminal` runner.
export function raiseSurvey(cs, args) {
  const call = { result: null };
  call.done = cs(["survey", ...args]).then(
    ({ stdout }) => (call.result = { code: 0, stdout: stdout.trim() }),
    (error) => (call.result = {
      code: error.code ?? "unknown",
      stdout: String(error.stdout ?? "").trim(),
      error: String(error.message ?? error),
    }),
  );
  return call;
}

/// The call's outcome once it resolves within `timeout`, or null while the
/// survey is still up.
export async function surveyOutcome(call, timeout) {
  const deadline = Date.now() + timeout;
  while (!call.result && Date.now() < deadline) await sleep(50);
  return call.result;
}

/// Wait for a survey's card to show; a timeout names the `cs` call's outcome,
/// so a survey the server refused reads as the instrument's fault, not a
/// missing card.
export async function waitForCard(page, selector, call, label, options = {}) {
  try {
    return await page.waitForSelector(selector, { timeout: 15_000, ...options });
  } catch (error) {
    throw new Error(`${label}: no card at ${selector} (${error.message}); the survey call reads ${JSON.stringify(call.result)}`);
  }
}

/// Press `key` with `modifiers` held, releasing every modifier whatever
/// happens between, so a throw cannot leave Control or Alt down.
export async function chord(page, modifiers, key) {
  const held = [];
  try {
    for (const modifier of modifiers) {
      await page.keyboard.down(modifier);
      held.push(modifier);
    }
    await page.keyboard.press(key);
  } finally {
    for (const modifier of held.reverse()) await page.keyboard.up(modifier);
  }
}

/// Where the keyboard is, named by the surface around the active element.
export async function keyboardAt(page) {
  return page.evaluate(() => {
    const active = document.activeElement;
    if (!active || active === document.body) return "body";
    const terminal = active.closest("[data-terminal-tab-id]")?.getAttribute("data-terminal-tab-id");
    if (active.closest(".survey-overlay:not(.per-terminal)")) return "window-survey";
    if (active.closest(".survey-overlay.per-terminal")) return `terminal-survey:${terminal}`;
    if (active.closest('[role="dialog"][aria-labelledby="path-prompt-title"]')) return "path-prompt";
    if (active.closest('[role="dialog"][aria-label="Command launcher"]')) return "deck";
    if (active.closest(".search")) return "search";
    if (active.closest(".rich-prompt")) return `composer:${terminal}`;
    if (active.closest(".terminal-host")) return `terminal:${terminal}`;
    if (active.closest(".editor-tab")) return "editor";
    if (active.closest(".browser")) return "files";
    return `${active.tagName}.${active.className?.toString?.() ?? ""}`;
  });
}

/// Answer every survey a leg left up by clicking its first option, the
/// window-wide card first since it covers the window, and wait for each call.
export async function answerOpenSurveys(page, calls) {
  for (let round = 0; round < 4; round += 1) {
    const open = calls.filter((call) => call && !call.result);
    if (open.length === 0) return;
    const clicked = await page.evaluate((windowCard) => {
      const card = document.querySelector(windowCard) ?? document.querySelector(".survey-overlay.per-terminal .survey-card");
      const option = card?.querySelector(".survey-option");
      if (!option) return false;
      option.click();
      return true;
    }, WINDOW_CARD);
    if (!clicked) await sleep(250);
    await Promise.race([Promise.all(open.map((call) => call.done)), sleep(3000)]);
  }
  const left = calls.filter((call) => call && !call.result).length;
  if (left > 0) throw new Error(`${left} survey call(s) still open after the cleanup answered every card`);
}
