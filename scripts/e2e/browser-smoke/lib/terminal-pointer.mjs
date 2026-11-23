import assert from "node:assert/strict";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const CPR = /\x1b\[[1-9]\d*;[1-9]\d*R$/;

export function pointerInputSince(fixture, index) {
  return Buffer.concat(fixture.records.slice(index)
    .filter((record) => record.type === "keys")
    .map((record) => Buffer.from(record.base64, "base64"))).toString("latin1");
}

// The cursor reply follows the gesture through the real PTY. Silence from
// a stalled or disconnected recorder cannot satisfy a no-report assertion.
export async function drainPointerInput(fixture, bytes = "", index = fixture.records.length) {
  await fixture.send("bytes", { base64: Buffer.from(bytes + "\x1b[6n").toString("base64") });
  await fixture.waitFor(() => CPR.test(pointerInputSince(fixture, index)));
  const input = pointerInputSince(fixture, index);
  assert.match(input, CPR, "the terminal answered the cursor query");
  return { input: input.replace(CPR, ""), reply: input.match(CPR)[0] };
}

// Reject extra bytes and partial reports instead of extracting only the
// reports a positive regexp happens to recognize.
export function pointerReports(input) {
  const matches = [...input.matchAll(/\x1b\[<(\d+);([1-9]\d*);([1-9]\d*)([Mm])/g)];
  assert.equal(matches.map((match) => match[0]).join(""), input, "the PTY contains only complete SGR reports");
  return matches.map((match) => ({ button: Number(match[1]), col: Number(match[2]), row: Number(match[3]), end: match[4] }));
}

// Capture the actual app instance through its module's open method. All
// subsequent readings use public Terminal methods and the host's DOM.
export async function capturePointerTerminals(page) {
  const installed = await page.evaluate(async () => {
    if (window.__pointerSmoke) throw new Error("pointer terminal capture already installed");
    for (const script of document.querySelectorAll('script[type="module"][src]')) {
      const name = /ghostty-web-[\w-]+\.js/.exec(await (await fetch(script.src)).text())?.[0];
      if (!name) continue;
      const { Terminal } = await import(new URL(name, script.src).href);
      const open = Terminal.prototype.open;
      const terminals = [];
      Terminal.prototype.open = function (...args) {
        terminals.push(this);
        return open.apply(this, args);
      };
      window.__pointerSmoke = {
        terminals,
        restore() { Terminal.prototype.open = open; delete window.__pointerSmoke; },
      };
      return true;
    }
    return false;
  });
  assert.ok(installed, "the entry module names a Ghostty chunk");
}

export async function pointerTerminal(page, hostQuery) {
  return page.evaluateHandle((query) => {
    const host = document.querySelector(query);
    const term = host && window.__pointerSmoke?.terminals.find((candidate) => candidate.element === host);
    if (!term) throw new Error("the attached Ghostty terminal was not captured");
    return term;
  }, hostQuery);
}

export async function pointerGrid(term) {
  return term.evaluate((terminal) => {
    const canvas = terminal.element?.querySelector(":scope > canvas");
    const rect = canvas?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0 || terminal.cols < 30 || terminal.rows < 4) {
      throw new Error("terminal canvas cannot fit the pointer fixture");
    }
    return {
      x: rect.left, y: rect.top, width: rect.width, height: rect.height,
      cols: terminal.cols, rows: terminal.rows,
      w: rect.width / terminal.cols, h: rect.height / terminal.rows,
    };
  });
}

export async function seedPointerClipboard(page, sentinel) {
  await page.evaluate(async (text) => {
    await navigator.clipboard.writeText(text);
    if (await navigator.clipboard.readText() !== text) throw new Error("clipboard sentinel was not seeded");
  }, sentinel);
}

export async function copyPointerSelection(page, term) {
  await term.evaluate((terminal) => {
    const input = terminal.element?.querySelector("textarea");
    if (!input) throw new Error("terminal input missing");
    input.focus();
    if (document.activeElement !== input) throw new Error("terminal input did not take focus");
  });
  await page.keyboard.down("Control");
  await page.keyboard.down("Shift");
  try { await page.keyboard.press("KeyC"); }
  finally {
    await page.keyboard.up("Shift");
    await page.keyboard.up("Control");
  }
  await settlePointer(page);
  return page.evaluate(() => navigator.clipboard.readText());
}

export async function settlePointer(page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await sleep(200);
}
