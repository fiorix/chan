import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openAttachedTerminal } from "../lib/terminal-attach.mjs";
import { readTerminalPrefs, restoreTerminalPrefs, writeTerminalPrefs } from "../lib/terminal-prefs.mjs";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const reader = join(import.meta.dirname, "../lib/ftrip-reader.mjs");

export function inputHex(path) {
  return readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line))
    .filter((row) => row.type === "input").map((row) => row.hex).join("");
}

async function waitFor(read, accept, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  let lastError;
  while (Date.now() < deadline) {
    try {
      last = await read();
      if (accept(last)) return last;
    } catch (error) {
      lastError = error;
    }
    await pause(50);
  }
  throw new Error(`${label}: last=${JSON.stringify(last)} error=${lastError?.message ?? "none"}`);
}

async function tabPoint(page, name) {
  const point = await page.evaluate((want) => {
    const tab = [...document.querySelectorAll('.tab[role="tab"]')]
      .find((el) => el.querySelector(".path")?.textContent?.trim() === want);
    if (!tab) return null;
    const box = tab.getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }, name);
  if (!point) throw new Error(`tab not found: ${name}`);
  return point;
}

async function clickTab(page, name) {
  const point = await tabPoint(page, name);
  await page.mouse.click(point.x, point.y);
}

async function dragTab(page, source, target) {
  const from = await tabPoint(page, source);
  const to = await tabPoint(page, target);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await page.mouse.up();
}

async function focusEvents(page) {
  return page.evaluate(() => ({
    events: window.__ftripEvents.splice(0),
    active: window.__ftripDescribe(document.activeElement),
  }));
}

export default {
  name: "terminal tab click sends one focus report",
  async run(ctx) {
    if (!ctx.controlSocket) throw new Error("isolated test server has no control socket");
    const { page } = ctx;
    const windowId = await page.evaluate(() =>
      new URL(location.href).searchParams.get("w")?.trim() ||
      sessionStorage.getItem("chan.session.window")?.trim() || "",
    );
    if (!windowId) throw new Error("no window id");
    await ctx.waitWindowLive(windowId);
    const token = new URL(ctx.serverUrl).searchParams.get("t") ?? "";
    const env = { ...process.env, CHAN_CONTROL_SOCKET: ctx.controlSocket, CHAN_WINDOW_ID: windowId };
    const cs = (args) => ctx.exec(ctx.chanBin, ["shell", "terminal", ...args], {
      cwd: ctx.workspaceDir, env, timeout: 30_000,
    });
    await page.evaluate(() => {
      window.__ftripEvents = [];
      window.__ftripDescribe = (node) => {
        if (!(node instanceof Element)) return String(node);
        return `${node.tagName.toLowerCase()}.${[...node.classList].join(".")}`;
      };
      for (const type of ["mousedown", "mouseup", "click", "focusin", "focusout", "dragstart", "dragend"]) {
        document.addEventListener(type, (event) => window.__ftripEvents.push({
          t: performance.now(), type, target: window.__ftripDescribe(event.target),
          related: window.__ftripDescribe(event.relatedTarget),
          active: window.__ftripDescribe(document.activeElement),
        }), true);
      }
    });
    const cdp = await page.createCDPSession();
    const sockets = new Map();
    const frames = [];
    await cdp.send("Network.enable");
    cdp.on("Network.webSocketCreated", (event) => {
      const url = new URL(event.url);
      if (url.pathname.endsWith("/api/terminal/ws")) sockets.set(event.requestId, url.searchParams.get("tab_name"));
    });
    cdp.on("Network.webSocketFrameSent", (event) => {
      if (event.response.opcode !== 1) return;
      try {
        const message = JSON.parse(event.response.payloadData);
        if (message.type === "focus") frames.push({
          t: event.timestamp, tabName: sockets.get(event.requestId), focused: message.focused,
        });
      } catch { /* Binary terminal frames are not focus messages. */ }
    });

    const capture = { engine: await page.browser().version(), readings: [] };
    const originalPrefs = await readTerminalPrefs(page, token);
    let opened = [];
    try {
      for (const backend of ["xterm", "ghostty"]) {
        await writeTerminalPrefs(page, token, { ghostty: backend === "ghostty" });
        const source = `Ftrip${backend}Source`;
        const control = `Ftrip${backend}Control`;
        const path = join(ctx.outDir, `${backend}-input.jsonl`);
        await openAttachedTerminal(ctx, page, cs, windowId, source, backend);
        opened.push(source);
        await cs(["write", "--tab-name", source, `node ${reader} ${path}\n`]);
        await waitFor(() => Promise.resolve(inputHex(path)), () => true, "reader file");
        await waitFor(async () => (await cs(["scrollback", "--tab-name", source])).stdout,
          (text) => text.includes("FTRIP_READY"), "focus mode parsed");
        await openAttachedTerminal(ctx, page, cs, windowId, control, backend);
        opened.push(control);
        const subjectFrames = () => frames.filter((frame) => frame.tabName === source);
        const runAction = async (name, action, expected, expectedMessages) => {
          const beforeHex = inputHex(path);
          const beforeFrames = subjectFrames().length;
          await focusEvents(page);
          await action();
          await waitFor(() => Promise.resolve(inputHex(path)), (hex) => hex.length > beforeHex.length, `${backend} ${name} report`);
          await pause(250);
          const focus = await focusEvents(page);
          const reading = {
            backend, action: name, expected, input: inputHex(path).slice(beforeHex.length),
            messages: subjectFrames().slice(beforeFrames), ...focus,
          };
          capture.readings.push(reading);
          if (reading.input !== expected) {
            throw new Error(`${backend} ${name}: ${reading.input} != ${expected}`);
          }
          if (JSON.stringify(reading.messages.map((message) => message.focused)) !== JSON.stringify(expectedMessages)) {
            throw new Error(`${backend} ${name}: focus messages ${JSON.stringify(reading.messages)} != ${JSON.stringify(expectedMessages)}`);
          }
        };
        await runAction("click-subject", () => clickTab(page, source), "1b5b49", [true]);
        await runAction("click-active", () => clickTab(page, source), "1b5b4f1b5b49", [true]);
        await runAction("click-away", () => clickTab(page, control), "1b5b4f", [false]);
        await runAction("keyboard-jump", async () => {
          await page.keyboard.down("Control");
          await page.keyboard.down("Alt");
          try {
            await page.keyboard.press("1");
          } finally {
            await page.keyboard.up("Alt");
            await page.keyboard.up("Control");
          }
        }, "1b5b49", [true]);
        await runAction("click-away-again", () => clickTab(page, control), "1b5b4f", [false]);
        await runAction("command-jump", () => page.evaluate(() =>
          window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: "app.tab.jump", index: 0 } }))), "1b5b49", [true]);
        await runAction("click-away-before-drag", () => clickTab(page, control), "1b5b4f", [false]);
        await runAction("drag-subject", () => dragTab(page, source, control), "1b5b49", [true]);
        const dragEvents = capture.readings.at(-1).events.map((event) => event.type);
        if (!dragEvents.includes("dragstart") || !dragEvents.includes("dragend")) {
          throw new Error(`${backend} drag-subject: native drag did not start and end: ${JSON.stringify(dragEvents)}`);
        }
        const selected = await page.evaluate(() => document.querySelector('.tab.active .path')?.textContent?.trim());
        if (selected !== source) throw new Error(`${backend} drag-subject: selected ${selected} instead of ${source}`);
        for (const name of opened.reverse()) await cs(["close", "--tab-name", name]);
        opened = [];
      }
      console.log(`FTRIP_RESULT ${JSON.stringify(capture)}`);
    } finally {
      writeFileSync(join(ctx.outDir, "ftrip-cause.json"), JSON.stringify(capture, null, 2));
      for (const name of opened.reverse()) await cs(["close", "--tab-name", name]).catch(() => {});
      await restoreTerminalPrefs(ctx, page, token, originalPrefs);
      await cdp.detach().catch(() => {});
    }
  },
};
