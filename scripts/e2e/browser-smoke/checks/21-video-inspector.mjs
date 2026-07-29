// Video inspector + HTTP range serving: the inspector renders an inline
// <video> preview with a "View Video" main action, and /api/files
// answers range requests on media paths with byte-exact 206 slices.
//
// Two stages. The range assertions use a deterministic byte pattern
// under an .mp4 name, so they hold on any browser build (the server's
// range path never inspects content). Real decode + seek + fullscreen
// viewer assertions run against SMOKE_VIDEO_FILE when it points at a
// browser-decodable video; without it (or without an H.264 decoder in
// the browser) that stage records as skipped detail, not a failure.

import { copyFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CLIP_BYTES = 300_000;

function patternBytes(len) {
  const out = Buffer.alloc(len);
  for (let i = 0; i < len; i++) out[i] = i % 251;
  return out;
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

// The video files are written after the server started, so the row
// arrives via a watcher push. A write that lands while the SPA is
// still booting can slip past its update subscription, so on a first
// miss re-run `write` (fresh mtime, fresh event) and wait once more.
async function selectTreeFile(page, filename, write) {
  const rowVisible = (timeout) =>
    page
      .waitForFunction(
        (name) =>
          [...document.querySelectorAll('[role="treeitem"] button.name')].some(
            (b) => b.textContent?.trim() === name,
          ),
        { timeout },
        filename,
      )
      .then(() => true)
      .catch(() => false);
  if (!(await rowVisible(10_000))) {
    write();
    if (!(await rowVisible(15_000))) {
      throw new Error(`tree row not found after rewrite: ${filename}`);
    }
  }
  await page.evaluate((name) => {
    const row = [...document.querySelectorAll('[role="treeitem"] button.name')].find(
      (b) => b.textContent?.trim() === name,
    );
    row.click();
  }, filename);
}

// Wait for the preview to show THIS file: the <video> node persists
// across selections, so selector presence alone can hand back the
// previous file's src.
async function inlinePreviewSrc(page, filename) {
  await page.waitForFunction(
    (name) =>
      document
        .querySelector(".video-preview video")
        ?.getAttribute("src")
        ?.includes(name),
    { timeout: 10_000 },
    filename,
  );
  return page.$eval(".video-preview video", (v) => v.getAttribute("src"));
}

export default {
  name: "video-inspector",
  async run(ctx) {
    const { page } = ctx;
    const details = {};

    // Open the browser BEFORE writing: the tree being rendered is the
    // best available signal that the SPA's update subscription is live.
    await openFileBrowser(page);
    const writeClip = () =>
      writeFileSync(join(ctx.workspaceDir, "clip.mp4"), patternBytes(CLIP_BYTES));
    writeClip();
    await selectTreeFile(page, "clip.mp4", writeClip);
    const src = await inlinePreviewSrc(page, "clip.mp4");
    await ctx.shot("video-inspector");

    const mainLabel = await page.$eval(".pill-main", (b) => b.textContent?.trim());
    if (mainLabel !== "View Video") {
      throw new Error(`main action for an mp4 must be "View Video", got "${mainLabel}"`);
    }

    // Range semantics, asserted from the page so the requests ride the
    // same tokenized URL the <video> element uses.
    const ranges = await page.evaluate(
      async (videoSrc, total) => {
        const get = async (headers) => {
          const resp = await fetch(videoSrc, { headers });
          const body = new Uint8Array(await resp.arrayBuffer());
          return {
            status: resp.status,
            acceptRanges: resp.headers.get("accept-ranges"),
            contentRange: resp.headers.get("content-range"),
            contentLength: resp.headers.get("content-length"),
            contentType: resp.headers.get("content-type"),
            body,
          };
        };
        const expectSlice = (label, got, start, len) => {
          if (got.body.length !== len) {
            throw new Error(`${label}: expected ${len} bytes, got ${got.body.length}`);
          }
          for (let i = 0; i < len; i++) {
            if (got.body[i] !== (start + i) % 251) {
              throw new Error(`${label}: byte ${i} mismatch`);
            }
          }
        };

        const full = await get({});
        if (full.status !== 200) throw new Error(`full GET: ${full.status}`);
        if (full.acceptRanges !== "bytes") throw new Error("full GET: no Accept-Ranges");
        if (full.contentType !== "video/mp4") {
          throw new Error(`full GET content-type: ${full.contentType}`);
        }
        expectSlice("full GET", full, 0, total);

        const mid = await get({ Range: "bytes=65529-65560" });
        if (mid.status !== 206) throw new Error(`mid range: ${mid.status}`);
        if (mid.contentRange !== `bytes 65529-65560/${total}`) {
          throw new Error(`mid range content-range: ${mid.contentRange}`);
        }
        expectSlice("mid range", mid, 65529, 32);

        const openEnded = await get({ Range: `bytes=${total - 40}-` });
        if (openEnded.status !== 206) throw new Error(`open range: ${openEnded.status}`);
        expectSlice("open range", openEnded, total - 40, 40);

        const suffix = await get({ Range: "bytes=-17" });
        if (suffix.status !== 206) throw new Error(`suffix range: ${suffix.status}`);
        if (suffix.contentRange !== `bytes ${total - 17}-${total - 1}/${total}`) {
          throw new Error(`suffix content-range: ${suffix.contentRange}`);
        }
        expectSlice("suffix range", suffix, total - 17, 17);

        const unsat = await get({ Range: `bytes=${total}-` });
        if (unsat.status !== 416) throw new Error(`unsatisfiable range: ${unsat.status}`);
        if (unsat.contentRange !== `bytes */${total}`) {
          throw new Error(`416 content-range: ${unsat.contentRange}`);
        }

        const multi = await get({ Range: "bytes=0-1,5-9" });
        if (multi.status !== 200) throw new Error(`multi range must be full: ${multi.status}`);

        // Explicit download keeps attachment semantics, range-blind.
        const download = await fetch(`${videoSrc}&download=1`);
        if (download.status !== 200) throw new Error(`download: ${download.status}`);
        const disposition = download.headers.get("content-disposition") ?? "";
        if (!disposition.startsWith("attachment")) {
          throw new Error(`download disposition: ${disposition}`);
        }
        await download.arrayBuffer();

        // Non-media regression pin: the buffered image path stays
        // range-blind (same tokenized query the seeds use).
        const photo = await fetch(videoSrc.replace(/\/clip\.mp4\?/, "/photo.png?"));
        if (photo.status !== 200) throw new Error(`photo GET: ${photo.status}`);
        if (photo.headers.get("accept-ranges") !== null) {
          throw new Error("photo GET: image path must not advertise Accept-Ranges");
        }
        await photo.arrayBuffer();

        return { fullLength: full.contentLength };
      },
      src,
      CLIP_BYTES,
    );
    details.ranges = ranges;

    // Stage B: real decode + seek + the fullscreen viewer.
    const realVideo = process.env.SMOKE_VIDEO_FILE;
    if (!realVideo || !existsSync(realVideo)) {
      details.playback = "skipped: SMOKE_VIDEO_FILE not set";
      return details;
    }
    const canDecode = await page.evaluate(
      () =>
        document
          .createElement("video")
          .canPlayType('video/mp4; codecs="avc1.42E01E, mp4a.40.2"') !== "",
    );
    if (!canDecode) {
      details.playback = "skipped: browser lacks an H.264 decoder";
      return details;
    }

    const writeReal = () => copyFileSync(realVideo, join(ctx.workspaceDir, "real-video.mp4"));
    writeReal();
    await selectTreeFile(page, "real-video.mp4", writeReal);
    await inlinePreviewSrc(page, "real-video.mp4");

    details.playback = await page.evaluate(async () => {
      const video = document.querySelector(".video-preview video");
      const once = (target, event) =>
        new Promise((resolve) => target.addEventListener(event, resolve, { once: true }));
      const deadline = (label, ms) =>
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`${label}: timed out after ${ms}ms`)), ms),
        );
      if (video.readyState < 1) {
        await Promise.race([once(video, "loadedmetadata"), deadline("metadata", 20_000)]);
      }
      if (!(video.duration > 0)) throw new Error(`no duration (error: ${video.error?.code})`);

      // Seek to the midpoint: only satisfiable when the server answers
      // ranges, since moov resolution + the jump both need 206 slices.
      const target = video.duration / 2;
      video.currentTime = target;
      await Promise.race([once(video, "seeked"), deadline("seek", 20_000)]);
      if (Math.abs(video.currentTime - target) > 1) {
        throw new Error(`seek landed at ${video.currentTime}, wanted ~${target}`);
      }

      // Muted play so autoplay policy cannot block the check.
      video.muted = true;
      await video.play();
      const before = video.currentTime;
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      video.pause();
      if (!(video.currentTime > before)) throw new Error("playback did not advance");
      if (video.error) throw new Error(`video error ${video.error.code}`);
      return {
        duration: video.duration,
        seekedTo: target,
        playedFrom: before,
        playedTo: video.currentTime,
      };
    });
    await ctx.shot("video-playing");

    // Fullscreen viewer via the main action; Esc dismisses it.
    await page.click(".pill-main");
    await page.waitForSelector(".md-video-viewer video", { timeout: 10_000 });
    await ctx.shot("video-viewer");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector(".md-video-viewer"), {
      timeout: 5_000,
    });

    return details;
  },
};
