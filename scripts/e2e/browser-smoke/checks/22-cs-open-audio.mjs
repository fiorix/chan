// Existing non-text files opened through the real control socket reveal a new
// File Browser tab, select the file, open its inspector, and raise the shared
// audio viewer. The fixture is a deterministic PCM WAV generated in memory.

import { writeFileSync } from "node:fs";
import { join } from "node:path";

const FILE = "audio-smoke.wav";
const SAMPLE_RATE = 8_000;
const DURATION_SECONDS = 3;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function pcmWav() {
  const frames = SAMPLE_RATE * DURATION_SECONDS;
  const dataBytes = frames * 2;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(SAMPLE_RATE, 24);
  wav.writeUInt32LE(SAMPLE_RATE * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(dataBytes, 40);
  for (let frame = 0; frame < frames; frame++) {
    // Integer square wave: deterministic bytes with no codec or floating-point
    // dependency. A period of 80 frames is a 100 Hz tone at 8 kHz.
    wav.writeInt16LE(frame % 80 < 40 ? 8_192 : -8_192, 44 + frame * 2);
  }
  return wav;
}

function browserTabCount(snapshot) {
  return snapshot.panes.reduce(
    (total, pane) =>
      total +
      ["a", "b"].reduce(
        (sideTotal, side) =>
          sideTotal +
          (pane.sides?.[side]?.tabs ?? []).filter((tab) => tab.kind === "browser")
            .length,
        0,
      ),
    0,
  );
}

async function openFileBrowser(page) {
  const open = await page.$(".file-tree, [role=tree]");
  if (open) return;
  await page.evaluate(() => {
    window.dispatchEvent(
      new CustomEvent("chan:command", { detail: { name: "app.files.toggle" } }),
    );
  });
  await page.waitForSelector('[role="treeitem"]', { timeout: 15_000 });
}

async function cli(ctx, windowId, args) {
  return ctx.exec(ctx.chanBin, ["shell", ...args], {
    cwd: ctx.workspaceDir,
    env: {
      ...process.env,
      CHAN_CONTROL_SOCKET: ctx.controlSocket,
      CHAN_WINDOW_ID: windowId,
      CHAN_WORKSPACE_PATH: ctx.workspaceDir,
    },
    timeout: 120_000,
  });
}

async function paneList(ctx, windowId) {
  const { stdout } = await cli(ctx, windowId, [
    "pane",
    "list",
    "--window",
    windowId,
    "--json",
  ]);
  return JSON.parse(Buffer.isBuffer(stdout) ? stdout.toString("utf8") : stdout);
}

async function poll(read, accept, label, timeoutMs = 20_000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    last = await read();
    if (accept(last)) return last;
    await sleep(150);
  }
  throw new Error(`${label} did not settle: ${JSON.stringify(last)}`);
}

export default {
  name: "cs-open-audio",
  async run(ctx) {
    if (!ctx.controlSocket) ctx.skip("control socket not found for the server pid");
    const { page } = ctx;
    await openFileBrowser(page);
    const writeAudio = () => writeFileSync(join(ctx.workspaceDir, FILE), pcmWav());
    const rowVisible = (timeout) =>
      page
        .waitForFunction(
          (filename) =>
            [...document.querySelectorAll('[role="treeitem"] button.name')].some(
              (button) => button.textContent?.trim() === filename,
            ),
          { timeout },
          FILE,
        )
        .then(() => true)
        .catch(() => false);
    writeAudio();
    if (!(await rowVisible(10_000))) {
      // A write while the SPA is still booting can precede its watcher
      // subscription. A second write gives the live tree a fresh event.
      writeAudio();
      if (!(await rowVisible(15_000))) throw new Error(`${FILE} did not reach the file tree`);
    }
    await page.bringToFront();
    const windowId = await page.evaluate(
      () =>
        new URL(location.href).searchParams.get("w")?.trim() ||
        window.sessionStorage.getItem("chan.session.window")?.trim() ||
        "",
    );
    if (!windowId) throw new Error("could not resolve the page's window id");

    const before = await paneList(ctx, windowId);
    const beforeBrowsers = browserTabCount(before);

    await cli(ctx, windowId, ["open", FILE]);
    const after = await poll(
      () => paneList(ctx, windowId),
      (snapshot) => browserTabCount(snapshot) === beforeBrowsers + 1,
      "new File Browser tab",
    );

    await page.waitForFunction(
      (filename) =>
        [...document.querySelectorAll('[role="treeitem"][aria-selected="true"]')].some(
          (row) => row.querySelector("button.name")?.textContent?.trim() === filename,
        ),
      { timeout: 20_000 },
      FILE,
    );
    await page.waitForSelector(".inspector.right .audio-preview audio", {
      timeout: 20_000,
    });
    await page.waitForSelector(".md-audio-viewer audio", { timeout: 20_000 });

    const initial = await page.evaluate(async (filename) => {
      const inline = document.querySelector(".inspector.right .audio-preview audio");
      const viewer = document.querySelector(".md-audio-viewer audio");
      const heading = document.querySelector(".inspector.right h3.title");
      if (!(inline instanceof HTMLAudioElement)) throw new Error("inline audio missing");
      if (!(viewer instanceof HTMLAudioElement)) throw new Error("audio viewer missing");
      if (heading?.textContent?.trim() !== filename) {
        throw new Error(`inspector heading mismatch: ${heading?.textContent}`);
      }
      const deadline = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("audio metadata timed out")), 20_000),
      );
      if (viewer.readyState < 1) {
        await Promise.race([
          new Promise((resolve) =>
            viewer.addEventListener("loadedmetadata", resolve, { once: true }),
          ),
          deadline,
        ]);
      }
      if (viewer.error) throw new Error(`viewer audio error ${viewer.error.code}`);
      if (!(viewer.duration > 0)) throw new Error(`invalid duration: ${viewer.duration}`);
      if (inline.autoplay || viewer.autoplay) throw new Error("audio must not autoplay");
      if (!inline.paused || !viewer.paused) throw new Error("audio started before user intent");
      window.__chanSmokeAudio = viewer;
      return {
        inlineSrc: inline.getAttribute("src"),
        viewerSrc: viewer.getAttribute("src"),
        duration: viewer.duration,
      };
    }, FILE);
    if (!initial.inlineSrc?.includes(FILE) || !initial.viewerSrc?.includes(FILE)) {
      throw new Error(`audio source mismatch: ${JSON.stringify(initial)}`);
    }

    const contentType = await page.evaluate(async () => {
      const src = document.querySelector(".md-audio-viewer audio")?.getAttribute("src");
      const response = await fetch(src, { headers: { Range: "bytes=0-43" } });
      await response.arrayBuffer();
      return {
        status: response.status,
        contentType: response.headers.get("content-type"),
        contentRange: response.headers.get("content-range"),
      };
    });
    if (contentType.status !== 206 || contentType.contentType !== "audio/wav") {
      throw new Error(`WAV range response mismatch: ${JSON.stringify(contentType)}`);
    }

    const playback = await page.evaluate(async () => {
      const audio = document.querySelector(".md-audio-viewer audio");
      if (!(audio instanceof HTMLAudioElement)) throw new Error("audio viewer disappeared");
      const once = (event) =>
        new Promise((resolve) => audio.addEventListener(event, resolve, { once: true }));
      const timeout = (label) =>
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`${label} timed out`)), 20_000),
        );

      audio.muted = true;
      await audio.play();
      const playedFrom = audio.currentTime;
      await new Promise((resolve) => setTimeout(resolve, 600));
      const playedTo = audio.currentTime;
      audio.pause();
      if (!(playedTo > playedFrom)) throw new Error("audio playback did not advance");

      const target = audio.duration * 0.7;
      audio.currentTime = target;
      await Promise.race([once("seeked"), timeout("audio seek")]);
      if (Math.abs(audio.currentTime - target) > 0.25) {
        throw new Error(`seek landed at ${audio.currentTime}, wanted ${target}`);
      }
      return { playedFrom, playedTo, seekedTo: audio.currentTime };
    });
    await ctx.shot("audio-viewer");

    await page.click(".md-audio-viewer button");
    await page.waitForFunction(() => !document.querySelector(".md-audio-viewer"), {
      timeout: 5_000,
    });
    const teardown = await page.evaluate(() => {
      const audio = window.__chanSmokeAudio;
      return {
        connected: audio?.isConnected ?? null,
        src: audio?.getAttribute("src") ?? null,
        paused: audio?.paused ?? null,
        selected: [...document.querySelectorAll('[role="treeitem"][aria-selected="true"]')]
          .map((row) => row.querySelector("button.name")?.textContent?.trim())
          .filter(Boolean),
        inspectorAudio: !!document.querySelector(".inspector.right .audio-preview audio"),
      };
    });
    if (teardown.connected || teardown.src !== null || teardown.paused !== true) {
      throw new Error(`viewer teardown incomplete: ${JSON.stringify(teardown)}`);
    }
    if (!teardown.selected.includes(FILE) || !teardown.inspectorAudio) {
      throw new Error(`reveal was lost after viewer close: ${JSON.stringify(teardown)}`);
    }

    return {
      beforeBrowsers,
      afterBrowsers: browserTabCount(after),
      initial,
      contentType,
      playback,
      teardown,
    };
  },
};
