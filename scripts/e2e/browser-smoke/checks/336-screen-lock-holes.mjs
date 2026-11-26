// While the screen lock is up, no key reaches anything under it and no focus
// lands under it, whatever was open when it came up or opens after. The check
// page serves its own lock state (a PIN set, the inactivity timer off) and
// answers each PIN check as the leg wants, as check 305 does. Legs:
//   1. a viewer open at lock time, for each of the four key listeners (an
//      image, audio through the shared overlay, a diagram, a slide deck): the
//      lock paints over it, Escape and its keys reach nothing, and after
//      unlock it is still open and answers them;
//      the slide player in element fullscreen paints in the browser's top
//      layer, over any z-index: the lock leaves fullscreen as it comes up and
//      the unlock asks for it back; a theme change under the lock, with the
//      PIN's key as a live activation, does not put it back over the lock,
//      and neither does a fullscreen request made while the lock is up;
//      audio playing at lock time (the viewer's and the Details panel's)
//      pauses, ignores a play under the lock, and stays paused at its
//      position after unlock; a video opened under the lock does not play;
//      a video in its own fullscreen is paused and the lock is on top;
//   2. the editor's date popover open at lock time: arrows and Enter on the
//      PIN commit no date, and it is still open after unlock;
//   3. a dialog that opens under the lock (the import archive's confirm,
//      arriving when the file picker answers): the PIN keeps the keyboard and
//      a digit lands in it, and the dialog has the keyboard after unlock;
//   4. the find and reopen chords as chan-desktop's key bridge sends them:
//      nothing happens under the lock, and each works after unlock;
//   5. the other listeners on that command bus (the file browser's and the
//      graph's; the pane tree closes under a cover by its own gate): each does
//      nothing under the lock and answers after it;
//   6. the terminal's find input, when a pane swap moves the terminal into
//      the active pane while the PIN field is disabled by a running check:
//      focus stays off it, and the same move after unlock gives it the
//      keyboard.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { showFiles } from "../lib/files.mjs";
import { closeActiveTab, closeEveryTerminal, closeExtraPanes, dispatchCommand, readPaneStrip, selectLauncherCommand } from "../lib/pane-strip.mjs";
import { openAttachedTerminal } from "../lib/terminal-attach.mjs";
import { readTerminalPrefs, restoreTerminalPrefs } from "../lib/terminal-prefs.mjs";
import { LOCK, PATH_PROMPT, checkWindowId, inputValue, keyboardSurface, settle, until } from "../lib/keyboard-layers.mjs";

const PIN = ".screensaver-pin";
const CONFIRM = '[role="dialog"][aria-labelledby="confirm-title"]';
const FIND = ".terminal-find input.find";
const DATE_POPOVER = ".md-date-popover";
const DATE_PILL = ".cm-md-date-pill";
const SLIDE = ".md-slide-preview";
const SLIDE_COUNTER = ".md-slide-preview-counter";
const VIEWERS = ".md-image-zoom, .md-diagram-zoom, .md-pdf-viewer, .md-video-viewer, .md-audio-viewer";

const NOTE = "lock336-note.md";
const DECK_FILE = "lock336-deck.md";
const IMAGE = "lock336.png";
const AUDIO = "lock336.wav";
const LONG_AUDIO = "lock336-long.wav";
const VIDEO = "lock336.webm";
const AUDIO_VIEWER = ".md-audio-viewer audio";
const AUDIO_DETAILS = 'aside[aria-label="Details"] .audio-preview audio';
const VIDEO_VIEWER = ".md-video-viewer video";
// How far a paused element's clock may read apart between two reads.
const CLOCK_EPSILON = 0.05;
const NOTE_TEXT = "# Lock note\n\nDue 2026-03-14 please.\n\n```mermaid\ngraph LR\n  A --> B\n```\n\nThe end.\n";
const DECK_TEXT = `---\nchan:\n  kind: slides\n  slides:\n    aspect_ratio: "16:9"\n---\n\n${["# One\n", "# Two\n", "# Three\n"].join('\n<hr class="chan-page-break">\n\n')}`;
const PNG_BYTES = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg==", "base64");
// A short silent mono PCM WAV: the viewer needs a file it can open, not sound.
const WAV_BYTES = (() => {
  const data = 1600;
  const wav = Buffer.alloc(44 + data);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + data, 4);
  wav.write("WAVEfmt ", 8, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24);
  wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(data, 40);
  return wav;
})();

// A 30 s square wave: audio that is really playing, with a clock to read.
function longWav() {
  const rate = 8000;
  const frames = rate * 30;
  const wav = Buffer.alloc(44 + frames * 2);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + frames * 2, 4);
  wav.write("WAVEfmt ", 8, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(frames * 2, 40);
  for (let frame = 0; frame < frames; frame++) wav.writeInt16LE(frame % 80 < 40 ? 4096 : -4096, 44 + frame * 2);
  return wav;
}

// A real silent WebM recorded in the page from a canvas: no binary fixture,
// and with no audio track the browser's autoplay policy lets it start.
function recordWebm(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const canvas = document.createElement("canvas");
    canvas.width = 160;
    canvas.height = 90;
    const g = canvas.getContext("2d");
    let n = 0;
    const draw = () => { g.fillStyle = `hsl(${(n += 12) % 360} 80% 50%)`; g.fillRect(0, 0, 160, 90); };
    draw();
    const timer = setInterval(draw, 66);
    const recorder = new MediaRecorder(canvas.captureStream(15), { mimeType: "video/webm" });
    const chunks = [];
    recorder.ondataavailable = (event) => chunks.push(event.data);
    recorder.onerror = (event) => reject(new Error(String(event.error)));
    recorder.onstop = async () => {
      clearInterval(timer);
      const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
      let text = "";
      for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      resolve(btoa(text));
    };
    recorder.start(250);
    setTimeout(() => recorder.stop(), 9000);
  }));
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

export default {
  name: "screen-lock-holes",
  async run(ctx) {
    if (!ctx.controlSocket) ctx.skip("control socket not found for the server pid");
    const { page } = ctx;
    const lock = { accept: false, hold: null, verifications: 0, imports: 0, graphReads: 0 };
    const served = { enabled: false, timeout_secs: 300, theme: "plain", pin_set: true };
    await page.setRequestInterception(true);
    page.on("request", async (request) => {
      const path = new URL(request.url()).pathname;
      if (path === "/api/screensaver/verify") {
        lock.verifications += 1;
        if (lock.hold) await lock.hold.promise;
        await request.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ verified: lock.accept }) });
      } else if (path === "/api/screensaver/state") {
        await request.respond({ status: 200, contentType: "application/json", body: JSON.stringify(served) });
      } else {
        if (request.method() === "POST" && path.includes("/metadata/import")) lock.imports += 1;
        if (path.startsWith("/api/graph")) lock.graphReads += 1;
        await request.continue();
      }
    });
    // Every start of a player, counted from the page's first script: a video
    // stopped in the same task it started has a clock that barely moved.
    await page.evaluateOnNewDocument(() => {
      window.__plays336 = 0;
      document.addEventListener("play", () => { window.__plays336 += 1; }, true);
    });
    const load = async () => {
      // A reload, not a goto: the page's URL carries a fragment, and a goto to
      // the same URL is a same-document navigation that keeps the lock up.
      await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForSelector(".pane", { timeout: 30_000 });
      await page.waitForFunction(
        () => performance.getEntriesByType("resource").some((e) => e.name.includes("/api/screensaver/state") && e.responseEnd > 0),
        { timeout: 30_000 },
      );
      await settle(page);
    };
    await load();
    await page.bringToFront();
    const windowId = await checkWindowId(page);
    assert.ok(windowId, "the check page has a window id");
    await ctx.waitWindowLive(windowId);
    const shellEnv = { ...process.env, CHAN_CONTROL_SOCKET: ctx.controlSocket, CHAN_WINDOW_ID: windowId, CHAN_WORKSPACE_PATH: ctx.workspaceDir };
    const shell = (args) => ctx.exec(ctx.chanBin, ["shell", ...args], { cwd: ctx.workspaceDir, env: shellEnv, timeout: 90_000 });
    const cs = (args) => shell(["terminal", ...args]);
    const token = new URL(ctx.serverUrl).searchParams.get("t") ?? "";
    const original = await readTerminalPrefs(page, token);
    const directory = mkdtempSync(join(ctx.workspaceDir, ".screenlock-336-"));
    const archive = join(directory, "archive.tar.zst");
    writeFileSync(archive, "not a real archive");
    writeFileSync(join(ctx.workspaceDir, NOTE), NOTE_TEXT);
    writeFileSync(join(ctx.workspaceDir, DECK_FILE), DECK_TEXT);
    writeFileSync(join(ctx.workspaceDir, IMAGE), PNG_BYTES);
    writeFileSync(join(ctx.workspaceDir, AUDIO), WAV_BYTES);
    writeFileSync(join(ctx.workspaceDir, LONG_AUDIO), longWav());

    // Open the deck's viewer by its chord from the top of the document. The
    // chord does nothing until the tab has parsed the deck, which a loaded
    // host can reach after the editor shows, so the setup presses it again.
    const openDeckViewer = async (shift) => {
      await openFileTab(DECK_FILE);
      await page.waitForSelector(".cm-content", { timeout: 30_000 });
      for (let attempt = 1; ; attempt++) {
        await page.click(".cm-content");
        await page.keyboard.down("Control");
        await page.keyboard.press("Home");
        if (shift) await page.keyboard.down("Shift");
        await page.keyboard.press("Enter");
        if (shift) await page.keyboard.up("Shift");
        await page.keyboard.up("Control");
        const opened = await page.waitForSelector(SLIDE, { timeout: 3000 }).then(() => true, () => false);
        if (opened) return;
        if (attempt >= 5) throw new Error("the deck's viewer did not open from its chord");
      }
    };
    const result = { legs: {}, cleanupErrors: [] };
    let currentLeg = null;
    const lockNow = async () => {
      await dispatchCommand(page, "app.screensaver.lock");
      await page.waitForSelector(LOCK, { timeout: 10_000 });
      await settle(page);
    };
    // Wake the lock's card and wait for its PIN field to hold the keyboard.
    const wake = async (label) => {
      if (!(await page.$(PIN))) await page.keyboard.press("a");
      await page.waitForSelector(PIN, { visible: true, timeout: 3000 }).catch(async () => {
        // The key went somewhere other than the lock: name it, and wake the
        // card with a key aimed at it, since a press would dismiss what the
        // leg is reading.
        result.wakeMissed = [...(result.wakeMissed ?? []), { leg: currentLeg, label, keyboard: await keyboardSurface(page) }];
        await page.evaluate((root) => document.querySelector(root).dispatchEvent(
          new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true })), LOCK);
        await page.waitForSelector(PIN, { visible: true, timeout: 5000 });
      });
      await until(`${label}: the PIN field holds the keyboard`,
        () => page.evaluate((pin) => document.activeElement === document.querySelector(pin), PIN), Boolean, 5000);
    };
    const unlock = async (label) => {
      await page.focus(PIN);
      await page.type(PIN, "2468");
      lock.accept = true;
      await page.keyboard.press("Enter");
      await until(`${label}: the lock lifts`, async () => Boolean(await page.$(LOCK)), (up) => !up, 10_000);
      lock.accept = false;
      await settle(page);
    };
    // What paints at the middle of the window.
    const topAtCentre = () => page.evaluate((lockRoot) => {
      const hit = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
      if (hit?.closest(lockRoot)) return "lock";
      return `${hit?.tagName}.${hit?.className?.toString?.() ?? ""}`.slice(0, 60);
    }, LOCK);
    const pinFocused = () => page.evaluate((pin) => document.activeElement === document.querySelector(pin), PIN);
    const closeViewers = async () => {
      for (let i = 0; i < 5 && await page.$(VIEWERS); i++) {
        await page.keyboard.press("Escape");
        await settle(page);
      }
    };
    const openFileTab = async (file) => {
      await shell(["open", file]);
      await page.waitForFunction((name) => {
        const title = document.querySelector(".pane .tabs .tab.active")?.getAttribute("title") ?? "";
        return title.endsWith(name);
      }, { timeout: 20_000 }, file);
    };

    const failures = [];
    // Every tab and pane a leg opened goes, so the next leg starts on one
    // empty pane; a live terminal's close confirmation is taken.
    const resetLayout = async () => {
      await closeExtraPanes(page);
      for (let guard = 0; guard < 12 && (await readPaneStrip(page)).tabs.length > 0; guard++) {
        await closeActiveTab(page, "leg reset");
      }
    };
    const leg = async (name, fn) => {
      const record = { passed: false };
      result.legs[name] = record;
      currentLeg = name;
      try {
        await fn(record);
        const missed = (result.wakeMissed ?? []).filter((miss) => miss.leg === name);
        assert.deepEqual(missed, [], "the lock's wake key reached the lock");
        record.passed = true;
      } catch (error) {
        record.failure = String(error.message ?? error);
        failures.push(`${name}: ${record.failure}`);
        await ctx.shot(`336-${name}-failure`).catch(() => {});
      } finally {
        currentLeg = null;
        lock.hold?.resolve();
        lock.hold = null;
        // A red run can leave the player in fullscreen, where the PIN cannot
        // take focus and the leg's cleanup could not unlock.
        await page.evaluate(() => document.fullscreenElement && document.exitFullscreen()).catch(() => {});
        if (await page.$(LOCK)) {
          await wake(`${name} cleanup`).catch(() => {});
          await unlock(`${name} cleanup`).catch((error) => result.cleanupErrors.push(`${name} unlock: ${error.message}`));
        }
        await closeViewers().catch(() => {});
        await load().catch((error) => result.cleanupErrors.push(`${name} reload: ${error.message}`));
        await resetLayout().catch((error) => result.cleanupErrors.push(`${name} reset: ${error.message}`));
      }
    };

    // A viewer open at lock time. `stepKey` is a key the viewer answers and
    // `stepped` reads what it changed.
    const viewerLeg = (name, selector, open, stepKey, stepped) => leg(`viewer-${name}`, async (r) => {
      await open();
      await page.waitForSelector(selector, { visible: true, timeout: 20_000 });
      r.stepBefore = stepped ? await stepped() : null;
      await lockNow();
      r.topUnderLock = await topAtCentre();
      await ctx.shot(`336-viewer-${name}-under-lock`);
      await page.keyboard.press("Escape");
      await settle(page);
      r.openAfterEscape = Boolean(await page.$(selector));
      if (stepKey) {
        await page.keyboard.press(stepKey);
        await settle(page);
        r.stepUnderLock = await stepped();
      }
      await wake(name);
      await unlock(name);
      r.openAfterUnlock = Boolean(await page.$(selector));
      if (stepKey && r.openAfterUnlock) {
        await page.keyboard.press(stepKey);
        await settle(page);
        r.stepAfterUnlock = await stepped();
      }
      if (r.openAfterUnlock) await page.keyboard.press("Escape");
      await settle(page);
      r.closedByEscapeAfterUnlock = !(await page.$(selector));
      assert.equal(r.topUnderLock, "lock", `the lock paints over the ${name} viewer`);
      assert.ok(r.openAfterEscape, `Escape under the lock leaves the ${name} viewer open`);
      if (stepKey) assert.equal(r.stepUnderLock, r.stepBefore, `${stepKey} under the lock does not step the ${name} viewer`);
      assert.ok(r.openAfterUnlock, `the ${name} viewer is still open after unlock`);
      if (stepKey) assert.notEqual(r.stepAfterUnlock, r.stepBefore, `${stepKey} steps the ${name} viewer after unlock`);
      assert.ok(r.closedByEscapeAfterUnlock, `Escape closes the ${name} viewer after unlock`);
    });

    try {
      await viewerLeg("image", ".md-image-zoom", () => shell(["open", IMAGE]));
      await viewerLeg("audio", ".md-audio-viewer", () => shell(["open", AUDIO]));
      await viewerLeg("diagram", ".md-diagram-zoom", async () => {
        await openFileTab(NOTE);
        await page.waitForSelector(".cm-md-diagram-rendered svg", { timeout: 30_000 });
        await page.hover(".cm-md-diagram-rendered");
        await page.evaluate(() => {
          const view = [...document.querySelectorAll(".cm-md-diagram-actions button")]
            .find((button) => button.textContent.trim() === "View");
          if (!view) throw new Error("no View button on the diagram");
          view.click();
        });
      });
      await viewerLeg("slides", SLIDE, async () => {
        await openDeckViewer(false);
        await page.waitForFunction((counter) => document.querySelector(counter)?.textContent?.includes("1 / 3"),
          { timeout: 15_000 }, SLIDE_COUNTER);
      }, "ArrowRight", () => page.evaluate((counter) => document.querySelector(counter)?.textContent ?? "the viewer is gone", SLIDE_COUNTER));

      await leg("slidesFullscreen", async (r) => {
        const fullscreen = () => page.evaluate(() => document.fullscreenElement?.className?.toString?.() ?? null);
        await openDeckViewer(true);
        await page.waitForSelector(`${SLIDE}[data-mode="play"]`, { timeout: 15_000 });
        r.fullscreenBefore = await until("precondition: the player is in element fullscreen", fullscreen, Boolean, 5000);
        await lockNow();
        r.fullscreenUnderLock = await until("the lock leaves fullscreen", fullscreen, (now) => now === null, 3000)
          .catch(async () => fullscreen());
        r.topUnderLock = await topAtCentre();
        await ctx.shot("336-slides-fullscreen-under-lock");
        // Read before the wake: under a fullscreen element the PIN cannot take focus.
        assert.equal(r.fullscreenUnderLock, null, "the lock leaves fullscreen as it comes up");
        assert.equal(r.topUnderLock, "lock", "the lock paints over the slide player");
        await wake("fullscreen");
        await unlock("fullscreen");
        r.openAfterUnlock = Boolean(await page.$(SLIDE));
        r.fullscreenAfterUnlock = await until("the unlock asks for fullscreen back", fullscreen, Boolean, 3000)
          .catch(async () => fullscreen());
        assert.ok(r.openAfterUnlock, "the slide player is still open after unlock");
        assert.ok(r.fullscreenAfterUnlock, "the slide player is back in fullscreen after unlock");
      });

      await leg("slidesFullscreenUnderLock", async (r) => {
        const fullscreen = () => page.evaluate(() => document.fullscreenElement?.className?.toString?.() ?? null);
        const deckTheme = () => page.evaluate((slide) => document.querySelector(slide)?.dataset.theme ?? null, SLIDE);
        // A request resolves shortly after it is made: read over a bound, and
        // stop at the first reading that shows fullscreen.
        const enteredWithin = async (ms) => {
          const deadline = Date.now() + ms;
          do {
            const now = await fullscreen();
            if (now) return now;
            await new Promise((resolve) => setTimeout(resolve, 50));
          } while (Date.now() < deadline);
          return null;
        };
        const cdp = await page.createCDPSession();
        const scheme = (value) => cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value }] });
        try {
          await scheme("light");
          await openDeckViewer(true);
          await page.waitForSelector(`${SLIDE}[data-mode="play"]`, { timeout: 15_000 });
          r.fullscreenBefore = await until("precondition: the player is in element fullscreen", fullscreen, Boolean, 5000);
          r.themeBefore = await until("precondition: the deck follows the light scheme", deckTheme, (theme) => theme === "light", 5000);
          await lockNow();
          await until("the lock leaves fullscreen", fullscreen, (now) => now === null, 3000);
          await wake("theme");
          // The key is the live activation a fullscreen request would spend.
          await page.keyboard.press("1");
          await scheme("dark");
          r.themeUnderLock = await until("precondition: the deck takes the theme under the lock", deckTheme, (theme) => theme === "dark", 5000);
          r.fullscreenAfterTheme = await enteredWithin(1500);
          r.topAfterTheme = await topAtCentre();
          await ctx.shot("336-slides-theme-under-lock");
          assert.equal(r.fullscreenAfterTheme, null, "a theme change under the lock does not put the player in fullscreen");
          assert.equal(r.topAfterTheme, "lock", "the lock still paints over the player after the theme change");
          // A request made while the lock is up, as one racing the lock is.
          // Refused, it would enter nothing, and the readings below would
          // hold whatever the guard did. Puppeteer evaluates with a user
          // gesture, which is the activation it spends.
          r.requestUnderLock = await page.evaluate((slide) => document.querySelector(slide).requestFullscreen().then(() => "entered", (error) => String(error)), SLIDE);
          assert.equal(r.requestUnderLock, "entered", "precondition: the request under the lock enters fullscreen");
          r.fullscreenAfterRequest = await until("a fullscreen entered under the lock is left", fullscreen, (now) => now === null, 3000)
            .catch(async () => fullscreen());
          r.topAfterRequest = await topAtCentre();
          r.keyboardAfterRequest = await keyboardSurface(page);
          assert.equal(r.fullscreenAfterRequest, null, "a fullscreen entered under the lock is left");
          assert.equal(r.topAfterRequest, "lock", "the lock paints over the player after that request");
          assert.equal(r.keyboardAfterRequest, "screen-lock", "the lock has the keyboard after that request");
          await wake("request");
          await unlock("theme");
          r.openAfterUnlock = Boolean(await page.$(SLIDE));
          r.fullscreenAfterUnlock = await until("the unlock asks for fullscreen back", fullscreen, Boolean, 3000)
            .catch(async () => fullscreen());
          assert.ok(r.openAfterUnlock, "the player is still open after unlock");
          assert.ok(r.fullscreenAfterUnlock, "the player is back in fullscreen after unlock");
        } finally {
          await cdp.send("Emulation.setEmulatedMedia", { features: [] }).catch(() => {});
          await cdp.detach().catch(() => {});
        }
      });

      const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const mediaState = (selector) => page.evaluate((query) => {
        const media = document.querySelector(query);
        return media && { paused: media.paused, time: media.currentTime, played: media.played.length, ready: media.readyState, error: media.error?.code ?? null };
      }, selector);
      const startMedia = (selector) => page.evaluate((query) => document.querySelector(query).play().then(() => "playing", (error) => String(error)), selector);
      const advancing = (selector, past = 0.25) => until(`${selector} is playing past ${past}`, () => mediaState(selector),
        (state) => state && !state.paused && state.time > past, 10_000);
      let videoWritten = false;
      const ensureVideo = async () => {
        if (videoWritten) return;
        writeFileSync(join(ctx.workspaceDir, VIDEO), Buffer.from(await recordWebm(page), "base64"));
        videoWritten = true;
      };

      await leg("audioPlayingAtLock", async (r) => {
        await shell(["open", LONG_AUDIO]);
        await page.waitForSelector(AUDIO_VIEWER, { timeout: 20_000 });
        await page.waitForSelector(AUDIO_DETAILS, { timeout: 20_000 });
        r.started = [await startMedia(AUDIO_VIEWER), await startMedia(AUDIO_DETAILS)];
        r.before = [await advancing(AUDIO_VIEWER), await advancing(AUDIO_DETAILS)];
        await lockNow();
        const bothPaused = async () => [await mediaState(AUDIO_VIEWER), await mediaState(AUDIO_DETAILS)];
        r.underLock = await until("both players pause under the lock", bothPaused, (states) => states.every((state) => state.paused), 2000)
          .catch(async () => bothPaused());
        await ctx.shot("336-audio-under-lock");
        assert.ok(r.underLock.every((state) => state.paused), `audio playing at lock time pauses: ${JSON.stringify(r.underLock)}`);
        await pause(800);
        r.stillUnderLock = await bothPaused();
        r.underLock.forEach((state, i) => assert.ok(Math.abs(r.stillUnderLock[i].time - state.time) < CLOCK_EPSILON,
          `a paused clock stands still under the lock: ${JSON.stringify([state, r.stillUnderLock[i]])}`));
        // A play under the lock, as a race with it makes one.
        r.playUnderLock = await startMedia(AUDIO_VIEWER);
        await pause(500);
        r.afterPlayUnderLock = await bothPaused();
        assert.ok(r.afterPlayUnderLock[0].paused, `a play under the lock does not run: ${JSON.stringify(r.afterPlayUnderLock[0])}`);
        await wake("audio");
        await unlock("audio");
        await pause(800);
        r.afterUnlock = await bothPaused();
        r.afterUnlock.forEach((state, i) => {
          assert.ok(state.paused, `no player resumes after unlock: ${JSON.stringify(state)}`);
          assert.ok(Math.abs(state.time - r.afterPlayUnderLock[i].time) < CLOCK_EPSILON,
            `the position is kept: ${JSON.stringify([r.afterPlayUnderLock[i], state])}`);
        });
        r.resumed = await startMedia(AUDIO_VIEWER);
        r.controlAfterUnlock = await advancing(AUDIO_VIEWER, r.afterUnlock[0].time + 0.2);
      });

      await leg("videoOpenedUnderLock", async (r) => {
        await ensureVideo();
        await lockNow();
        await wake("video");
        const playsBefore = await page.evaluate(() => window.__plays336);
        await shell(["open", VIDEO]);
        await page.waitForSelector(VIDEO_VIEWER, { timeout: 20_000 });
        r.loaded = await until("precondition: the video has data to play", () => mediaState(VIDEO_VIEWER),
          (state) => state && state.ready >= 2 && state.error === null, 10_000);
        await pause(1200);
        r.underLock = await mediaState(VIDEO_VIEWER);
        r.startsUnderLock = await page.evaluate(() => window.__plays336) - playsBefore;
        r.topUnderLock = await topAtCentre();
        r.pinFocused = await pinFocused();
        await ctx.shot("336-video-opened-under-lock");
        assert.ok(r.underLock.paused && r.underLock.time < CLOCK_EPSILON, `a video opened under the lock does not play: ${JSON.stringify(r.underLock)}`);
        assert.equal(r.startsUnderLock, 0, "the video never starts under the lock");
        assert.equal(r.topUnderLock, "lock", "the lock paints over the video");
        assert.ok(r.pinFocused, "the PIN keeps the keyboard as the video opens");
        await unlock("video");
        await pause(800);
        r.afterUnlock = await mediaState(VIDEO_VIEWER);
        assert.ok(r.afterUnlock.paused && r.afterUnlock.time < CLOCK_EPSILON, `it does not start after unlock: ${JSON.stringify(r.afterUnlock)}`);
        r.started = await startMedia(VIDEO_VIEWER);
        r.controlAfterUnlock = await advancing(VIDEO_VIEWER);
      });

      await leg("videoFullscreenAtLock", async (r) => {
        const fullscreen = () => page.evaluate(() => document.fullscreenElement?.tagName ?? null);
        await ensureVideo();
        await shell(["open", VIDEO]);
        await page.waitForSelector(VIDEO_VIEWER, { timeout: 20_000 });
        r.before = await advancing(VIDEO_VIEWER);
        r.entered = await page.evaluate((query) => document.querySelector(query).requestFullscreen().then(() => "entered", (error) => String(error)), VIDEO_VIEWER);
        r.fullscreenBefore = await until("precondition: the video is in its own fullscreen", fullscreen, (now) => now === "VIDEO", 5000);
        await lockNow();
        r.fullscreenUnderLock = await until("the lock leaves the video's fullscreen", fullscreen, (now) => now === null, 3000)
          .catch(async () => fullscreen());
        r.topUnderLock = await topAtCentre();
        r.underLock = await until("the video pauses under the lock", () => mediaState(VIDEO_VIEWER), (state) => state.paused, 2000)
          .catch(async () => mediaState(VIDEO_VIEWER));
        await ctx.shot("336-video-fullscreen-under-lock");
        assert.equal(r.fullscreenUnderLock, null, "the lock is not left under the video's fullscreen");
        assert.equal(r.topUnderLock, "lock", "the lock paints over the video");
        assert.ok(r.underLock.paused, `the video pauses: ${JSON.stringify(r.underLock)}`);
        await wake("video fullscreen");
        await unlock("video fullscreen");
        await pause(800);
        r.afterUnlock = await mediaState(VIDEO_VIEWER);
        assert.ok(r.afterUnlock.paused, `the video does not resume: ${JSON.stringify(r.afterUnlock)}`);
        assert.ok(Math.abs(r.afterUnlock.time - r.underLock.time) < CLOCK_EPSILON, `its position is kept: ${JSON.stringify([r.underLock, r.afterUnlock])}`);
      });

      await leg("datePopover", async (r) => {
        await openFileTab(NOTE);
        await page.waitForSelector(DATE_PILL, { timeout: 30_000 });
        r.pillBefore = await page.$eval(DATE_PILL, (el) => el.textContent);
        await page.click(DATE_PILL);
        await page.waitForSelector(DATE_POPOVER, { visible: true, timeout: 10_000 });
        await lockNow();
        await wake("date");
        for (const key of ["ArrowRight", "ArrowDown", "Enter"]) {
          await page.keyboard.press(key);
          await settle(page);
        }
        r.pillUnderLock = await page.$eval(DATE_PILL, (el) => el.textContent);
        r.popoverUnderLock = Boolean(await page.$(DATE_POPOVER));
        r.pinKeptKeyboard = await pinFocused();
        await ctx.shot("336-date-under-lock");
        // A press on the lock is outside the popover, and is not the popover's.
        await page.mouse.click(5, 5);
        await settle(page);
        r.popoverAfterPress = Boolean(await page.$(DATE_POPOVER));
        await unlock("date");
        r.pillAfterUnlock = await page.$eval(DATE_PILL, (el) => el.textContent);
        r.popoverAfterUnlock = Boolean(await page.$(DATE_POPOVER));
        if (r.popoverAfterUnlock) await page.keyboard.press("Escape");
        await settle(page);
        r.closedByEscape = !(await page.$(DATE_POPOVER));
        assert.equal(r.pillUnderLock, r.pillBefore, "the keys on the PIN commit no date");
        assert.ok(r.popoverUnderLock, "the date popover stays open under the lock");
        assert.ok(r.pinKeptKeyboard, "the PIN keeps the keyboard");
        assert.ok(r.popoverAfterPress, "a press on the lock leaves the date popover open");
        assert.equal(r.pillAfterUnlock, r.pillBefore, "the date is unchanged after unlock");
        assert.ok(r.popoverAfterUnlock, "the date popover is still open after unlock");
        assert.ok(r.closedByEscape, "Escape closes the date popover after unlock");
      });

      await leg("dialogUnderLock", async (r) => {
        // The picker needs a live user activation, which a loaded host can
        // let lapse between the key and the command; the picker is setup here.
        let picker = null;
        for (let attempt = 1; !picker; attempt++) {
          await selectLauncherCommand(page, "Import metadata archive");
          const chooser = page.waitForFileChooser({ timeout: 5000 });
          await page.keyboard.press("Enter");
          picker = await chooser.catch((error) => {
            if (attempt >= 3) throw error;
            return null;
          });
        }
        await lockNow();
        await wake("dialog");
        await picker.accept([archive]);
        await page.waitForSelector(CONFIRM, { timeout: 15_000 });
        await settle(page);
        r.underLock = { keyboard: await keyboardSurface(page), pinFocused: await pinFocused() };
        await page.keyboard.type("7");
        r.pinValue = await inputValue(page, PIN);
        await ctx.shot("336-dialog-under-lock");
        await unlock("dialog");
        r.afterUnlock = await page.evaluate((dialog) => {
          const root = document.querySelector(dialog);
          const active = document.activeElement;
          return { open: Boolean(root), holdsKeyboard: Boolean(root?.contains(active)), control: active?.className?.toString?.() ?? "" };
        }, CONFIRM);
        if (r.afterUnlock.open) await page.keyboard.press("Escape");
        await settle(page);
        r.closedByEscape = !(await page.$(CONFIRM));
        r.imports = lock.imports;
        assert.ok(r.underLock.pinFocused, `the PIN keeps the keyboard as the dialog opens: ${JSON.stringify(r.underLock)}`);
        assert.ok(String(r.pinValue).endsWith("7"), `a digit typed lands in the PIN: ${JSON.stringify(r.pinValue)}`);
        assert.ok(r.afterUnlock.open && r.afterUnlock.holdsKeyboard, `the dialog holds the keyboard after unlock: ${JSON.stringify(r.afterUnlock)}`);
        assert.ok(r.closedByEscape, "Escape answers the dialog after unlock");
        assert.equal(r.imports, 0, "nothing was imported");
      });

      await leg("chords", async (r) => {
        await openFileTab(NOTE);
        await dispatchCommand(page, "app.tab.close");
        await settle(page);
        const terminal = await openAttachedTerminal(ctx, page, cs, windowId, "Chord336");
        const host = `.pane[data-pane-id="${terminal.pane}"] .terminal-tab.active .terminal-host`;
        await page.click(host);
        await settle(page);
        const tabCount = () => page.evaluate((pane) => document.querySelectorAll(`.pane[data-pane-id="${pane}"] .tabs .tab`).length, terminal.pane);
        r.tabsBefore = await tabCount();
        await lockNow();
        await wake("chords");
        for (const name of ["app.find.open", "terminal.find", "app.tab.reopenClosed"]) {
          await dispatchCommand(page, name);
          await settle(page);
        }
        r.underLock = {
          findBar: Boolean(await page.$(FIND)),
          tabs: await tabCount(),
          pinFocused: await pinFocused(),
          keyboard: await keyboardSurface(page),
        };
        await ctx.shot("336-chords-under-lock");
        await unlock("chords");
        assert.ok(!r.underLock.findBar, `the find chords open no find bar under the lock: ${JSON.stringify(r.underLock)}`);
        assert.equal(r.underLock.tabs, r.tabsBefore, "the reopen chord reopens no tab under the lock");
        assert.ok(r.underLock.pinFocused, `the PIN keeps the keyboard: ${JSON.stringify(r.underLock)}`);
        await page.click(host);
        await dispatchCommand(page, "app.find.open");
        r.findAfterUnlock = await page.waitForSelector(FIND, { visible: true, timeout: 5000 }).then(() => true, () => false);
        if (r.findAfterUnlock) {
          await page.focus(FIND);
          await page.keyboard.press("Escape");
          await settle(page);
        }
        const tabsBeforeReopen = await tabCount();
        await dispatchCommand(page, "app.tab.reopenClosed");
        r.reopenedAfterUnlock = await until("the reopen chord reopens the tab after unlock", tabCount,
          (count) => count === tabsBeforeReopen + 1, 5000).then(() => true, () => false);
        assert.ok(r.findAfterUnlock, "the find chord works after unlock");
        assert.ok(r.reopenedAfterUnlock, "the reopen chord works after unlock");
      });

      await leg("busListeners", async (r) => {
        await showFiles(page);
        await settle(page);
        await lockNow();
        await wake("files");
        await dispatchCommand(page, "app.browser.newFsEntry");
        await settle(page);
        r.filesUnderLock = { prompt: Boolean(await page.$(PATH_PROMPT)), pinFocused: await pinFocused() };
        await unlock("files");
        if (await page.$(PATH_PROMPT)) {
          await page.keyboard.press("Escape");
          await settle(page);
        }
        await dispatchCommand(page, "app.browser.newFsEntry");
        r.filesAfterUnlock = await page.waitForSelector(PATH_PROMPT, { visible: true, timeout: 5000 }).then(() => true, () => false);
        if (r.filesAfterUnlock) {
          await page.keyboard.press("Escape");
          await settle(page);
        }

        await dispatchCommand(page, "app.graph.toggle");
        await page.waitForSelector(".graph-tab.active canvas", { timeout: 60_000 });
        await settle(page);
        await lockNow();
        await wake("graph");
        const readsBefore = lock.graphReads;
        await dispatchCommand(page, "app.graph.reload");
        await settle(page);
        r.graphReadsUnderLock = lock.graphReads - readsBefore;
        await unlock("graph");
        const readsAfter = lock.graphReads;
        await dispatchCommand(page, "app.graph.reload");
        r.graphAfterUnlock = await until("the graph reloads after unlock", () => lock.graphReads,
          (count) => count > readsAfter, 5000).then(() => true, () => false);

        assert.ok(!r.filesUnderLock.prompt && r.filesUnderLock.pinFocused,
          `the file browser's command does nothing under the lock: ${JSON.stringify(r.filesUnderLock)}`);
        assert.ok(r.filesAfterUnlock, "the file browser's command works after unlock");
        assert.equal(r.graphReadsUnderLock, 0, "the graph's command reads nothing under the lock");
        assert.ok(r.graphAfterUnlock, "the graph's command works after unlock");
      });

      await leg("findAfterMove", async (r) => {
        const terminal = await openAttachedTerminal(ctx, page, cs, windowId, "Move336");
        await page.click(`.pane[data-pane-id="${terminal.pane}"] .terminal-tab.active .terminal-host`);
        await dispatchCommand(page, "app.find.open");
        await page.waitForSelector(FIND, { visible: true, timeout: 10_000 });
        await until("precondition: the find input holds the keyboard",
          () => page.evaluate((find) => document.activeElement === document.querySelector(find), FIND), Boolean, 5000);
        // A second pane for the swap below to move the terminal into.
        const split = await shell(["pane", "split", "right", "--window", windowId, "--pane", terminal.pane]);
        r.otherPane = String(split.stdout).trim();
        await page.waitForSelector(`.pane[data-pane-id="${r.otherPane}"]`, { timeout: 10_000 });
        await settle(page);
        await lockNow();
        await wake("move");
        // A running PIN check disables the field, leaving the keyboard at large.
        lock.hold = deferred();
        await page.type(PIN, "1");
        await page.keyboard.press("Enter");
        await until("precondition: the PIN field is disabled by the running check",
          () => page.$eval(PIN, (el) => el.disabled), Boolean, 5000);
        r.holderBeforeMove = await until("precondition: the keyboard is at large",
          () => keyboardSurface(page), (at) => at === "body", 5000).catch(async () => `not at large: ${await keyboardSurface(page)}`);
        // A swap leaves the named other pane active, here the one the terminal lands in.
        await shell(["pane", "swap", r.otherPane, "--window", windowId, "--pane", terminal.pane]);
        r.movedToActivePane = await until("the swap moves the terminal into the active pane",
          () => page.evaluate((other) => Boolean(document.querySelector(`.pane[data-pane-id="${other}"] .terminal-tab.active`)), r.otherPane),
          Boolean, 10_000);
        await settle(page);
        await settle(page);
        r.afterMove = {
          keyboard: await keyboardSurface(page),
          findFocused: await page.evaluate((find) => {
            const input = document.querySelector(find);
            return Boolean(input) && document.activeElement === input;
          }, FIND),
        };
        await ctx.shot("336-find-after-move");
        lock.hold.resolve();
        lock.hold = null;
        await page.waitForFunction((pin) => !document.querySelector(pin)?.disabled, { timeout: 5000 }, PIN);
        await unlock("move");
        assert.equal(r.holderBeforeMove, "body", "precondition: the keyboard is at large when the terminal moves");
        assert.ok(!r.afterMove.findFocused, `the find input does not take the keyboard under the lock: ${JSON.stringify(r.afterMove)}`);
        // The control: with no cover up, the same move hands the find input
        // the keyboard, so the leg above cannot pass on a path that is dead.
        await page.focus(FIND);
        await page.evaluate(() => document.activeElement?.blur());
        r.holderBeforeControl = await until("control: the keyboard is at large", () => keyboardSurface(page), (at) => at === "body", 5000);
        await shell(["pane", "swap", terminal.pane, "--window", windowId, "--pane", r.otherPane]);
        r.controlFindFocused = await until("control: the same move gives the find input the keyboard",
          () => page.evaluate((find) => {
            const input = document.querySelector(find);
            return Boolean(input) && document.activeElement === input;
          }, FIND), Boolean, 5000);
      });
    } catch (error) {
      result.failure = String(error.message ?? error);
      failures.push(result.failure);
      await ctx.shot("336-failure").catch(() => {});
    } finally {
      lock.accept = false;
      result.verifications = lock.verifications;
      await load().catch((error) => result.cleanupErrors.push(`reload: ${error.message}`));
      await closeEveryTerminal(page, "336 cleanup", token).catch((error) => result.cleanupErrors.push(`terminals: ${error.message}`));
      await restoreTerminalPrefs(ctx, page, token, original).catch((error) => result.cleanupErrors.push(`terminal preferences: ${error.message}`));
      for (const file of [NOTE, DECK_FILE, IMAGE, AUDIO, LONG_AUDIO, VIDEO]) rmSync(join(ctx.workspaceDir, file), { force: true });
      rmSync(directory, { recursive: true, force: true });
      for (const error of result.cleanupErrors) failures.push(`cleanup: ${error}`);
      writeFileSync(join(ctx.outDir, "336-screen-lock-holes.json"), `${JSON.stringify(result, null, 2)}\n`);
    }
    if (failures.length) throw new Error(failures.join("\n"));
  },
};
