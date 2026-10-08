import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function installRecorder() {
  const probe = window.__uploadRequestProbe = { commands: [], clicks: 0, sockets: [] };
  const NativeWebSocket = window.WebSocket;
  window.WebSocket = class extends NativeWebSocket {
    constructor(url, protocols) {
      if (protocols === undefined) super(url);
      else super(url, protocols);
      if (new URL(url, location.href).pathname.endsWith("/ws")) {
        probe.sockets.push(this);
        this.addEventListener("message", (event) => {
          let frame;
          try { frame = JSON.parse(event.data); } catch { return; }
          if (frame.type === "window_command" && frame.command === "upload") {
            probe.commands.push({ path: frame.path, root: frame.root, active: navigator.userActivation?.isActive === true });
          }
        });
      }
    }
  };
  const click = HTMLInputElement.prototype.click;
  HTMLInputElement.prototype.click = function (...args) {
    if (this.type === "file") probe.clicks++;
    return click.apply(this, args);
  };
}

function assertSeparated(rectangles) {
  for (let i = 0; i < rectangles.length; i++) {
    for (let j = i + 1; j < rectangles.length; j++) {
      const a = rectangles[i], b = rectangles[j];
      assert.ok(a.bottom <= b.top || b.bottom <= a.top || a.right <= b.left || b.right <= a.left, "request surfaces overlap");
    }
  }
}

export default {
  name: "command-upload-request",
  async run(ctx) {
    if (!ctx.controlSocket) ctx.skip("command upload needs the isolated server's control socket");
    assertSeparated([{ top: 0, bottom: 10, left: 0, right: 10 }, { top: 12, bottom: 20, left: 0, right: 10 }]);
    assert.throws(() => assertSeparated([{ top: 0, bottom: 10, left: 0, right: 10 }, { top: 5, bottom: 15, left: 0, right: 10 }]), /overlap/);
    const { page } = ctx;
    const cdp = await page.createCDPSession();
    const windowId = new URL(page.url()).searchParams.get("w");
    assert.ok(windowId);
    const transferKey = `chan.transfers:${windowId}`;
    const storedTransfers = `sessionStorage.getItem(${JSON.stringify(transferKey)})`;
    const env = { ...process.env, CHAN_CONTROL_SOCKET: ctx.controlSocket, CHAN_WINDOW_ID: windowId };
    const prefix = `command-upload-${Date.now()}`;
    const destination = join(ctx.workspaceDir, prefix);
    mkdirSync(destination);
    const picked = join(ctx.outDir, `${prefix}-picked.txt`);
    const immediate = join(ctx.outDir, `${prefix}-immediate.txt`);
    writeFileSync(picked, "chosen by the attended upload request\n");
    writeFileSync(immediate, "chosen by the immediate upload request\n");
    const observations = { commands: [], layouts: [] };

    async function read(expression) {
      const response = await cdp.send("Runtime.evaluate", { expression: `JSON.stringify(${expression})`, returnByValue: true, userGesture: false });
      if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
      return JSON.parse(response.result.value);
    }
    async function wait(expression, label) {
      const end = Date.now() + 30_000;
      for (;;) {
        const value = await read(expression);
        if (value) return value;
        if (Date.now() > end) throw new Error(`waiting for ${label}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    async function command() {
      const count = await read("window.__uploadRequestProbe.commands.length");
      await ctx.exec(ctx.chanBin, ["shell", "upload", prefix], { cwd: ctx.workspaceDir, env });
      await wait(`window.__uploadRequestProbe.commands.length === ${count + 1}`, "the upload command's page-side receipt");
      const receipt = await read("window.__uploadRequestProbe.commands.at(-1)");
      observations.commands.push(receipt);
      return receipt;
    }
    async function layout(label, count) {
      const snapshot = await read(`(() => {
        const corner = document.querySelector('.request-corner');
        const rectangles = [...document.querySelectorAll('.request-card, .transfer-bubble')].map(node => {
          const {top,bottom,left,right} = node.getBoundingClientRect();
          return {label:node.getAttribute('aria-label'),top,bottom,left,right};
        });
        return {rectangles,height:innerHeight,scrollHeight:corner.scrollHeight,clientHeight:corner.clientHeight};
      })()`);
      assert.equal(snapshot.rectangles.length, count, label);
      assertSeparated(snapshot.rectangles);
      observations.layouts.push({ label, ...snapshot });
      return snapshot;
    }
    async function inject(frame) {
      // Layout fixtures enter the real window-command listener; no product state import or alternate card implementation is used.
      await read(`(() => {
        const socket = window.__uploadRequestProbe.sockets.find(socket => new URL(socket.url).pathname === '/ws' && socket.readyState === WebSocket.OPEN);
        if (!socket) throw new Error('window watch socket missing');
        socket.dispatchEvent(new MessageEvent('message', {data:${JSON.stringify(JSON.stringify({ type: "window_command", window_id: windowId, ...frame }))}}));
        return true;
      })()`);
    }
    const request = '[aria-label="Upload request"]';
    try {
      await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
      await page.evaluateOnNewDocument(installRecorder);
      await page.reload({ waitUntil: "domcontentloaded" });
      await wait("Boolean(document.querySelector('.pane'))", "the pane without granting activation");
      await ctx.waitWindowLive(windowId);
      assert.equal(await read("navigator.userActivation.isActive"), false, "fresh document has no gesture");
      const initialTransfers = await read(storedTransfers);
      assert.deepEqual(JSON.parse(initialTransfers || "{}").items ?? [], []);

      const inactive = await command();
      assert.equal(inactive.active, false, "record activation before the product's command listener runs");
      assert.equal(await read("window.__uploadRequestProbe.clicks"), 0, "an inactive command must not attempt a chooser");
      await wait(`Boolean(document.querySelector(${JSON.stringify(request)}))`, "the attended upload card");
      assert.equal(await read(storedTransfers), initialTransfers, "no byte transfer before selection");
      assert.ok(await read(`document.querySelector(${JSON.stringify(request)}).contains(document.activeElement)`));
      const picker = page.waitForFileChooser({ timeout: 15_000 });
      await page.click(`${request} .rc-confirm`);
      await (await picker).accept([picked]);
      await ctx.pollFile(join(destination, `${prefix}-picked.txt`));
      assert.deepEqual(readFileSync(join(destination, `${prefix}-picked.txt`)), readFileSync(picked));
      await wait(`JSON.parse(${storedTransfers} || '{}').items?.filter(item => item.state === 'done').length === 1`, "one completed selected-file transfer");
      await ctx.shot("attended-upload");

      await page.click(".pane");
      const immediatePicker = page.waitForFileChooser({ timeout: 15_000 }).then((chooser) => ({ chooser }), (error) => ({ error }));
      const active = await command();
      if (!active.active) ctx.skip("live-activation arm not exercised: activation lapsed before the command's recorded receipt");
      const opened = await immediatePicker;
      if (opened.error) throw opened.error;
      assert.equal(await read(`document.querySelector(${JSON.stringify(request)}) === null`), true, "a live command needs no extra action");
      await opened.chooser.accept([immediate]);
      await ctx.pollFile(join(destination, `${prefix}-immediate.txt`));
      assert.deepEqual(readFileSync(join(destination, `${prefix}-immediate.txt`)), readFileSync(immediate));
      await wait(`JSON.parse(${storedTransfers} || '{}').items?.filter(item => item.state === 'done').length === 2`, "two completed uploads");

      // The departing page persists on pagehide, so clear only after that write.
      await page.evaluateOnNewDocument((key) => sessionStorage.removeItem(key), transferKey);
      await page.reload({ waitUntil: "domcontentloaded" });
      await wait("Boolean(document.querySelector('.pane'))", "the layout pane without granting activation");
      await ctx.waitWindowLive(windowId);
      await read("(navigator.clipboard.readText = () => new Promise(() => {}), true)");
      await inject({ command: "clipboard_read", request_id: "layout-paste", prefer: "text" });
      await wait("Boolean(document.querySelector('[aria-label=\"Paste request\"]'))", "the real pending paste card");
      const alone = await layout("paste alone", 1);
      assert.ok(alone.height - alone.rectangles[0].bottom >= 28 && alone.height - alone.rectangles[0].bottom <= 40, "paste retains its lower-right placement");
      await ctx.shot("paste-alone");
      assert.equal((await command()).active, false);
      await wait(`Boolean(document.querySelector(${JSON.stringify(request)}))`, "upload beside paste");
      await layout("paste and upload", 2);
      await inject({ command: "handover_prompt", request_id: "layout-handover", from_window_id: "layout-peer", from_name: "Layout peer" });
      await wait("Boolean(document.querySelector('[aria-label=\"Handover request\"]'))", "the real handover card");
      await layout("three request cards", 3);
      await ctx.shot("three-requests");

      await read("(document.querySelector('[aria-label=\"show file transfers\"]').click(), true)");
      await wait("Boolean(document.querySelector('.transfer-bubble'))", "request-only Transfers panel");
      assert.equal(await read(`document.querySelectorAll(${JSON.stringify(request)}).length`), 1);
      await layout("panel beside paste and handover", 3);
      await read(`(() => { const buttons = [...document.querySelector(${JSON.stringify(request)}).querySelectorAll('button')]; buttons.find(button => button.textContent === 'Cancel').click(); return true; })()`);
      await wait("document.querySelector('.transfer-bubble') === null", "the empty but still shown panel");
      assert.equal((await command()).active, false);
      await wait(`Boolean(document.querySelector(${JSON.stringify(request)}))`, "pending row in shown empty panel");
      assert.equal(await read(`document.querySelector('.transfer-bubble').contains(document.querySelector(${JSON.stringify(request)}))`), true);
      assert.equal(await read(`document.querySelector(${JSON.stringify(request)}).contains(document.activeElement)`), true);
      assert.notEqual(await read(`getComputedStyle(document.querySelector(${JSON.stringify(request)})).outlineStyle`), "none");

      await page.setViewport({ width: 640, height: 300 });
      const short = await layout("short viewport", 3);
      assert.ok(short.scrollHeight > short.clientHeight, "short windows scroll their shared corner");
      for (const label of ["File transfers", "Paste request", "Handover request"]) {
        const selector = `[aria-label=${JSON.stringify(label)}] button`;
        assert.equal(await read(`(() => {
          const button = document.querySelector(${JSON.stringify(selector)});
          button.scrollIntoView({block:'center'});
          const box = button.getBoundingClientRect();
          return button.contains(document.elementFromPoint(box.left + box.width/2, box.top + box.height/2));
        })()`), true, `${label} is reachable by scrolling`);
      }
      await ctx.shot("short-requests");
      return observations;
    } finally {
      writeFileSync(join(ctx.outDir, "127-command-upload-request.observations.json"), JSON.stringify(observations, null, 2));
      await cdp.detach();
    }
  },
};
