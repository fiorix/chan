// A real pointer press on the Rich Prompt's strip keeps the keyboard on
// the composer: with the button held the composer's field stays focused,
// and after the release the next key reaches it with no click. The same
// hold keeps focus through a recall and a failed recall, made while the
// shell prints so that each submit is still queued at the press, and a
// two-pane press moves no focus, then sends and gives the keyboard to that
// pane's composer while the other pane stays the active one, as today. A
// deck run opened over Search returns to the Search input. The red variant
// of this check runs the same file on a tree with the strip's pointerdown
// handler removed: step 1 then fails on any engine that focuses a button on
// a press.
//
// What jsdom cannot see (a real press focusing a button) is why this is a
// guest check: the mounted suite pins the handler, this pins the effect.

import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { closeEveryTerminal, closeExtraPanes, dispatchCommand } from "../lib/pane-strip.mjs";
import { openAttachedTerminal, readTerminalAttachment } from "../lib/terminal-attach.mjs";

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
async function openComposer(ctx, page, cs, windowId, name, text) {
  const row = await openAttachedTerminal(ctx, page, cs, windowId, name);
  const attachment = await readTerminalAttachment(page, cs, (entry) => entry.session_id === row.session_id);
  assert.ok(attachment.attached, "the terminal is attached");
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
/// Press at `point`, run `read` with the button held, and release the
/// button whatever `read` finds or throws, so a failed hold leaves no
/// pressed button behind for the cleanup to trip over.
async function holdPress(page, point, read) {
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  try {
    await sleep(250);
    return await read();
  } finally {
    await page.mouse.up();
  }
}

async function pressSubmit(page, card, label, shot) {
  const point = await installPressRecord(page, `${card} .rp-primary`);
  const { held, record } = await holdPress(page, point, async () => {
    const reading = { held: await focusState(page, card), record: await readPressRecord(page) };
    await shot(label);
    return reading;
  });
  try {
    assert.equal(held.where, "composer", `${label}: the press holds the composer`);
  } catch (error) {
    throw new Error(`${error.message}\nPRESS RECORD: ${JSON.stringify(record)}`);
  }
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
    const shot = (label) => ctx.shot(`294-${label}`).catch(() => {});
    const failures = [];
    await page.evaluate(tracePrompts);
    try {
      const name = "Press294";
      const text = "PROMPT294";
      const result = { passed: false, pageErrors: [], cleanupErrors: [], steps: {} };
      const onError = (error) => result.pageErrors.push(String(error));
      page.on("pageerror", onError);
      let opened = false;
      const stop = join(ctx.workspaceDir, ".press294.stop");
      try {
        const { card, terminal } = await openComposer(ctx, page, cs, windowId, name, text);
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
        await shot("294-pressed");
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
        await shot("294-recalled");

        // The failed recall: the cancel frame never goes out, so the
        // ack timer fails the run instead. The drop is installed before
        // the catch so no cancel can slip out first. The counter delta
        // proves this recall dropped its cancel; the composer's failure
        // note proves the recall failed rather than went through.
        const droppedBefore = await page.evaluate(() => window.__prompt294.droppedCancels);
        await page.evaluate(() => {
          window.__prompt294.dropCancel = true;
        });
        const failText = `${text}-recall-fail`;
        if (!(await catchPending(page, card, keyboardSubmit(failText)))) {
          throw new Error("never caught a pending prompt for the failed recall");
        }
        result.steps.failedPress = (await pressSubmit(page, card, "294-failed-press", shot)).record;
        const failed = await waitFor(page, card, "the failed recall says the connection was lost",
          (value) => value.note === "connection lost, message may still be queued", 9000);
        const dropped = (await page.evaluate(() => window.__prompt294.droppedCancels)) - droppedBefore;
        assert.ok(dropped > 0, "this leg dropped its own cancel frame");
        assert.equal(failed.where, "composer", "focus holds through the failed recall");
        assert.equal(failed.text, failText, "the failed recall keeps the text");
        await page.evaluate(() => {
          window.__prompt294.dropCancel = false;
        });
        result.steps.failedRecall = { where: failed.where, text: failed.text, dropped };
        await shot("294-failed");

        // The secondary action: the failed recall's prompt is still
        // queued behind the printing shell, and recall is offered once
        // the composer is empty. A disabled button cannot take focus, so
        // the press proves nothing unless the button is enabled.
        await page.keyboard.down("Control");
        await page.keyboard.press("KeyA");
        await page.keyboard.up("Control");
        await page.keyboard.press("Backspace");
        await waitFor(page, card, "precondition: the composer is empty", (value) => value.text === "");
        const secondaryButton = `${card} .rp-action:not(.rp-primary)`;
        const secondary = await page.waitForFunction(
          (selector) => {
            const button = document.querySelector(selector);
            return button && !button.disabled ? button.textContent?.trim() || "?" : false;
          },
          { timeout: 5000 },
          secondaryButton,
        ).then((handle) => handle.jsonValue()).catch(() => null);
        if (!secondary) {
          const seen = await page.$eval(secondaryButton, (button) => ({ label: button.textContent?.trim(), disabled: button.disabled }))
            .catch(() => "absent");
          throw new Error(`precondition: an enabled secondary recall once the composer is empty; it reads ${JSON.stringify(seen)}`);
        }
        const secondaryPoint = await installPressRecord(page, secondaryButton);
        const { held, secondaryRecord } = await holdPress(page, secondaryPoint, async () => ({
          held: await focusState(page, card),
          secondaryRecord: await readPressRecord(page),
        }));
        try {
          assert.equal(held.where, "composer", "the secondary press holds the composer");
        } catch (error) {
          throw new Error(`${error.message}\nPRESS RECORD: ${JSON.stringify(secondaryRecord)}`);
        }
        result.steps.secondary = { label: secondary, where: held.where, record: secondaryRecord };
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
        const rowB = await openAttachedTerminal(ctx, page, cs, windowId, nameB);
        const attachmentB = await readTerminalAttachment(page, cs, (entry) => entry.session_id === rowB.session_id);
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
        // The press moves no focus: A's element keeps the keyboard while
        // B's button is held. Only the submit itself may then focus B's
        // composer.
        const pointB = await installPressRecord(page, `${cardB} .rp-primary`);
        await page.evaluate(() => { window.__heldBefore294 = document.activeElement; });
        const { heldB, unmovedB, recordB } = await holdPress(page, pointB, async () => ({
          heldB: await focusState(page, cardB),
          unmovedB: await page.evaluate(() => document.activeElement === window.__heldBefore294),
          recordB: await readPressRecord(page),
        }));
        try {
          assert.ok(unmovedB, `the press on B's button moves no focus (held at ${heldB.where})`);
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
        await shot("294-twopane");

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
        // A run and a dismissal both hand the keyboard back to Search;
        // the command the run dispatches tells them apart.
        const queryBefore = await page.$eval(searchInput, (input) => input.value);
        await page.evaluate(() => {
          if (!window.__commands294) {
            window.__commands294 = [];
            window.addEventListener("chan:command", (event) => window.__commands294.push(event.detail?.name), true);
          }
        });
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
        await page.evaluate(() => { window.__commands294.length = 0; });
        await page.keyboard.press("Enter");
        await page.waitForFunction(
          (selector) => document.activeElement === document.querySelector(selector),
          { timeout: 15_000 },
          searchInput,
        );
        const dispatched = await page.evaluate(() => window.__commands294.slice());
        assert.ok(dispatched.includes("app.terminal.copyScrollback"),
          `the deck ran Copy scrollback rather than closing: it dispatched ${JSON.stringify(dispatched)}`);
        await page.keyboard.type("Q");
        const query = await page.$eval(searchInput, (input) => input.value);
        assert.equal(query, `${queryBefore}Q`, "typed text lands in the Search input");
        await shot("294-search");
        result.steps.search = { queryBefore, query, dispatched };
        await dispatchCommand(page, "app.search.toggle");

        result.passed = true;
      } catch (error) {
        result.failure = String(error.message ?? error);
        failures.push(result.failure);
        result.final = await focusState(page, null).catch(() => null);
        await shot("294-failure").catch(() => {});
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
        writeFileSync(join(ctx.outDir, "294-result.json"), `${JSON.stringify(result, null, 2)}\n`);
      }
      if (result.passed && result.pageErrors.length) {
        result.passed = false;
        failures.push(`browser exceptions: ${result.pageErrors.join("; ")}`);
      }
    } finally {
      await page.evaluate(() => window.__prompt294?.restore?.());
    }
    if (failures.length) throw new Error(failures.join("\n"));
  },
};
