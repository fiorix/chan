
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openAttachedTerminal } from "../lib/terminal-attach.mjs";
import { CASES } from "../lib/native-input/cases.mjs";
import { FIND_TERM_SRC, INSTALL_SRC, READ_SRC, RESET_SRC, WRAP_OPEN_SRC } from "../lib/native-input/page.mjs";
import { validateCaseFile, validateRunSummary } from "../lib/native-input/schema.mjs";
import { NAV_COUNTER_SRC, waitBooted, windowLive, wrapWithRetry } from "../lib/native-input/boot-wait.mjs";
import { recorderIdentity, readWorktreeSha } from "../lib/native-input/identity.mjs";
import { startTerminalFixture } from "../lib/terminal-fixture.mjs";
import { drainPointerInput } from "../lib/terminal-pointer.mjs";

const TAB = "SmokeNativeInputRecord";
const KEY = "__nativeInputTerms343";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function writeClipboardText(page, text) {
  const answer = await page.evaluate(async (value) => {
    try {
      await navigator.clipboard.writeText(value);
      return (await navigator.clipboard.readText()) === value ? null : "the clipboard read back a different text";
    } catch (error) {
      return String(error);
    }
  }, text);
  if (answer) throw new Error(`Chrome refused the clipboard write: ${answer}`);
}

async function pressPasteChord(page) {
  await page.keyboard.down("Control");
  await page.keyboard.down("Shift");
  await page.keyboard.down("KeyV", { commands: ["paste"] });
  await page.keyboard.up("KeyV");
  await page.keyboard.up("Shift");
  await page.keyboard.up("Control");
}

export default {
  name: "native-input-record",
  async run(ctx) {
    const socket = ctx.controlSocket;
    if (!socket) ctx.skip("control socket not found for the server pid");
    const { page } = ctx;
    await page.bringToFront();
    const windowId = await page.evaluate(
      () => new URL(location.href).searchParams.get("w")?.trim() || window.sessionStorage.getItem("chan.session.window")?.trim() || "",
    );
    if (!windowId) throw new Error("could not resolve the page's window id");
    const env = { ...process.env, CHAN_CONTROL_SOCKET: socket, CHAN_WINDOW_ID: windowId };
    const cs = (args, opts = {}) => ctx.exec(ctx.chanBin, ["shell", "terminal", ...args], { cwd: ctx.workspaceDir, env, timeout: 90_000, ...opts });

    const outDir = join(ctx.outDir, "native-input-chrome");
    mkdirSync(outDir, { recursive: true });
    const sha = readWorktreeSha();
    let transport, row, cdp;
    const summary = {
      engine: "chrome-headless",
      engineVersion: await page.browser().version(),
      worktreeSha: sha,
      started: new Date().toISOString(),
      finished: "",
      cases: {},
      notDriven: {},
      boot: { retried: false, attempts: [] },
    };
    const evaluate = (expr) => page.evaluate(expr);
    const failures = [];
    const failKind = (kind) => failures.filter((f) => f.kind === kind).length;
    let frameNavs = 0;
    const onNavigation = () => { frameNavs++; };
    page.on("framenavigated", onNavigation);
    const mask = (s) => String(s ?? "").replaceAll(transport?.env.TERMINAL_FIXTURE_TOKEN ?? "NO_FIXTURE_TOKEN", "[redacted]").replace(/([?&]t=)[^&\s"']*/g, "$1<token>");
    try {
      await page.evaluate(NAV_COUNTER_SRC);
      await windowLive(async () => {
        try {
          await ctx.exec(ctx.chanBin, ["shell", "pane", "list", "--window", windowId, "--json"],
            { cwd: ctx.workspaceDir, env, timeout: 15_000 });
          return true;
        } catch {
          return false;
        }
      }, { label: `window ${windowId}` });
      await waitBooted(evaluate, { label: "workspace page" });
      await page.evaluate(INSTALL_SRC);
      const wrap = await wrapWithRetry(evaluate, WRAP_OPEN_SRC, KEY, { extraNav: () => frameNavs });
      summary.boot = { retried: wrap.retried, attempts: wrap.attempts, prefs: { wrote: false } };
      await page.evaluate(INSTALL_SRC);
      transport = await startTerminalFixture({ logPath: join(outDir, "program-output.bin"), deadlineMs: 20_000 });
      row = await openAttachedTerminal(ctx, page, cs, windowId, TAB, "ghostty", [
        "--command", "stty -opost -echo && " + transport.command,
        ...Object.entries(transport.env).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
      ]);
      const ready = await transport.ready();
      if (!ready.tty || !ready.raw) throw new Error("input fixture requires a raw PTY");
      const hostQuery = `.pane[data-pane-id="${row.pane}"] .terminal-tab.active[data-terminal-tab-id="${row.tab}"] .terminal-host`;
      const hooked = await page.evaluate(`(${FIND_TERM_SRC})(${JSON.stringify(KEY)}, ${JSON.stringify(hostQuery)})`);
      if (hooked !== "hooked") throw new Error("no ghostty-web Terminal holds this tab's terminal host");
      const hookedOnce = await page.evaluate(READ_SRC);
      if (hookedOnce.terms !== 1) throw new Error(`expected one hooked terminal, found ${hookedOnce.terms}`);

      const focus = async () => {
        const box = await page.$eval(hostQuery, (el) => {
          const r = el.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        });
        await page.mouse.click(box.x, box.y);
        await sleep(200);
        const focused = await page.evaluate(() => {
          const ae = document.activeElement;
          return ae ? !!ae.closest(".terminal-host") : false;
        });
        if (!focused) throw new Error("the terminal host is not focused after the click");
      };

      cdp = await page.createCDPSession();
      await cdp.send("Browser.grantPermissions", {
        browserContextId: ctx.browser.id, origin: new URL(ctx.serverUrl).origin,
        permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
      });
      const readSnapshot = () => page.evaluate(READ_SRC);

      const recorderId = recorderIdentity("chrome");
      for (const c of CASES) {
        if (!c.chrome) {
          summary.cases[c.id] = "not-driven";
          summary.notDriven[c.id] = c.chromeReason ?? c.pendingReason ?? "no chrome steps";
          continue;
        }
        const fail = (reason, kind = "property") => {
          failures.push({ name: c.id, kind });
          summary.cases[c.id] = "failed";
          writeFileSync(join(outDir, `${c.id}.error.txt`), `${mask(reason)}\n`);
        };
        let programSetup;
        try {
          await focus();
          const setup = programSetup = await drainPointerInput(transport, c.program ?? "");
          if (setup.input !== (c.programReply ?? "")) throw new Error(`unexpected input before case: ${JSON.stringify(setup.input)}`);
        } catch (error) { fail(`program setup: ${error.message}`, "instrument"); continue; }
        try {
          await page.evaluate(RESET_SRC);
          const composing = await page.evaluate(() => window.__nativeInput.composing).catch(() => null);
          if (composing !== false) {
            fail("composition state is active or unreadable at case start", "instrument");
            continue;
          }
          const offset = transport.records.length;
          let unavailable = null;
          let done = false;
          try {
            for (const step of c.chrome.steps) {
              switch (step.op) {
                case "focus": break; // Focus precedes the recorder reset.
                case "key": await page.keyboard.press(step.key); break;
                case "down": for (const k of step.keys) await page.keyboard.down(k); break;
                case "up": for (const k of step.keys) await page.keyboard.up(k); break;
                case "type": await page.keyboard.type(step.text); break;
                case "sleep": await sleep(step.ms); break;
                case "reset": await page.evaluate(RESET_SRC); break;
                case "clipboard": await writeClipboardText(page, step.text); break;
                case "pasteChord": await pressPasteChord(page); break;
                case "cdp":
                  if (!cdp) { unavailable = `no CDP session for ${step.method}`; break; }
                  try {
                    await cdp.send(step.method, step.params);
                  } catch (err) {
                    unavailable = `${step.method} refused: ${String(err).slice(0, 200)}`;
                    break;
                  }
                  break;
                default: throw new Error(`unknown step op ${step.op}`);
              }
              if (unavailable) break;
            }
          } catch (err) {
            fail(`drive failed: ${String(err).slice(0, 300)}`, "instrument");
            done = true;
          }
          if (done) continue;
          let drained;
          try { drained = await drainPointerInput(transport, "", offset); }
          catch (error) { fail(`PTY barrier: ${error.message}`, "instrument"); continue; }
          let snap;
          try { snap = await readSnapshot(); } catch (err) { fail(`read failed: ${String(err && err.message ? err.message : (typeof err === 'string' ? err : JSON.stringify(err))).slice(0, 300)}`, "instrument"); continue; }
          const ptyBytes = drained.input;
          const untrusted = snap.events.filter((e) => e.isTrusted !== true);
          if (untrusted.length > 0) {
            fail(`${untrusted.length} untrusted events (first: ${JSON.stringify(untrusted[0]).slice(0, 200)})`, "instrument");
            continue;
          }
          const types = new Set(snap.events.map((e) => e.type));
          const missing = (c.expect.dom ?? []).filter((t) => !types.has(t));
          const emitted = snap.bytes.map((b) => b.data).join("");
          // Exclude the separately recorded program reply from input bytes.
          const widgetBytes = emitted.endsWith(drained.reply) ? emitted.slice(0, -drained.reply.length) : emitted;
          const verdict = { status: "ok", reason: "" };
          if (unavailable) {
            verdict.status = "unavailable";
            verdict.reason = unavailable;
          } else if (missing.length > 0) {
            verdict.status = "failed";
            verdict.reason = `missing DOM event types: ${missing.join(",")}`;
            fail(verdict.reason, "property");
          } else if (c.expect.paneTreeFocused && !snap.paneTreeFocused) {
            verdict.status = "failed";
            verdict.reason = "the pane tree filter did not take focus";
            fail(verdict.reason, "property");
          } else if (c.expect.exploratory) {
            const committed = snap.events.some((e) => e.type === "compositionend");
            if (!committed) {
              verdict.status = "unavailable";
              verdict.reason = "no compositionend arrived for the commit attempt";
            } else if (c.witness) {
              verdict.status = "witnessed";
              verdict.reason = "composition observed committing; no byte contract";
            }
          } else if (c.witness) {
            verdict.status = "witnessed";
            verdict.reason = "observed, no byte contract";
          } else if (widgetBytes !== (c.expect.widget ?? "") || ptyBytes !== (c.expect.pty ?? "")) {
            verdict.status = "failed";
            verdict.reason = `widget ${JSON.stringify(widgetBytes)} vs ${JSON.stringify(c.expect.widget)}; pty ${JSON.stringify(ptyBytes)} vs ${JSON.stringify(c.expect.pty)}`;
            fail(verdict.reason, "property");
          }
          const fixture = {
            header: {
              case: c.id,
              title: c.title,
              family: c.family,
              engine: summary.engine,
              engineVersion: summary.engineVersion,
              worktreeSha: summary.worktreeSha,
              producedBy: "trusted CDP input path (page.keyboard and Input.*) through the real app ghostty terminal",
              seam: "widget term.onData in the app plus raw PTY input (adapter plus widget)",
              derivation: c.source,
              recorder: recorderId,
              platform: `${process.platform}-${process.arch}-cdp-us`,
              layout: "cdp-us",
              injected: ["key", "code", "keyCode", "location", "modifiers", "text"],
              isTrustedAll: true,
            },
            setup: { program: c.program ?? "", programReply: programSetup.input, programBarrier: programSetup.reply, barrier: drained.reply, focused: snap.focused, paneTreeFocused: snap.paneTreeFocused, textareaPresent: snap.textareaPresent, terms: snap.terms, ptyOffset: offset },
            steps: c.chrome.steps,
            domEvents: snap.events,
            observed: { widget: widgetBytes, pty: ptyBytes },
            contract: { widget: c.expect.widget, pty: c.expect.pty },
            verdict,
          };
          const schemaErrors = validateCaseFile(fixture);
          if (schemaErrors.length > 0) {
            fail(`schema: ${schemaErrors.join("; ")}`, "instrument");
            continue;
          }
          writeFileSync(join(outDir, `${c.id}.json`), `${JSON.stringify(fixture, null, 2)}\n`);
          summary.cases[c.id] = verdict.status;
        } finally {
          if (c.expect.paneTreeFocused) await page.keyboard.press("Escape");
          if (c.restore) await drainPointerInput(transport, c.restore);
          if (c.family === "composition") {
            await page.keyboard.press("Escape");
            await drainPointerInput(transport);
          }
        }
      }
      summary.finished = new Date().toISOString();
      summary.counts = { preconditions: failKind("instrument"), properties: failKind("property") };
      const summaryErrors = validateRunSummary(summary, CASES.map((c) => c.id));
      if (summaryErrors.length > 0) throw new Error(`summary schema: ${summaryErrors.join("; ")}`);
      writeFileSync(join(outDir, "run-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
      if (failKind("instrument") > 0) {
        throw new Error(`chrome-record: ${failKind("instrument")} instrument failure(s) [${failures.filter((f) => f.kind === "instrument").map((f) => f.name).join(",")}]; results are inconclusive, not a product verdict`);
      } else if (failKind("property") > 0) {
        throw new Error(`chrome-record: failed cases: ${failures.filter((f) => f.kind === "property").map((f) => f.name).join(",")}`);
      } else {
        console.log(`chrome-record: ${Object.entries(summary.cases).map(([id, s]) => `${id}=${s}`).join(" ")}`);
      }
    } catch (err) {
      if (err && err.smokeSkip) throw err;
      throw new Error(mask(err && err.message ? err.message : String(err)));
    } finally {
      page.off("framenavigated", onNavigation);
      const cleanupErrors = [];
      for (const cleanup of [
        () => cdp?.detach(),
        () => row && cs(["close", "--tab-name", TAB]),
        () => transport?.close(),
        () => page.evaluate((key) => {
          for (const off of window.__nativeInput?.uninstallers || []) off();
          delete window.__nativeInput;
          window[key]?.restore();
          delete window[key + ":wrap"];
        }, KEY),
      ]) {
        try { await cleanup(); } catch (error) { cleanupErrors.push(mask(error.message)); }
      }
      if (cleanupErrors.length) {
        writeFileSync(join(outDir, "cleanup-errors.json"), JSON.stringify(cleanupErrors) + "\n");
        throw new Error(`recorder cleanup failed: ${cleanupErrors.join("; ")}`);
      }
    }
  },
};
