// Binary transfer acceptance over a real server + headless Chrome:
// bounded server RSS and early first-byte delivery on a large download,
// bounded multipart upload, cancelled-upload temp cleanup, and the SPA's
// visible one-upload FIFO queue with <=10 Hz progress rendering.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const MiB = 1024 * 1024;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function rssBytes(pid) {
  const match = readFileSync(`/proc/${pid}/status`, "utf8").match(/^VmRSS:\s+(\d+)\s+kB$/m);
  if (!match) throw new Error(`could not read VmRSS for server pid ${pid}`);
  return Number(match[1]) * 1024;
}

function workspaceNames(dir) {
  return readdirSync(dir).sort();
}

async function waitFor(probe, description, timeoutMs = 30_000, intervalMs = 50) {
  const started = Date.now();
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() - started > timeoutMs) {
      throw new Error(`timed out waiting for ${description}`);
    }
    await sleep(intervalMs);
  }
}

async function monitorRss(pid, promise) {
  const baseline = rssBytes(pid);
  let peak = baseline;
  const timer = setInterval(() => {
    peak = Math.max(peak, rssBytes(pid));
  }, 25);
  let value;
  try {
    value = await promise;
  } finally {
    clearInterval(timer);
    peak = Math.max(peak, rssBytes(pid));
  }
  return { value, baseline, peak };
}

export default {
  name: "binary-transfer-streaming-queue",
  async run(ctx) {
    const { page, serverPid } = ctx;
    const cdp = await page.createCDPSession();
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 20,
      downloadThroughput: 4 * MiB,
      uploadThroughput: 2 * MiB,
      connectionType: "wifi",
    });

    const evidence = { steps: [] };
    const record = (step, data) => {
      evidence.steps.push({ step, ...data });
      console.log(`[smoke:62] ${step}: ${JSON.stringify(data)}`);
    };
    const memoryLimit = 24 * MiB;

    try {
      // A sparse 32 MiB file makes whole-file server buffering obvious without
      // allocating the same payload in the Node harness.
      const downloadName = `bounded-download-${Date.now()}.bin`;
      const downloadPath = join(ctx.workspaceDir, downloadName);
      writeFileSync(downloadPath, "");
      truncateSync(downloadPath, 32 * MiB);
      const download = monitorRss(
        serverPid,
        page.evaluate(async (path) => {
          const token =
            sessionStorage.getItem("chan.token") ??
            new URLSearchParams(location.search).get("t") ??
            "";
          const started = performance.now();
          const response = await fetch(
            `/api/files/${encodeURIComponent(path)}?download=1&t=${encodeURIComponent(token)}`,
          );
          if (!response.ok || !response.body) {
            throw new Error(`binary download: ${response.status}`);
          }
          const reader = response.body.getReader();
          let bytes = 0;
          let firstByteMs = null;
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            if (firstByteMs === null) firstByteMs = performance.now() - started;
            bytes += value.byteLength;
          }
          return { bytes, firstByteMs };
        }, downloadName),
      );
      const downloadResult = await download;
      const downloadGrowth = downloadResult.peak - downloadResult.baseline;
      if (downloadResult.value.bytes !== 32 * MiB) {
        throw new Error(`binary download truncated at ${downloadResult.value.bytes} bytes`);
      }
      if (downloadResult.value.firstByteMs === null || downloadResult.value.firstByteMs > 3000) {
        throw new Error(`binary download first byte took ${downloadResult.value.firstByteMs} ms`);
      }
      if (downloadGrowth > memoryLimit) {
        throw new Error(`binary download grew server RSS by ${downloadGrowth} bytes`);
      }
      record("download", {
        ...downloadResult.value,
        rssGrowthBytes: downloadGrowth,
        rssLimitBytes: memoryLimit,
      });

      // Multipart upload through XHR: the browser may own a Blob, but the
      // measured server process must remain bounded while E7 consumes it.
      const fullUploadName = `bounded-upload-${Date.now()}.bin`;
      const fullUpload = await monitorRss(
        serverPid,
        page.evaluate(
          async ({ name, size }) => {
            const token =
              sessionStorage.getItem("chan.token") ??
              new URLSearchParams(location.search).get("t") ??
              "";
            const chunk = new Uint8Array(64 * 1024);
            chunk.fill(0x5a);
            const parts = Array.from({ length: size / chunk.length }, () => chunk);
            const file = new File(parts, name, { type: "application/octet-stream" });
            const form = new FormData();
            form.append("dir", "");
            form.append("file", file);
            const progress = [];
            const started = performance.now();
            return await new Promise((resolve, reject) => {
              const xhr = new XMLHttpRequest();
              xhr.open("POST", "/api/files/upload");
              if (token) xhr.setRequestHeader("authorization", `Bearer ${token}`);
              xhr.upload.onprogress = (event) => {
                progress.push({
                  atMs: performance.now() - started,
                  loaded: event.loaded,
                  total: event.lengthComputable ? event.total : null,
                });
              };
              xhr.onerror = () => reject(new Error("bounded upload network error"));
              xhr.onload = () => {
                if (xhr.status < 200 || xhr.status >= 300) {
                  reject(new Error(`bounded upload: ${xhr.status} ${xhr.responseText}`));
                  return;
                }
                resolve({ progress, response: JSON.parse(xhr.responseText) });
              };
              xhr.send(form);
            });
          },
          { name: fullUploadName, size: 16 * MiB },
        ),
      );
      const uploadGrowth = fullUpload.peak - fullUpload.baseline;
      if (uploadGrowth > memoryLimit) {
        throw new Error(`binary upload grew server RSS by ${uploadGrowth} bytes`);
      }
      if (
        !existsSync(join(ctx.workspaceDir, fullUploadName)) ||
        statSync(join(ctx.workspaceDir, fullUploadName)).size !== 16 * MiB
      ) {
        throw new Error("bounded upload did not commit the complete file");
      }
      record("upload", {
        bytes: statSync(join(ctx.workspaceDir, fullUploadName)).size,
        progressEvents: fullUpload.value.progress.length,
        firstProgressMs: fullUpload.value.progress.find((event) => event.loaded > 0)?.atMs ?? null,
        rssGrowthBytes: uploadGrowth,
        rssLimitBytes: memoryLimit,
      });

      // Abort a multipart stream after progress begins. The semantic atomic
      // writer must leave neither the target nor a same-directory temp.
      const cancelName = `cancelled-upload-${Date.now()}.bin`;
      const beforeCancel = workspaceNames(ctx.workspaceDir);
      const cancelled = await page.evaluate(
        async ({ name, size }) => {
          const token =
            sessionStorage.getItem("chan.token") ??
            new URLSearchParams(location.search).get("t") ??
            "";
          const chunk = new Uint8Array(64 * 1024);
          const parts = Array.from({ length: size / chunk.length }, () => chunk);
          const form = new FormData();
          form.append("dir", "");
          form.append("file", new File(parts, name));
          return await new Promise((resolve) => {
            const xhr = new XMLHttpRequest();
            let sawProgress = false;
            xhr.open("POST", "/api/files/upload");
            if (token) xhr.setRequestHeader("authorization", `Bearer ${token}`);
            xhr.upload.onprogress = (event) => {
              if (!sawProgress && event.loaded > 0) {
                sawProgress = true;
                xhr.abort();
              }
            };
            xhr.onabort = () => resolve({ aborted: true, sawProgress });
            xhr.onerror = () => resolve({ aborted: false, sawProgress });
            xhr.onload = () => resolve({ aborted: false, sawProgress });
            xhr.send(form);
          });
        },
        { name: cancelName, size: 8 * MiB },
      );
      await sleep(1500);
      const afterCancel = workspaceNames(ctx.workspaceDir);
      if (!cancelled.aborted || !cancelled.sawProgress) {
        throw new Error(`multipart cancellation did not occur after progress: ${JSON.stringify(cancelled)}`);
      }
      if (existsSync(join(ctx.workspaceDir, cancelName))) {
        throw new Error("cancelled upload left a partial target");
      }
      if (JSON.stringify(afterCancel) !== JSON.stringify(beforeCancel)) {
        throw new Error(
          `cancelled upload leaked a temp entry: before=${beforeCancel} after=${afterCancel}`,
        );
      }
      record("cancel-cleanup", cancelled);

      // Drive three real SPA upload operations through `cs upload` while the
      // CDP upload throttle keeps the first active. One row runs, two queue;
      // cancelling the middle row never starts it, and completion promotes the
      // oldest remaining row.
      await cdp.send("Network.emulateNetworkConditions", {
        offline: false,
        latency: 20,
        downloadThroughput: 4 * MiB,
        uploadThroughput: 512 * 1024,
        connectionType: "wifi",
      });
      const windowId = await page.evaluate(
        () =>
          new URL(location.href).searchParams.get("w")?.trim() ||
          sessionStorage.getItem("chan.session.window")?.trim() ||
          "",
      );
      if (!windowId || !ctx.controlSocket) {
        ctx.skip("transfer queue smoke needs a window id and control socket");
      }
      const pickerDir = join(ctx.outDir, `queue-files-${Date.now()}`);
      mkdirSync(pickerDir, { recursive: true });
      const pickerFiles = [1, 2, 3].map((number) =>
        join(pickerDir, `queue-${number}-${Date.now()}.bin`),
      );
      for (const [index, file] of pickerFiles.entries()) {
        writeFileSync(file, Buffer.alloc(4 * MiB, index + 1));
      }
      const env = {
        ...process.env,
        CHAN_CONTROL_SOCKET: ctx.controlSocket,
        CHAN_WINDOW_ID: windowId,
      };
      for (const file of pickerFiles) {
        const chooserPromise = page.waitForFileChooser({ timeout: 15_000 });
        await ctx.exec(ctx.chanBin, ["shell", "upload", "."], {
          cwd: ctx.workspaceDir,
          env,
        });
        const chooser = await chooserPromise;
        await chooser.accept([file]);
      }

      await waitFor(
        () =>
          page.evaluate(() => {
            const button = [...document.querySelectorAll("button")].find((candidate) =>
              candidate.textContent?.includes("Transfers (3)"),
            );
            if (!button) return false;
            button.click();
            return true;
          }),
        "three-transfer status button",
      );
      const queuedRows = await waitFor(
        () =>
          page.evaluate(() => {
            const lines = [...document.querySelectorAll(".tb-line")].map(
              (line) => line.textContent ?? "",
            );
            return lines.filter((line) => line.startsWith("Queued ")).length === 2
              ? lines
              : null;
          }),
        "visible upload queue",
      );
      record("queue-visible", { rows: queuedRows });

      // Cancel the middle row while it is still queued. It must never start.
      const secondFileName = pickerFiles[1].split("/").at(-1);
      await page.evaluate((name) => {
        const row = [...document.querySelectorAll(".tb-row")].find((candidate) =>
          candidate.textContent?.includes(name),
        );
        row?.querySelector("button.tb-action")?.click();
      }, secondFileName);
      await waitFor(
        () =>
          page.evaluate(
            (name) =>
              [...document.querySelectorAll(".tb-line")].some(
                (line) =>
                  line.textContent?.includes(name) &&
                  line.textContent.startsWith("Cancelled "),
              ),
            secondFileName,
          ),
        "queued cancellation",
      );

      const progressChanges = [];
      let lastProgress = null;
      const firstFileName = pickerFiles[0].split("/").at(-1);
      const thirdFileName = pickerFiles[2].split("/").at(-1);
      const progressStarted = Date.now();
      while (!existsSync(join(ctx.workspaceDir, firstFileName))) {
        const line = await page.evaluate(
          (name) =>
            [...document.querySelectorAll(".tb-line")]
              .map((element) => element.textContent ?? "")
              .find((text) => text.includes(name)) ?? "",
          firstFileName,
        );
        const match = line.match(/\((\d+)%\)/);
        if (match && match[1] !== lastProgress) {
          lastProgress = match[1];
          progressChanges.push({ atMs: Date.now() - progressStarted, percent: Number(match[1]) });
        }
        if (Date.now() - progressStarted > 30_000) {
          throw new Error("first queued upload did not finish");
        }
        await sleep(20);
      }

      await waitFor(
        () =>
          page.evaluate(
            (name) =>
              [...document.querySelectorAll(".tb-line")].some(
                (line) =>
                  line.textContent?.includes(name) &&
                  line.textContent.startsWith("Uploading "),
              ),
            thirdFileName,
          ),
        "FIFO promotion after completion",
      );
      await page.evaluate((name) => {
        const row = [...document.querySelectorAll(".tb-row")].find((candidate) =>
          candidate.textContent?.includes(name),
        );
        row?.querySelector("button.tb-action")?.click();
      }, thirdFileName);
      await sleep(1500);

      // The first sample may observe a percentage rendered before this loop
      // started, so its timestamp is not an update timestamp. Measure only
      // steady-state transitions after that initial observation.
      const deltas = progressChanges
        .slice(2)
        .map((entry, index) => entry.atMs - progressChanges[index + 1].atMs);
      if (progressChanges.length < 3 || Math.min(...deltas) < 75) {
        throw new Error(
          `upload progress was not coalesced to <=10 Hz: ${JSON.stringify(progressChanges)}`,
        );
      }
      if (existsSync(join(ctx.workspaceDir, secondFileName))) {
        throw new Error("queued-cancelled upload unexpectedly started");
      }
      if (existsSync(join(ctx.workspaceDir, thirdFileName))) {
        throw new Error("active-cancelled upload left a partial target");
      }
      record("queue-drain-progress", {
        progressChanges,
        minProgressDeltaMs: Math.min(...deltas),
        firstCommitted: statSync(join(ctx.workspaceDir, firstFileName)).size,
        secondAbsent: true,
        thirdAbsent: true,
      });
      return evidence;
    } finally {
      await cdp.send("Network.emulateNetworkConditions", {
        offline: false,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1,
        connectionType: "none",
      });
      await cdp.detach().catch(() => {});
    }
  },
};
