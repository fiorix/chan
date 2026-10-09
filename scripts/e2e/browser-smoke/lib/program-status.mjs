import assert from "node:assert/strict";
import { readTerminalPrefs, restoreTerminalPrefs, writeTerminalPrefs } from "./terminal-prefs.mjs";
import { openAttachedTerminal } from "./terminal-attach.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function parseProgramCell(markdown, sessionId) {
  let columns = null;
  for (const line of markdown.split("\n")) {
    if (!line.startsWith("| ")) continue;
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    if (cells.includes("session") && cells.includes("name")) {
      columns = cells;
      continue;
    }
    if (columns && cells[columns.indexOf("session")] === sessionId) {
      return columns.includes("program") ? cells[columns.indexOf("program")] : null;
    }
  }
  throw new Error(`session ${sessionId} absent from cs terminal list`);
}

export function ringProgress(mark) {
  if (mark?.activity !== "ring" || mark.pathLength !== "100") return null;
  const match = /^(\d+(?:\.\d+)?) 100$/.exec(mark.ring ?? "");
  return match ? Number(match[1]) : null;
}

export function statusPrintf(body) {
  assert.match(body, /^[a-zA-Z0-9=/;:_ .%-]+$/, "fixed specification body");
  return `printf '\\033]7501;${body}\\033\\\\'\n`;
}

export function installProgramStatusRecord() {
  const trace = { subject: null, marks: [], frames: [] };
  window.__programStatusTrace = trace;
  const nativeSocket = window.WebSocket;
  window.WebSocket = new Proxy(nativeSocket, {
    construct(target, args) {
      const socket = Reflect.construct(target, args);
      if (new URL(args[0], location.href).pathname === "/api/terminal/ws") {
        socket.addEventListener("message", (event) => {
          if (typeof event.data !== "string") return;
          try {
            const frame = JSON.parse(event.data);
            if (frame.type === "session" || frame.type === "program-status") {
              trace.frames.push(frame);
            }
          } catch { /* A terminal text frame need not be JSON. */ }
        });
      }
      return socket;
    },
  });
  function mark() {
    const tab = [...document.querySelectorAll('[role="tab"]')].find(
      (node) => node.querySelector(".path")?.textContent?.trim() === trace.subject,
    );
    if (!tab) return null;
    const activity = tab.querySelector("[data-program-activity]");
    const attention = tab.querySelector("[data-program-attention]");
    const icon = attention?.querySelector(".program-attention svg");
    const ring = activity?.querySelector("[stroke-dasharray]");
    return {
      active: tab.getAttribute("aria-selected") === "true",
      activity: activity?.getAttribute("data-program-activity") ?? null,
      attention: attention?.getAttribute("data-program-attention") ?? null,
      activityLabel: activity?.getAttribute("aria-label") ?? null,
      attentionLabel: attention?.querySelector('[role="img"]')?.getAttribute("aria-label") ??
        attention?.querySelector(".activity")?.getAttribute("aria-label") ?? null,
      ring: ring?.getAttribute("stroke-dasharray") ?? null,
      pathLength: ring?.getAttribute("pathLength") ?? null,
      shape: icon?.innerHTML ?? null,
      dot: Boolean(attention?.querySelector(".dirty.activity")),
    };
  }
  trace.readMark = mark;
  trace.capture = () => {
    const value = mark();
    if (value && JSON.stringify(value) !== JSON.stringify(trace.marks.at(-1))) trace.marks.push(value);
  };
  new MutationObserver(trace.capture).observe(document, {
    subtree: true, childList: true, attributes: true, characterData: true,
  });
}

export async function withProgramStatusTabs(ctx, slug, run) {
  if (!ctx.controlSocket) ctx.skip("control socket not found for the server pid");
  const page = ctx.page;
  const token = new URL(ctx.serverUrl).searchParams.get("t") ?? "";
  const original = await readTerminalPrefs(page, token);
  const windowId = new URL(await page.url()).searchParams.get("w");
  assert.ok(windowId, "browser window id");
  await page.evaluateOnNewDocument(installProgramStatusRecord);
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForSelector(".pane", { timeout: 30_000 });
  await ctx.waitWindowLive(windowId);
  const cs = (args) => ctx.exec(ctx.chanBin, ["shell", "terminal", ...args], {
    cwd: ctx.workspaceDir,
    env: { ...process.env, CHAN_CONTROL_SOCKET: ctx.controlSocket, CHAN_WINDOW_ID: windowId },
    timeout: 90_000,
  });
  const failures = [];
  try {
    for (const backend of ["xterm", "ghostty"]) {
      const subject = `Status${slug}${backend}S`;
      const front = `Status${slug}${backend}F`;
      await writeTerminalPrefs(page, token, { ghostty: backend === "ghostty" });
      let openedSubject = false;
      let openedFront = false;
      try {
        const subjectRow = await openAttachedTerminal(ctx, page, cs, windowId, subject, backend);
        openedSubject = true;
        await page.evaluate((name) => {
          window.__programStatusTrace.subject = name;
          window.__programStatusTrace.marks.length = 0;
          window.__programStatusTrace.capture();
        }, subject);
        await openAttachedTerminal(ctx, page, cs, windowId, front, backend);
        openedFront = true;
        const toolkit = {
          backend, page, subject, subjectRow,
          async sendReport(body) {
            await cs(["write", "--tab-name", subject, statusPrintf(body)]);
          },
          async sendOutput(value) {
            assert.match(value, /^[a-zA-Z0-9_]+$/, "fixed output marker");
            await cs(["write", "--tab-name", subject, `printf '%s\\n' '${value}'\n`]);
          },
          async read() {
            const listed = await cs(["list", "--json"]);
            const rows = Object.values(JSON.parse(listed.stdout).groups ?? {}).flat();
            const row = rows.find((entry) => entry.session_id === subjectRow.session_id);
            assert.ok(row, `subject ${subjectRow.session_id} remains listed`);
            const plain = await cs(["list"]);
            const pageState = await page.evaluate(() => {
              const trace = window.__programStatusTrace;
              trace.capture();
              return { mark: trace.readMark(), marks: trace.marks, frames: trace.frames };
            });
            return { row, programCell: parseProgramCell(plain.stdout, subjectRow.session_id), ...pageState };
          },
          async wait(label, predicate, timeoutMs = 15_000) {
            const deadline = Date.now() + timeoutMs;
            let latest;
            do {
              latest = await this.read();
              if (predicate(latest)) {
                await ctx.shot(`${backend}-${label}`, page);
                return latest;
              }
              await sleep(200);
            } while (Date.now() < deadline);
            throw new Error(`${backend} ${label} absent; last=${JSON.stringify(latest)}`);
          },
          async focus(name) {
            const tabs = await page.$$('div[role="tab"]');
            for (const tab of tabs) {
              if (await tab.$eval(".path", (node) => node.textContent?.trim()).catch(() => null) === name) {
                await tab.click();
                return;
              }
            }
            throw new Error(`tab ${name} missing`);
          },
          focusSubject() { return this.focus(subject); },
          focusFront() { return this.focus(front); },
        };
        await run(toolkit);
      } catch (error) {
        failures.push(`${backend}: ${error.stack ?? error}`);
        await ctx.shot(`${backend}-failure`, page).catch(() => {});
      } finally {
        if (openedFront) await cs(["close", "--tab-name", front]);
        if (openedSubject) await cs(["close", "--tab-name", subject]);
      }
    }
  } finally {
    await restoreTerminalPrefs(ctx, page, token, original);
  }
  if (failures.length) throw new Error(failures.join("\n"));
}
