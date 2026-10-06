#!/usr/bin/env node
// The timed step of hide-flush.sh, in one process so that nothing but the
// step itself sits between the last keystroke and the hide.
//
// It types a marker into the focused editor through X and waits until the
// page itself, read through the engine's remote inspector, says its editor
// holds the whole marker. It then records what was already stored: any of
// the marker in the page's localStorage, and the marker in the note's file.
// It ends the page in the arm's way and times how long after the first
// keystroke the native window was gone. Last, it reads localStorage again
// through another page of the same origin, which outlives the ended one,
// for the recovery buffer and for the witness of a `pagehide` event that it
// planted in the page before typing. It prints one JSON object.
//
// Options: --inspector HOST:PORT --page URL-SUBSTRING --witness-page TEXT
//          --xid X-WINDOW-ID --marker TEXT --note-file PATH
//          --mode hide|kill|settled|rest --window WINDOW-ID --chan PATH
//          --desktop-pid PID [--uninspected] [--stroke X,Y]
//          [--kill-after-ms N]
// `--uninspected` attaches no inspector to the page under test and plants no
// witness, for an arm that shows the inspector's presence is not what kept
// the edit; its input is given a fixed 150 ms to arrive instead.
//
// `--stroke X,Y` draws a pen stroke on a drawing board from that point in
// place of typing. The marker is then the text a stored stroke carries
// ("freedraw") and is looked for only in storage keys that name the note's
// file. The board serializes 200 ms after its last change, so a stroke is
// pending for that long after its last pointer event and the caller holds
// the page's end to that bound. `--mode rest` ends nothing: it times how
// long the file takes to receive a stroke when the page is left alone,
// which is the board's wait as this run met it. `--kill-after-ms N` holds a
// kill until N ms after the input ended, to match a hide arm's timing.
import { spawnSync } from "node:child_process";
import { basename } from "node:path";
import { readFileSync } from "node:fs";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, word, index, all) => {
    if (word.startsWith("--")) pairs.push([word.slice(2), all[index + 1]?.startsWith("--") || all[index + 1] === undefined ? true : all[index + 1]]);
    return pairs;
  }, []),
);
const now = () => Number(process.hrtime.bigint() / 1000000n);

async function pageSocket(match) {
  const html = await (await fetch(`http://${args.inspector}/`, { signal: AbortSignal.timeout(5000) })).text();
  for (const [, cells] of html.matchAll(/<tr[^>]*>(.*?)<\/tr>/gs)) {
    const path = /\/socket\/\d+\/\d+\/\w+/.exec(cells)?.[0];
    if (path && cells.includes(match)) return `ws://${args.inspector}${path}`;
  }
  throw new Error(`no inspectable page matches ${match}`);
}

// One inspector connection that answers `evaluate(expression)`.
async function attach(match) {
  const ws = new WebSocket(await pageSocket(match));
  let target = null;
  let next = 1;
  const waiting = new Map();
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the inspector named no page target in 8s")), 8000);
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.method === "Target.targetCreated" && message.params.targetInfo.type === "page" && !target) {
        target = message.params.targetInfo.targetId;
        clearTimeout(timer);
        resolve();
      } else if (message.method === "Target.dispatchMessageFromTarget") {
        const inner = JSON.parse(message.params.message);
        waiting.get(inner.id)?.(inner);
        waiting.delete(inner.id);
      }
    };
    ws.onerror = () => reject(new Error("cannot reach the inspector"));
  });
  await ready;
  return {
    evaluate(expression) {
      const id = next++;
      const inner = JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true } });
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("the page did not answer in 5s")), 5000);
        waiting.set(id, (answer) => {
          clearTimeout(timer);
          if (answer.error || answer.result?.wasThrown) reject(new Error(JSON.stringify(answer)));
          else resolve(answer.result.result.value);
        });
        ws.send(JSON.stringify({ id, method: "Target.sendMessageToTarget", params: { targetId: target, message: inner } }));
      });
    },
    close: () => new Promise((resolve) => { ws.onclose = resolve; ws.close(); setTimeout(resolve, 500); }),
  };
}

// What the page holds of the marker: in the editor it shows, and in the
// recovery buffers of its localStorage. Any three-character prefix of the
// marker in storage counts as "some of it is already stored".
const stroke = args.stroke ? String(args.stroke).split(",").map(Number) : null;
// For a stroke, only the buffers of the note's own file count.
const KEY_FILTER = JSON.stringify(stroke ? basename(String(args["note-file"])) : "");
const READ = `(() => {
  const marker = ${JSON.stringify(String(args.marker))};
  const editor = [...document.querySelectorAll(".cm-content")].map((e) => e.innerText).join("\\n");
  const undo = [...document.querySelectorAll(".excalidraw button")].filter((b) => b.getAttribute("aria-label") === "Undo" && b.offsetParent !== null);
  const stored = Object.keys(localStorage).filter((k) => k.includes(${KEY_FILTER})).map((k) => [k, localStorage.getItem(k) || ""]);
  return {
    editorHasWholeMarker: ${stroke ? "undo.length > 0 && undo.every((b) => !b.disabled)" : "editor.includes(marker)"},
    editorTail: ${stroke ? "'undo disabled: ' + JSON.stringify(undo.map((b) => b.disabled))" : "editor.slice(-48)"},
    storageKeysWithWholeMarker: stored.filter(([, v]) => v.includes(marker)).map(([k]) => k),
    storageKeysWithMarkerPrefix: stored.filter(([, v]) => v.includes(marker.slice(0, 3))).map(([k]) => k),
    storageKeys: stored.map(([k]) => k),
  };
})()`;

// What another page of the origin reads of the marker once the page under
// test is gone: the recovery buffers, and the witness of its `pagehide`.
const WITNESS_KEY = `chan-observation:pagehide:${args.marker}:${basename(String(args["note-file"]))}`;
const AFTERMATH = `(() => {
  const marker = ${JSON.stringify(String(args.marker))};
  const stored = Object.keys(localStorage).filter((k) => k.includes(${KEY_FILTER})).map((k) => [k, localStorage.getItem(k) || ""]);
  return {
    pagehideWitness: localStorage.getItem(${JSON.stringify(WITNESS_KEY)}),
    storageKeysWithWholeMarker: stored.filter(([k, v]) => !k.startsWith("chan-observation:") && v.includes(marker)).map(([k]) => k),
    storageKeysWithMarkerPrefix: stored.filter(([k, v]) => !k.startsWith("chan-observation:") && v.includes(marker.slice(0, 3))).map(([k]) => k),
  };
})()`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fileHasMarker = () => {
  try { return readFileSync(String(args["note-file"]), "utf8").includes(String(args.marker)); } catch { return null; }
};

const out = { mode: args.mode, marker: args.marker, inspected: !args.uninspected };
try {
  const page = args.uninspected ? null : await attach(args.page);
  if (page) {
    // A witness beside the page's own handlers: it changes nothing they do
    // and says, from storage that outlives the page, that the event came.
    await page.evaluate(`addEventListener("pagehide", () => { try { localStorage.setItem(${JSON.stringify(WITNESS_KEY)}, String(Date.now())); } catch (e) {} }); true`);
  }
  out.typeStartMs = now();
  if (stroke) {
    const [x, y] = stroke;
    const at = (dx, dy) => ["mousemove", "--window", String(args.xid), String(x + dx), String(y + dy)];
    // Give the board the keyboard, choose the pen, draw one stroke.
    spawnSync("xdotool", [...at(0, 0), "click", "1", "sleep", "0.2", "key", "p", "sleep", "0.2"], { encoding: "utf8" });
    out.typeStartMs = now();
    const drawn = spawnSync("xdotool", [...at(0, 0), "mousedown", "1", ...at(40, 30), ...at(100, 60), ...at(160, 100), "mouseup", "1"], { encoding: "utf8" });
    out.typeStatus = drawn.status;
  } else {
    const typed = spawnSync("xdotool", ["type", "--delay", "12", String(args.marker)], { encoding: "utf8" });
    out.typeStatus = typed.status;
  }
  out.typeEndMs = now();
  if (page) {
    // The keystrokes travel through X and the engine after xdotool has
    // returned; the page says when its editor holds them all.
    for (;;) {
      out.before = await page.evaluate(READ);
      if (out.before.editorHasWholeMarker) break;
      if (now() - out.typeStartMs > 300) throw new Error(`the editor did not hold the whole marker 300 ms after the first keystroke; it showed ${JSON.stringify(out.before.editorTail)}`);
    }
    out.editorHeldMarkerAfterMs = now() - out.typeStartMs;
  } else {
    // A board registers a stroke in about 40 ms and holds it for 200.
    await sleep(stroke ? 60 : 150);
  }
  if (args.mode === "settled") {
    // Past the recovery debounce and every save: the edit is stored before
    // the hide, whatever the engine does at the destroy.
    await sleep(2500);
    if (page) out.before = await page.evaluate(READ);
  }
  if (args.mode === "rest") {
    // No page ends here: how long after the input's end does the file take
    // it, left alone?
    const deadline = now() + 5000;
    while (!fileHasMarker()) {
      if (now() > deadline) throw new Error("the file had not taken the input 5 s after it ended");
      await sleep(5);
    }
    out.fileTookMarkerAfterInputEndMs = now() - out.typeEndMs;
    await page.close();
    console.log(JSON.stringify(out));
    process.exit(0);
  }
  out.fileHadMarkerBeforeAction = fileHasMarker();
  if (page) await page.close();
  out.actionStartMs = now();
  if (args.mode === "kill") {
    while (args["kill-after-ms"] && now() - out.typeEndMs < Number(args["kill-after-ms"])) await sleep(2);
    out.actionStartMs = now();
    // The newest web process is the page opened last, the one under test.
    const newest = spawnSync("pgrep", ["-n", "-P", String(args["desktop-pid"]), "-f", "WebKitWebProcess"], { encoding: "utf8" }).stdout.trim();
    if (!/^[0-9]+$/.test(newest)) throw new Error("the desktop has no web process to kill");
    const killed = spawnSync("kill", ["-KILL", newest], { encoding: "utf8" });
    out.killedPid = newest;
    out.actionStatus = killed.status;
    if (killed.status !== 0) throw new Error(`killing web process ${newest} failed: ${killed.stderr.trim()}`);
  } else {
    const hidden = spawnSync(args.chan, ["shell", "window", "hide", String(args.window)], { encoding: "utf8" });
    out.actionStatus = hidden.status;
    out.actionOutput = (hidden.stdout + hidden.stderr).trim().slice(0, 300);
  }
  out.actionEndMs = now();
  if (args.mode !== "kill") {
    const deadline = now() + 15000;
    // A pause between looks, so the watching does not take the CPU the
    // desktop needs to end the window.
    while (spawnSync("xdotool", ["getwindowname", String(args.xid)]).status === 0) {
      if (now() > deadline) throw new Error("the native window was still there 15s after the hide");
      await sleep(4);
    }
    out.windowGoneMs = now();
    out.goneAfterFirstKeyMs = out.windowGoneMs - out.typeStartMs;
    out.goneAfterActionStartMs = out.windowGoneMs - out.actionStartMs;
    out.goneAfterInputEndMs = out.windowGoneMs - out.typeEndMs;
  }
  out.actionAfterFirstKeyMs = out.actionEndMs - out.typeStartMs;
  out.actionAfterInputEndMs = out.actionStartMs - out.typeEndMs;
  // Give the ended page's storage writes a moment to reach the origin's
  // other pages, then read them there.
  await sleep(400);
  out.fileHadMarkerAfterAction = fileHasMarker();
  const witness = await attach(String(args["witness-page"]));
  out.aftermath = await witness.evaluate(AFTERMATH);
  await witness.close();
  console.log(JSON.stringify(out));
} catch (error) {
  out.error = String(error);
  console.log(JSON.stringify(out));
  process.exit(3);
}
