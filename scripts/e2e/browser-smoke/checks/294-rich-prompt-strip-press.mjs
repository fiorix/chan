// A real pointer press on the Rich Prompt's strip keeps the keyboard on
// the composer: with the button held the composer's field stays focused,
// and after the release the next key reaches it with no click. The same
// hold keeps focus through a recall and a failed recall, made while the
// shell prints so that each submit is still queued at the press, and a
// two-pane press sends without activating the other pane. A deck run opened over
// Search returns to the Search input. The red variant of this check runs
// the same file on a tree with the strip's pointerdown handler removed:
// step 1 then fails on any engine that focuses a button on a press.
//
// What jsdom cannot see (a real press focusing a button) is why this is a
// guest check: the mounted suite pins the handler, this pins the effect.
// The image leg only records: whether the composer takes focus when image
// paths arrive and whether the other pane activates are the owner's open
// questions, so the check reports them without failing on them.

import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { closeEveryTerminal, dispatchCommand } from "../lib/pane-strip.mjs";
import { openAttachedTerminal, readTerminalAttachment } from "../lib/terminal-attach.mjs";
import { readTerminalPrefs, writeTerminalPrefs } from "../lib/terminal-prefs.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

// Where the keyboard is, from the page's own active element.
async function focusState(page, card) {
  return page.evaluate((card) => {
    const composer = card ? document.querySelector(card) : null;
    const editor = composer?.querySelector(".cm-content");
    const button = composer?.querySelector(".rp-primary") ?? null;
    const active = document.activeElement;
    return {
      text: editor?.textContent ?? null,
      editable: editor?.getAttribute("contenteditable") === "true",
      pending: composer?.classList.contains("pending") ?? null,
      button: button ? { label: button.textContent?.trim() ?? null, disabled: button.disabled } : null,
      note: composer?.querySelector(".rp-text")?.textContent ?? null,
      where:
        active === null || active === document.body
          ? "body"
          : composer && composer.contains(active)
            ? editor && editor.contains(active)
              ? "composer"
              : "composer-chrome"
            : `${active.tagName ?? "?"}.${
              typeof active.className === "string" ? active.className : active.className?.baseVal ?? "?"
            }`,
    };
  }, card);
}

// The page's patched WebSocket records prompt frames with the tab that sent
// them, and can drop the recall's cancel frame for the failed-recall leg.
function tracePrompts() {
  const NativeSocket = window.WebSocket;
  const trace = (window.__prompt294 = { prompts: [], dropCancel: false, droppedCancels: 0 });
  window.WebSocket = new Proxy(NativeSocket, {
    construct(target, args) {
      const url = new URL(args[0], location.href);
      if (url.pathname !== "/api/terminal/ws") return Reflect.construct(target, args);
      const socket = Reflect.construct(target, args);
      const tab = new URL(args[0], location.href).searchParams.get("tab_name");
      const send = socket.send.bind(socket);
      socket.send = (data) => {
        if (typeof data === "string") {
          let frame;
          try {
            frame = JSON.parse(data);
          } catch {
            /* Raw input is not JSON. */
          }
          if (frame?.type === "prompt") trace.prompts.push({ ...frame, tab });
          if (trace.dropCancel && frame?.type === "cancel-prompt") {
            trace.droppedCancels += 1;
            return;
          }
        }
        return send(data);
      };
      return socket;
    },
  });
  trace.restore = () => {
    window.WebSocket = NativeSocket;
  };
}

async function waitFor(page, card, label, accept, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  let observed;
  do {
    observed = await focusState(page, card);
    if (accept(observed)) return observed;
    await sleep(50);
  } while (Date.now() < deadline);
  assert.fail(`${label}: ${JSON.stringify(observed)}`);
}

/// Open a terminal with a composer holding the given text.
async function openComposer(ctx, page, cs, windowId, backend, name, text) {
  const row = await openAttachedTerminal(ctx, page, cs, windowId, name, backend);
  const attachment = await readTerminalAttachment(page, cs, backend, (entry) => entry.session_id === row.session_id);
  assert.ok(attachment.attached, `the ${backend} terminal is attached`);
  const terminal = attachment.selector;
  const card = `${terminal} .rich-prompt`;
  await page.click(`${terminal} .terminal-host`);
  await page.keyboard.down("Control");
  await page.keyboard.down("Alt");
  await page.keyboard.press("KeyP");
  await page.keyboard.up("Alt");
  await page.keyboard.up("Control");
  await page.waitForSelector(`${card} .cm-content`, { visible: true, timeout: 15_000 });
  await page.click(`${card} .cm-content`);
  await page.keyboard.type(text);
  await waitFor(page, card, "the draft is editable", (value) => value.text === text && value.editable && !value.pending);
  return { card, terminal };
}

/// Install the press record: what sits under the press point and every
/// event the button and the window see, in capture and at bubble.
async function installPressRecord(page, selector) {
  return page.evaluate((selector) => {
    const button = document.querySelector(selector);
    if (!button) throw new Error(`no ${selector}`);
    button.scrollIntoView({ block: "center" });
    const box = button.getBoundingClientRect();
    if (!(box.width > 0 && box.height > 0)) throw new Error(`${selector} has no box`);
    const point = { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
    const describe = (el) =>
      el ? `${el.tagName}.${typeof el.className === "string" ? el.className : el.className?.baseVal ?? ""}` : null;
    const under = document.elementFromPoint(point.x, point.y);
    const record = {
      selector,
      point,
      buttonBox: { x: box.x, y: box.y, width: box.width, height: box.height },
      under: describe(under),
      underIsButton: under === button || !!under?.closest?.(selector),
      events: [],
    };
    const note = (node) => (event) =>
      record.events.push({
        type: event.type,
        node,
        target: describe(event.target),
        prevented: event.defaultPrevented,
        at: Math.round(performance.now()),
      });
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      button.addEventListener(type, note("button-capture"), true);
      window.addEventListener(type, note("window-capture"), true);
      window.addEventListener(type, (event) =>
        record.events.push({ type: event.type, node: "window-bubble", prevented: event.defaultPrevented, at: Math.round(performance.now()) }),
      );
    }
    window.__prompt294.pressRecord = record;
    // The press is the evidence only where it lands on the button.
    if (!record.underIsButton) {
      throw new Error(`instrument: the centre of ${selector} hit-tests to ${record.under}, not the button`);
    }
    return point;
  }, selector);
}

async function readPressRecord(page) {
  return page.evaluate(() => {
    const record = window.__prompt294.pressRecord;
    const active = document.activeElement;
    record.activeAfter = active === null || active === document.body ? "body" : describeActive(active);
    function describeActive(el) {
      return `${el.tagName ?? "?"}.${
        typeof el.className === "string" ? el.className : el.className?.baseVal ?? ""
      }`;
    }
    return record;
  });
}

/// A real press on the strip's primary button: hold, read, release.
async function pressSubmit(page, card, label, shot) {
  const point = await installPressRecord(page, `${card} .rp-primary`);
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await sleep(250);
  const held = await focusState(page, card);
  const record = await readPressRecord(page);
  try {
    assert.equal(held.where, "composer", `${label}: the press holds the composer`);
  } catch (error) {
    throw new Error(`${error.message}\nPRESS RECORD: ${JSON.stringify(record)}`);
  }
  await shot(label);
  await page.mouse.up();
  return { held, record };
}

/// Submit with the keyboard and catch a pending prompt, retrying.
async function catchPending(page, card, submit, tries = 4) {
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    await submit();
    const deadline = Date.now() + 1500;
    for (;;) {
      const seen = await focusState(page, card);
      if (seen.button && seen.button.label === "esc cancel") return true;
      if (seen.button && seen.button.label === "recalling...") return true;
      if (Date.now() > deadline) break;
      await sleep(15);
    }
  }
  return false;
}

/// Close panes until one is left, taking the "Close tab?" confirmation a
/// live terminal raises: the terminal cleanup reads one pane only, so a
/// split the two-pane leg leaves, or one a failure leaves half made, would
/// hold its terminals past it.
async function closeExtraPanes(page) {
  const count = () => page.evaluate(() => document.querySelectorAll(".pane[data-pane-id]").length);
  let panes = await count();
  for (let guard = 0; panes > 1; guard += 1) {
    if (guard >= 4) throw new Error(`still ${panes} panes after ${guard} closes`);
    await dispatchCommand(page, "app.pane.kill");
    const deadline = Date.now() + 15_000;
    let left = panes;
    while (left >= panes) {
      if (Date.now() > deadline) throw new Error(`the pane count stayed at ${left}`);
      const dialog = await page.$('[role="dialog"][aria-labelledby="confirm-title"]');
      if (dialog) {
        for (const button of await dialog.$$("button")) {
          if (await button.evaluate((node) => node.textContent?.trim() === "Close")) {
            await button.click();
            break;
          }
        }
      }
      await sleep(200);
      left = await count();
    }
    panes = left;
  }
}

async function paneIds(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll(".pane[data-pane-id]")].map((node) => ({
      id: node.getAttribute("data-pane-id"),
      focused: node.classList.contains("focused"),
      terminals: node.querySelectorAll(".terminal-tab").length,
    })),
  );
}

async function activePaneId(page) {
  const panes = await paneIds(page);
  const active = panes.find((pane) => pane.focused);
  assert.ok(active, `a pane is active: ${JSON.stringify(panes)}`);
  return active.id;
}

const ONE_PX_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

export default {
  name: "rich-prompt-strip-press",
  async run(ctx) {
    if (!ctx.controlSocket) ctx.skip("control socket not found for the server pid");
    const { page } = ctx;
    await page.bringToFront();
    const windowId = await page.evaluate(() => new URL(location.href).searchParams.get("w")?.trim()
      || sessionStorage.getItem("chan.session.window")?.trim() || "");
    assert.ok(windowId, "the check page has a window id");
    await ctx.waitWindowLive(windowId);
    const cs = (args) => ctx.exec(ctx.chanBin, ["shell", "terminal", ...args], {
      cwd: ctx.workspaceDir,
      env: { ...process.env, CHAN_CONTROL_SOCKET: ctx.controlSocket, CHAN_WINDOW_ID: windowId },
      timeout: 90_000,
    });
    const token = new URL(ctx.serverUrl).searchParams.get("t") ?? "";
    const original = await readTerminalPrefs(page, token);
    const boxPath = join(ctx.workspaceDir, "box294.png");
    writeFileSync(boxPath, ONE_PX_PNG);
    const shot = (label) => ctx.shot(`294-${label}`).catch(() => {});
    const failures = [];
    try {
      await page.evaluate(tracePrompts);
      try {
        for (const backend of ["xterm", "ghostty"]) {
          const name = `Press294-${backend}`;
          const text = `PROMPT294-${backend}`;
          const result = { backend, passed: false, pageErrors: [], cleanupErrors: [], steps: {} };
          const onError = (error) => result.pageErrors.push(String(error));
          page.on("pageerror", onError);
          let opened = false;
          const stop = join(ctx.workspaceDir, `.press294-${backend}.stop`);
          try {
            await writeTerminalPrefs(page, token, { ghostty: backend === "ghostty" });
            const { card } = await openComposer(ctx, page, cs, windowId, backend, name, text);
            opened = true;
            await page.evaluate(() => {
              window.__prompt294.prompts.length = 0;
            });

            // Step 1: a real press on Submit holds the composer, and the
            // next key reaches it with no click. The release submits the
            // draft; once it delivers, the typed key starts the next one.
            result.steps.pressRecord = (await pressSubmit(page, card, "294-press-held", shot)).record;
            await waitFor(page, card, "the submit delivers",
              (value) => (value.text === "" && !value.pending ? value : false));
            await page.keyboard.type("x");
            result.steps.press = await waitFor(page, card, "the next key reaches the composer",
              (value) => (value.text === "x" && value.where === "composer" ? value : false));
            assert.equal(result.steps.press.editable, true);
            await shot(`294-${backend}-pressed`);
            await page.keyboard.down("Control");
            await page.keyboard.press("Enter");
            await page.keyboard.up("Control");
            await waitFor(page, card, "the second draft delivers",
              (value) => value.text === "" && !value.pending);

            // From here to the secondary press, the shell prints until the
            // check releases it, at most 120 s: the server holds every submit
            // in its queue (its drainer waits for quiet output), so each
            // press below lands on a prompt that is still waiting. The
            // marker is split in the command so only the output carries it.
            rmSync(stop, { force: true });
            await cs(["write", "--tab-name", name,
              `i=0; while [ ! -e ${shellQuote(stop)} ] && [ $i -lt 600 ]; do printf 'HO%sLD\\n' ''; sleep .2; i=$((i+1)); done\n`]);
            const holdDeadline = Date.now() + 15_000;
            while (!(await cs(["scrollback", "--tab-name", name])).stdout.includes("HOLD")) {
              if (Date.now() > holdDeadline) throw new Error("precondition: the shell never started holding the queue");
              await sleep(200);
            }

            // Step 2: stop control. Submit again, catch the pending prompt,
            // and press while it waits.
            const keyboardSubmit = (draft) => async () => {
              await page.click(`${card} .cm-content`);
              await page.keyboard.down("Control");
              await page.keyboard.press("KeyA");
              await page.keyboard.up("Control");
              await page.keyboard.type(draft);
              await page.keyboard.down("Control");
              await page.keyboard.press("Enter");
              await page.keyboard.up("Control");
            };
            const recallText = `${text}-recall`;
            if (!(await catchPending(page, card, keyboardSubmit(recallText)))) {
              throw new Error("never caught a pending prompt in 4 submits");
            }
            result.steps.recallPress = (await pressSubmit(page, card, "294-recall-press", shot)).record;
            result.steps.recall = await waitFor(page, card, "the run recalls",
              (value) => (!value.pending && value.text === recallText ? value : false), 10_000);
            assert.equal(result.steps.recall.where, "composer", "focus holds through the recall");
            await shot(`294-${backend}-recalled`);

            // The failed recall: the cancel frame never goes out, so the
            // ack timer fails the run instead. The drop is installed before
            // the catch so no cancel can slip out first.
            await page.evaluate(() => {
              window.__prompt294.dropCancel = true;
            });
            const failText = `${text}-recall-fail`;
            if (!(await catchPending(page, card, keyboardSubmit(failText)))) {
              throw new Error("never caught a pending prompt for the failed recall");
            }
            result.steps.failedPress = (await pressSubmit(page, card, "294-failed-press", shot)).record;
            await sleep(6500);
            const failed = await focusState(page, card);
            const dropped = await page.evaluate(() => window.__prompt294.droppedCancels);
            assert.ok(dropped > 0, "the cancel frame was dropped");
            assert.equal(failed.where, "composer", "focus holds through the failed recall");
            assert.equal(failed.text, failText, "the failed recall keeps the text");
            await page.evaluate(() => {
              window.__prompt294.dropCancel = false;
            });
            result.steps.failedRecall = { where: failed.where, text: failed.text, dropped };
            await shot(`294-${backend}-failed`);

            // The secondary action, when the window has a queued prompt to
            // recall. Absent here unless a submit left one queued.
            const secondary = await page.$(`${card} .rp-action:not(.rp-primary)`);
            if (secondary) {
              const point = await installPressRecord(page, `${card} .rp-action:not(.rp-primary)`);
              await page.mouse.move(point.x, point.y);
              await page.mouse.down();
              await sleep(250);
              const held = await focusState(page, card);
              const secondaryRecord = await readPressRecord(page);
              await page.mouse.up();
              try {
                assert.equal(held.where, "composer", "the secondary press holds the composer");
              } catch (error) {
                throw new Error(`${error.message}\nPRESS RECORD: ${JSON.stringify(secondaryRecord)}`);
              }
              result.steps.secondary = { where: held.where, record: secondaryRecord };
            } else {
              result.steps.secondary = "absent: no queued prompt to recall";
            }
            writeFileSync(stop, "");

            // Two panes: B's composer is open while A is active. A real
            // click on B's Submit sends without activating B.
            await dispatchCommand(page, "app.pane.splitRight");
            await page.waitForFunction(
              () => document.querySelectorAll(".pane[data-pane-id]").length === 2,
              { timeout: 10_000 },
            );
            const emptyPane = await page.evaluate(() => {
              const panes = [...document.querySelectorAll(".pane[data-pane-id]")];
              const empty = panes.find((pane) => !pane.querySelector(".terminal-tab"));
              if (!empty) return null;
              const box = empty.getBoundingClientRect();
              return { id: empty.getAttribute("data-pane-id"), x: box.left + box.width / 2, y: box.top + 40 };
            });
            assert.ok(emptyPane, "the split leaves an empty pane");
            await page.mouse.click(emptyPane.x, emptyPane.y);
            await page.waitForFunction(
              (id) => document.querySelector(".pane.focused")?.getAttribute("data-pane-id") === id,
              { timeout: 10_000 },
              emptyPane.id,
            );
            const nameB = `${name}-B`;
            const textB = `${text}-B`;
            const rowB = await openAttachedTerminal(ctx, page, cs, windowId, nameB, backend);
            const attachmentB = await readTerminalAttachment(page, cs, backend, (entry) => entry.session_id === rowB.session_id);
            assert.ok(attachmentB.attached, "the second terminal is attached");
            const cardB = `${attachmentB.selector} .rich-prompt`;
            await page.click(`${attachmentB.selector} .terminal-host`);
            await page.keyboard.down("Control");
            await page.keyboard.down("Alt");
            await page.keyboard.press("KeyP");
            await page.keyboard.up("Alt");
            await page.keyboard.up("Control");
            await page.waitForSelector(`${cardB} .cm-content`, { visible: true, timeout: 15_000 });
            await page.click(`${cardB} .cm-content`);
            await page.keyboard.type(textB);
            await waitFor(page, cardB, "B's draft is editable",
              (value) => value.text === textB && value.editable && !value.pending);
            await page.click(`${terminal} .terminal-host`);
            const paneA = await activePaneId(page);
            const pointB = await installPressRecord(page, `${cardB} .rp-primary`);
            await page.mouse.move(pointB.x, pointB.y);
            await page.mouse.down();
            await sleep(250);
            const heldB = await focusState(page, cardB);
            const recordB = await readPressRecord(page);
            await page.mouse.up();
            try {
              assert.equal(heldB.where, "composer", "the press holds B's composer");
            } catch (error) {
              throw new Error(`${error.message}\nPRESS RECORD: ${JSON.stringify(recordB)}`);
            }
            const sentB = await waitFor(page, cardB, "B's submit sends and clears",
              (value) => (value.text === "" && !value.pending ? value : false));
            const promptsB = await page.evaluate(
              (tab) => window.__prompt294.prompts.filter((prompt) => prompt.tab === tab),
              nameB,
            );
            assert.equal(promptsB.length, 1, "exactly one prompt left B");
            assert.equal(promptsB[0].data, textB);
            assert.equal(sentB.where, "composer", "B's composer keeps the keyboard");
            assert.equal(await activePaneId(page), paneA, "A is still the active pane");
            result.steps.twoPane = { pane: paneA, prompts: promptsB.length, record: recordB };
            await shot(`294-${backend}-twopane`);

            // The image leg only records: whether the composer takes focus
            // when the paths arrive and whether B activates are open owner
            // questions, so the check reports them without failing on them.
            const imageText = `![box](${boxPath})`;
            await page.click(`${cardB} .cm-content`);
            await page.keyboard.type(imageText);
            await waitFor(page, cardB, "the image draft is editable",
              (value) => value.text.includes("box294.png") && value.editable && !value.pending);
            const pointI = await installPressRecord(page, `${cardB} .rp-primary`);
            await page.mouse.move(pointI.x, pointI.y);
            await page.mouse.down();
            await sleep(250);
            const heldI = await focusState(page, cardB);
            const recordI = await readPressRecord(page);
            await page.mouse.up();
            const samples = [{ at: 0, focus: heldI.where, pane: await activePaneId(page).catch(() => null) }];
            for (let elapsed = 250; elapsed <= 6000; elapsed += 250) {
              await sleep(250);
              const seen = await focusState(page, cardB);
              samples.push({ at: elapsed, focus: seen.where, pane: await activePaneId(page).catch(() => null) });
              if (seen.text === "" && !seen.pending) break;
            }
            result.steps.image = {
              heldFocus: heldI.where,
              record: recordI,
              samples,
              composerFocusedAtEnd: samples[samples.length - 1].focus === "composer",
              paneBecameActive: samples.some((sample) => sample.pane && sample.pane !== paneA),
            };
            await shot(`294-${backend}-image`);

            // A deck run opened over Search returns to the Search input.
            await dispatchCommand(page, "app.search.toggle");
            await page.waitForSelector(".search .head input", { visible: true, timeout: 15_000 });
            const searchInput = ".search .head input";
            await page.click(searchInput);
            await page.waitForFunction(
              (selector) => document.activeElement === document.querySelector(selector),
              { timeout: 15_000 },
              searchInput,
            );
            await dispatchCommand(page, "app.launcher.toggle");
            await page.waitForSelector('[role="dialog"][aria-label="Command launcher"] .deck-input', {
              visible: true,
              timeout: 15_000,
            });
            await page.keyboard.type("Copy scrollback");
            await page.waitForFunction(
              (title) =>
                document.querySelector('[role="option"][aria-selected="true"] .deck-result-title')?.textContent?.trim() ===
                title,
              { timeout: 15_000 },
              "Copy scrollback",
            );
            await page.keyboard.press("Enter");
            await page.waitForFunction(
              (selector) => document.activeElement === document.querySelector(selector),
              { timeout: 15_000 },
              searchInput,
            );
            await page.keyboard.type("Q");
            const query = await page.$eval(searchInput, (input) => input.value);
            assert.ok(query.includes("Q"), `typed text lands in the Search input, got ${JSON.stringify(query)}`);
            await shot(`294-${backend}-search`);
            result.steps.search = { query };
            await dispatchCommand(page, "app.search.toggle");

            result.passed = true;
          } catch (error) {
            result.failure = String(error.message ?? error);
            failures.push(`${backend}: ${result.failure}`);
            result.final = await focusState(page, null).catch(() => null);
            await shot(`294-${backend}-failure`).catch(() => {});
          } finally {
            page.off("pageerror", onError);
            try { writeFileSync(stop, ""); } catch (error) { result.cleanupErrors.push(`queue release: ${error.message}`); }
            if (opened) {
              await page
                .evaluate(() => Boolean(document.querySelector(".search .head input")))
                .then((open) => (open ? dispatchCommand(page, "app.search.toggle") : null))
                .catch((error) => {
                  result.cleanupErrors.push(`search close: ${error.message}`);
                });
              await closeExtraPanes(page).catch((error) => {
                result.cleanupErrors.push(`pane cleanup: ${error.message}`);
              });
              await closeEveryTerminal(page, "cleanup", token).catch((error) => {
                result.cleanupErrors.push(`terminal cleanup: ${error.message}`);
              });
            }
            writeFileSync(join(ctx.outDir, `294-${backend}.json`), `${JSON.stringify(result, null, 2)}\n`);
          }
          if (result.passed && result.pageErrors.length) {
            result.passed = false;
            failures.push(`${backend}: browser exceptions: ${result.pageErrors.join("; ")}`);
          }
        }
      } finally {
        await page.evaluate(() => window.__prompt294?.restore?.());
      }
    } finally {
      await writeTerminalPrefs(page, token, { ghostty: original.ghostty });
    }
    if (failures.length) throw new Error(failures.join("\n"));
  },
};
