// Binary transfer acceptance over a real server + headless Chrome:
// bounded RSS, threads, and FDs for large plain reads, downloads, directory
// archives, and copies; byte ranges and validators; bounded multipart upload;
// cancelled-upload cleanup; and the SPA's visible one-upload FIFO queue with
// progress rendering coalesced far below the upload chunk rate.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function processResources(pid) {
  const status = readFileSync(`/proc/${pid}/status`, "utf8");
  const rss = status.match(/^VmRSS:\s+(\d+)\s+kB$/m);
  const threads = status.match(/^Threads:\s+(\d+)$/m);
  if (!rss || !threads) {
    throw new Error(`could not read process resources for server pid ${pid}`);
  }
  return {
    rssBytes: Number(rss[1]) * 1024,
    threads: Number(threads[1]),
    openFds: readdirSync(`/proc/${pid}/fd`).length,
  };
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

async function monitorResources(pid, promise) {
  const baseline = processResources(pid);
  const peak = { ...baseline };
  const timer = setInterval(() => {
    const sample = processResources(pid);
    peak.rssBytes = Math.max(peak.rssBytes, sample.rssBytes);
    peak.threads = Math.max(peak.threads, sample.threads);
    peak.openFds = Math.max(peak.openFds, sample.openFds);
  }, 25);
  let value;
  try {
    value = await promise;
  } finally {
    clearInterval(timer);
    const sample = processResources(pid);
    peak.rssBytes = Math.max(peak.rssBytes, sample.rssBytes);
    peak.threads = Math.max(peak.threads, sample.threads);
    peak.openFds = Math.max(peak.openFds, sample.openFds);
  }
  return { value, baseline, peak };
}

function assertResourceBudget(label, measurement, limits) {
  const growth = {
    rssBytes: measurement.peak.rssBytes - measurement.baseline.rssBytes,
    threads: measurement.peak.threads - measurement.baseline.threads,
    openFds: measurement.peak.openFds - measurement.baseline.openFds,
  };
  if (
    growth.rssBytes > limits.rssBytes ||
    growth.threads > limits.threads ||
    growth.openFds > limits.openFds
  ) {
    throw new Error(
      `${label} exceeded process resource budget: growth=${JSON.stringify(growth)} limits=${JSON.stringify(limits)}`,
    );
  }
  return {
    resourceBaseline: measurement.baseline,
    resourcePeak: measurement.peak,
    resourceGrowth: growth,
    resourceLimits: limits,
  };
}

async function fetchPrefix(page, path, query, stopAfterBytes) {
  return await page.evaluate(
    async ({ path, query, stopAfterBytes }) => {
      const token =
        sessionStorage.getItem("chan.token") ??
        new URLSearchParams(location.search).get("t") ??
        "";
      const encodedPath = path.split("/").map(encodeURIComponent).join("/");
      const params = new URLSearchParams(query);
      if (token) params.set("t", token);
      const started = performance.now();
      const response = await fetch(`/api/files/${encodedPath}?${params}`);
      if (!response.ok || !response.body) {
        throw new Error(`stream prefix ${path}: ${response.status} ${await response.text()}`);
      }
      const reader = response.body.getReader();
      let bytes = 0;
      let firstByteMs = null;
      while (bytes < stopAfterBytes) {
        const { value, done } = await reader.read();
        if (done) break;
        if (firstByteMs === null) firstByteMs = performance.now() - started;
        bytes += value.byteLength;
      }
      await reader.cancel();
      return {
        status: response.status,
        bytes,
        firstByteMs,
        contentLength: response.headers.get("content-length"),
        contentRange: response.headers.get("content-range"),
        acceptRanges: response.headers.get("accept-ranges"),
        etag: response.headers.get("etag"),
      };
    },
    { path, query, stopAfterBytes },
  );
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
    const resourceLimits = {
      rssBytes: 24 * MiB,
      threads: 8,
      openFds: 12,
    };
    const prefixBytes = 8 * MiB;

    const home = process.env.HOME ? resolve(process.env.HOME) : null;
    const workspace = resolve(ctx.workspaceDir);
    if (!home || (workspace !== home && !workspace.startsWith(`${home}/`))) {
      throw new Error(`large sparse fixtures must live under HOME: ${workspace}`);
    }

    const measurePrefix = async (step, path, query, fixtureBytes) => {
      const measurement = await monitorResources(
        serverPid,
        fetchPrefix(page, path, query, prefixBytes),
      );
      if (measurement.value.bytes < prefixBytes) {
        throw new Error(`${step} ended after only ${measurement.value.bytes} bytes`);
      }
      if (measurement.value.firstByteMs === null || measurement.value.firstByteMs > 3000) {
        throw new Error(`${step} first byte took ${measurement.value.firstByteMs} ms`);
      }
      const resources = assertResourceBudget(step, measurement, resourceLimits);
      record(step, {
        fixtureBytes,
        consumedBytes: measurement.value.bytes,
        firstByteMs: measurement.value.firstByteMs,
        status: measurement.value.status,
        contentLength: measurement.value.contentLength,
        ...resources,
      });
      await sleep(250);
    };
    const streamingSuiteBaseline = processResources(serverPid);

    try {
      // All-zero sparse files carry NUL bytes in the sniff prefix. The odd
      // suffix therefore takes the binary fallback used for ISOs, archives,
      // and unknown formats instead of being accepted as editable text.
      const unknownName = `bounded-unknown-${Date.now()}.opaque`;
      const unknownBytes = 3 * GiB;
      writeFileSync(join(ctx.workspaceDir, unknownName), "");
      truncateSync(join(ctx.workspaceDir, unknownName), unknownBytes);
      await measurePrefix("plain-unknown", unknownName, {}, unknownBytes);

      // Image and PDF are explicit classifier arms. Keep both on the same
      // bounded path and make either whole-file allocation exceed the budget
      // by a wide margin.
      for (const extension of ["png", "pdf"]) {
        const name = `bounded-${extension}-${Date.now()}.${extension}`;
        const fixtureBytes = 512 * MiB;
        writeFileSync(join(ctx.workspaceDir, name), "");
        truncateSync(join(ctx.workspaceDir, name), fixtureBytes);
        await measurePrefix(`plain-${extension}`, name, {}, fixtureBytes);
      }

      // A directory response streams tar headers and each member directly.
      // Cancelling after a prefix keeps the browser-side cost fixed while a
      // regression that materializes the sparse member remains observable in
      // the server process.
      const archiveDir = `bounded-directory-${Date.now()}`;
      const archiveMemberBytes = 3 * GiB;
      mkdirSync(join(ctx.workspaceDir, archiveDir));
      writeFileSync(join(ctx.workspaceDir, archiveDir, "huge-member.bin"), "");
      truncateSync(join(ctx.workspaceDir, archiveDir, "huge-member.bin"), archiveMemberBytes);
      await measurePrefix(
        "directory-download",
        archiveDir,
        { download: "1" },
        archiveMemberBytes,
      );

      // The File Browser copy API must reject above its existing binary sink
      // budget before creating a destination or leaving an atomic temp file.
      const copySource = `copy-source-${Date.now()}.bin`;
      const copySourceBytes = 64 * MiB;
      const copyDest = `copy-dest-${Date.now()}`;
      writeFileSync(join(ctx.workspaceDir, copySource), "");
      truncateSync(join(ctx.workspaceDir, copySource), copySourceBytes);
      mkdirSync(join(ctx.workspaceDir, copyDest));
      const beforeCopy = workspaceNames(join(ctx.workspaceDir, copyDest));
      const copy = await monitorResources(
        serverPid,
        page.evaluate(
          async ({ source, dest }) => {
            const token =
              sessionStorage.getItem("chan.token") ??
              new URLSearchParams(location.search).get("t") ??
              "";
            const headers = { "content-type": "application/json" };
            if (token) headers.authorization = `Bearer ${token}`;
            const started = performance.now();
            const response = await fetch("/api/fs/transfer", {
              method: "POST",
              headers,
              body: JSON.stringify({ op: "copy", sources: [source], dest_dir: dest }),
            });
            return {
              status: response.status,
              body: await response.text(),
              elapsedMs: performance.now() - started,
            };
          },
          { source: copySource, dest: copyDest },
        ),
      );
      const afterCopy = workspaceNames(join(ctx.workspaceDir, copyDest));
      if (copy.value.status !== 413) {
        throw new Error(`oversized copy returned ${copy.value.status}: ${copy.value.body}`);
      }
      if (JSON.stringify(afterCopy) !== JSON.stringify(beforeCopy)) {
        throw new Error(
          `oversized copy left destination state: before=${beforeCopy} after=${afterCopy}`,
        );
      }
      const smallCopySource = `copy-follow-up-${Date.now()}.bin`;
      writeFileSync(join(ctx.workspaceDir, smallCopySource), Buffer.from([1, 2, 3, 4]));
      const followUpCopy = await page.evaluate(
        async ({ source, dest }) => {
          const token =
            sessionStorage.getItem("chan.token") ??
            new URLSearchParams(location.search).get("t") ??
            "";
          const headers = { "content-type": "application/json" };
          if (token) headers.authorization = `Bearer ${token}`;
          const response = await fetch("/api/fs/transfer", {
            method: "POST",
            headers,
            body: JSON.stringify({ op: "copy", sources: [source], dest_dir: dest }),
          });
          return { status: response.status, body: await response.text() };
        },
        { source: smallCopySource, dest: copyDest },
      );
      const followUpTarget = join(ctx.workspaceDir, copyDest, smallCopySource);
      if (
        followUpCopy.status !== 200 ||
        !existsSync(followUpTarget) ||
        statSync(followUpTarget).size !== 4
      ) {
        throw new Error(
          `copy did not recover after refusal: ${followUpCopy.status} ${followUpCopy.body}`,
        );
      }
      record("copy-refusal", {
        fixtureBytes: copySourceBytes,
        status: copy.value.status,
        elapsedMs: copy.value.elapsedMs,
        destinationEntriesAfterRefusal: afterCopy,
        followUpStatus: followUpCopy.status,
        followUpBytes: statSync(followUpTarget).size,
        ...assertResourceBudget("copy-refusal", copy, resourceLimits),
      });

      // Learn the editor/index threshold from the server response rather than
      // duplicating it in this harness, then put a multi-gigabyte Markdown
      // file into the watcher and time an unrelated small File Browser rename
      // during the watcher's consideration window. Moving the oversized file
      // itself would instead measure its independent link-rewrite read.
      const thresholdProbe = `threshold-probe-${Date.now()}.md`;
      writeFileSync(join(ctx.workspaceDir, thresholdProbe), "# threshold\n");
      const maxEditableBytes = await page.evaluate(async (path) => {
        const token =
          sessionStorage.getItem("chan.token") ??
          new URLSearchParams(location.search).get("t") ??
          "";
        const params = new URLSearchParams();
        if (token) params.set("t", token);
        const response = await fetch(`/api/files/${encodeURIComponent(path)}?${params}`);
        if (!response.ok) throw new Error(`threshold probe: ${response.status}`);
        return (await response.json()).max_editable_bytes;
      }, thresholdProbe);
      if (!Number.isSafeInteger(maxEditableBytes) || maxEditableBytes <= 0) {
        throw new Error(`invalid server-reported editable threshold: ${maxEditableBytes}`);
      }
      const indexName = `oversized-index-${Date.now()}.md`;
      const indexBytes = 3 * GiB;
      const renameDir = `renamed-index-${Date.now()}`;
      const renameProbeBytes = statSync(join(ctx.workspaceDir, thresholdProbe)).size;
      mkdirSync(join(ctx.workspaceDir, renameDir));
      writeFileSync(join(ctx.workspaceDir, indexName), "# oversized\n");
      truncateSync(join(ctx.workspaceDir, indexName), indexBytes);
      if (indexBytes <= maxEditableBytes) {
        throw new Error(`index fixture ${indexBytes} does not exceed threshold ${maxEditableBytes}`);
      }
      await sleep(350);
      const rename = await monitorResources(
        serverPid,
        page.evaluate(
          async ({ source, dest }) => {
            const token =
              sessionStorage.getItem("chan.token") ??
              new URLSearchParams(location.search).get("t") ??
              "";
            const headers = { "content-type": "application/json" };
            if (token) headers.authorization = `Bearer ${token}`;
            const started = performance.now();
            const response = await fetch("/api/fs/transfer", {
              method: "POST",
              headers,
              body: JSON.stringify({ op: "move", sources: [source], dest_dir: dest }),
            });
            return {
              status: response.status,
              body: await response.text(),
              elapsedMs: performance.now() - started,
            };
          },
          { source: thresholdProbe, dest: renameDir },
        ),
      );
      if (rename.value.status !== 200) {
        throw new Error(`rename beside oversized index returned ${rename.value.status}`);
      }
      if (rename.value.elapsedMs > 2000) {
        throw new Error(`rename beside oversized index took ${rename.value.elapsedMs} ms`);
      }
      const renamedProbe = join(ctx.workspaceDir, renameDir, thresholdProbe);
      if (!existsSync(renamedProbe) || statSync(renamedProbe).size !== renameProbeBytes) {
        throw new Error("rename beside oversized index did not preserve the probe file");
      }
      const oversizedIndex = join(ctx.workspaceDir, indexName);
      if (!existsSync(oversizedIndex) || statSync(oversizedIndex).size !== indexBytes) {
        throw new Error("watcher consideration did not preserve the sparse index fixture");
      }
      record("oversized-index-rename", {
        fixtureBytes: indexBytes,
        renameProbeBytes,
        maxEditableBytes,
        status: rename.value.status,
        elapsedMs: rename.value.elapsedMs,
        ...assertResourceBudget("oversized-index-rename", rename, resourceLimits),
      });

      // One small byte-exact fixture pins resumable download behavior at the
      // first byte, last byte, and a requested end past EOF. A size-changing
      // rewrite must also produce a different non-weak validator.
      const rangeName = `range-download-${Date.now()}.bin`;
      writeFileSync(join(ctx.workspaceDir, rangeName), Buffer.from([...Array(16).keys()]));
      const fetchRange = async (range) =>
        await page.evaluate(
          async ({ path, range }) => {
            const token =
              sessionStorage.getItem("chan.token") ??
              new URLSearchParams(location.search).get("t") ??
              "";
            const params = new URLSearchParams({ download: "1" });
            if (token) params.set("t", token);
            const response = await fetch(`/api/files/${encodeURIComponent(path)}?${params}`, {
              headers: { range },
            });
            return {
              status: response.status,
              bytes: [...new Uint8Array(await response.arrayBuffer())],
              contentRange: response.headers.get("content-range"),
              contentLength: response.headers.get("content-length"),
              acceptRanges: response.headers.get("accept-ranges"),
              etag: response.headers.get("etag"),
            };
          },
          { path: rangeName, range },
        );
      const firstRange = await fetchRange("bytes=0-0");
      const lastRange = await fetchRange("bytes=-1");
      const spanningRange = await fetchRange("bytes=12-99");
      const expectedRanges = [
        [firstRange, [0], "bytes 0-0/16"],
        [lastRange, [15], "bytes 15-15/16"],
        [spanningRange, [12, 13, 14, 15], "bytes 12-15/16"],
      ];
      for (const [actual, bytes, contentRange] of expectedRanges) {
        if (
          actual.status !== 206 ||
          actual.acceptRanges !== "bytes" ||
          actual.contentRange !== contentRange ||
          actual.contentLength !== String(bytes.length) ||
          JSON.stringify(actual.bytes) !== JSON.stringify(bytes)
        ) {
          throw new Error(`bad download range: ${JSON.stringify(actual)}`);
        }
      }
      if (!firstRange.etag || firstRange.etag.startsWith("W/")) {
        throw new Error(`download validator is not strong: ${firstRange.etag}`);
      }
      writeFileSync(join(ctx.workspaceDir, rangeName), Buffer.from([...Array(17).keys()]));
      const changedRange = await fetchRange("bytes=0-0");
      if (!changedRange.etag || changedRange.etag === firstRange.etag) {
        throw new Error(
          `download validator did not change: before=${firstRange.etag} after=${changedRange.etag}`,
        );
      }
      record("download-ranges-validator", {
        first: firstRange,
        last: lastRange,
        spanningEnd: spanningRange,
        changedEtag: changedRange.etag,
      });

      await sleep(500);
      const streamingSuiteFinal = processResources(serverPid);
      const streamingSuiteGrowth = {
        rssBytes: streamingSuiteFinal.rssBytes - streamingSuiteBaseline.rssBytes,
        threads: streamingSuiteFinal.threads - streamingSuiteBaseline.threads,
        openFds: streamingSuiteFinal.openFds - streamingSuiteBaseline.openFds,
      };
      if (
        streamingSuiteGrowth.rssBytes > resourceLimits.rssBytes ||
        streamingSuiteGrowth.threads > resourceLimits.threads ||
        streamingSuiteGrowth.openFds > resourceLimits.openFds
      ) {
        throw new Error(
          `streaming suite leaked process resources: growth=${JSON.stringify(streamingSuiteGrowth)}`,
        );
      }
      record("streaming-suite-cleanup", {
        resourceBaseline: streamingSuiteBaseline,
        resourceFinal: streamingSuiteFinal,
        resourceGrowth: streamingSuiteGrowth,
        resourceLimits,
      });

      // Complete one moderate download to pin exact byte count in addition to
      // the cancelled multi-gigabyte probes above.
      const downloadName = `bounded-download-${Date.now()}.bin`;
      const downloadPath = join(ctx.workspaceDir, downloadName);
      writeFileSync(downloadPath, "");
      truncateSync(downloadPath, 32 * MiB);
      const download = monitorResources(
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
      if (downloadResult.value.bytes !== 32 * MiB) {
        throw new Error(`binary download truncated at ${downloadResult.value.bytes} bytes`);
      }
      if (downloadResult.value.firstByteMs === null || downloadResult.value.firstByteMs > 3000) {
        throw new Error(`binary download first byte took ${downloadResult.value.firstByteMs} ms`);
      }
      record("download", {
        ...downloadResult.value,
        fixtureBytes: 32 * MiB,
        ...assertResourceBudget("download", downloadResult, resourceLimits),
      });

      // Multipart upload through XHR: the browser may own a Blob, but the
      // measured server process must remain bounded while E7 consumes it.
      const fullUploadName = `bounded-upload-${Date.now()}.bin`;
      const fullUpload = await monitorResources(
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
        ...assertResourceBudget("upload", fullUpload, resourceLimits),
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
      // Coalescing probe, installed before any queue upload starts: it
      // counts raw XHR upload progress events per multipart request (the
      // producer's chunk rate). The transfers store ticks
      // window.__chanTransferApplies once per rendered progress update.
      await page.evaluate(() => {
        const chunkCounts = [];
        const originalSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.send = function (...args) {
          if (args[0] instanceof FormData) {
            const counter = { count: 0 };
            chunkCounts.push(counter);
            this.upload.addEventListener("progress", () => {
              counter.count += 1;
            });
          }
          return originalSend.apply(this, args);
        };
        window.__smokeUploadChunkCounts = {
          chunkCounts,
          restore: () => {
            XMLHttpRequest.prototype.send = originalSend;
          },
        };
      });
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
          progressChanges.push(Number(match[1]));
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

      // The sampled percentages must climb monotonically to a complete
      // commit; the coalescing ratio itself is probed below, where the
      // producer runs unthrottled.
      for (let index = 1; index < progressChanges.length; index += 1) {
        if (progressChanges[index] < progressChanges[index - 1]) {
          throw new Error(`upload progress went backwards: ${JSON.stringify(progressChanges)}`);
        }
      }
      if (statSync(join(ctx.workspaceDir, firstFileName)).size !== 4 * MiB) {
        throw new Error("first queued upload committed a truncated file");
      }
      if (existsSync(join(ctx.workspaceDir, secondFileName))) {
        throw new Error("queued-cancelled upload unexpectedly started");
      }
      if (existsSync(join(ctx.workspaceDir, thirdFileName))) {
        throw new Error("active-cancelled upload left a partial target");
      }
      record("queue-drain-progress", {
        progressChanges,
        firstCommitted: statSync(join(ctx.workspaceDir, firstFileName)).size,
        secondAbsent: true,
        thirdAbsent: true,
      });

      // Coalescing property probe, not a rate: one multi-file upload op
      // pushes one progress event per file plus one per-file start
      // report (500+ producer ticks over a few seconds), while the
      // transfers store may render at most one update per 100 ms
      // coalescing window. The rendered count is asserted against that
      // structural cap, not against any wall-clock threshold, so a
      // loaded host cannot flip the result. A single throttled or raw
      // loopback upload is a useless probe: the CDP throttler delivers
      // progress at ~10 Hz per 100 ms tick (the same rate as the
      // coalescing window) and raw loopback fires a handful of
      // multi-MiB write events.
      await cdp.send("Network.emulateNetworkConditions", {
        offline: false,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1,
        connectionType: "none",
      });
      const probeStamp = Date.now();
      const probeFiles = [];
      for (let index = 0; index < 256; index += 1) {
        const probeFile = join(pickerDir, `probe-${index}-${probeStamp}.bin`);
        writeFileSync(probeFile, Buffer.alloc(256 * 1024, (index % 251) + 1));
        probeFiles.push(probeFile);
      }
      const probeChooserPromise = page.waitForFileChooser({ timeout: 15_000 });
      await ctx.exec(ctx.chanBin, ["shell", "upload", "."], {
        cwd: ctx.workspaceDir,
        env,
      });
      const probeChooser = await probeChooserPromise;
      const probeBaseline = await page.evaluate(() => ({
        applied: window.__chanTransferApplies ?? 0,
        uploads: window.__smokeUploadChunkCounts?.chunkCounts.length ?? 0,
      }));
      await probeChooser.accept(probeFiles);
      const probePercents = [];
      let lastProbePercent = null;
      const lastProbeName = probeFiles.at(-1).split("/").at(-1);
      const probeStarted = Date.now();
      while (!existsSync(join(ctx.workspaceDir, lastProbeName))) {
        const line = await page.evaluate(
          () =>
            [...document.querySelectorAll(".tb-line")]
              .map((element) => element.textContent ?? "")
              .find((text) => text.includes("256 files")) ?? "",
        );
        const match = line.match(/\((\d+)%\)/);
        if (match && match[1] !== lastProbePercent) {
          lastProbePercent = match[1];
          probePercents.push(Number(match[1]));
        }
        if (Date.now() - probeStarted > 30_000) {
          throw new Error("coalescing probe upload did not finish");
        }
        await sleep(20);
      }
      const probeDurationMs = Date.now() - probeStarted;
      const probeApplied =
        (await page.evaluate(() => window.__chanTransferApplies ?? 0)) - probeBaseline.applied;
      const probeChunks = await page.evaluate((before) => {
        const counts = window.__smokeUploadChunkCounts?.chunkCounts ?? [];
        return counts.slice(before).reduce((sum, counter) => sum + counter.count, 0);
      }, probeBaseline.uploads);
      for (let index = 1; index < probePercents.length; index += 1) {
        if (probePercents[index] < probePercents[index - 1]) {
          throw new Error(`probe progress went backwards: ${JSON.stringify(probePercents)}`);
        }
      }
      if (probeChunks < 100) {
        throw new Error(
          `coalescing probe saw only ${probeChunks} progress events; the burst assumption is broken`,
        );
      }
      // The coalescing window is structural: two rendered updates for one
      // transfer are always at least PROGRESS_INTERVAL_MS apart (the
      // leading edge requires it and the trailing timer cannot fire
      // early), so over any window the rendered count stays below
      // window/100 plus one. Ten ticks of slack absorbs the leading edge
      // and the measurement bracket, and a slow host only stretches the
      // window and lowers the count, so load cannot flip the result.
      // With the coalescing removed every producer tick renders (500+
      // updates here) and the bound fails several times over. A naive
      // ratio against the raw event count would be load-fragile: the
      // event count is fixed at one per file while the rendered count
      // scales with the wall time the host takes to push them through.
      if (probeApplied > probeDurationMs / 100 + 10) {
        throw new Error(
          `upload progress was not coalesced: ${probeApplied} rendered updates in ${probeDurationMs} ms for ${probeChunks} progress events`,
        );
      }
      const probeNames = new Set(probeFiles.map((file) => file.split("/").at(-1)));
      const committedProbeFiles = workspaceNames(ctx.workspaceDir).filter((name) =>
        probeNames.has(name),
      );
      if (committedProbeFiles.length !== probeFiles.length) {
        throw new Error(
          `coalescing probe committed ${committedProbeFiles.length} of ${probeFiles.length} files`,
        );
      }
      record("coalescing-probe", {
        probePercents,
        probeApplied,
        probeChunks,
        probeDurationMs,
        files: committedProbeFiles.length,
      });
      return evidence;
    } finally {
      await page
        .evaluate(() => window.__smokeUploadChunkCounts?.restore?.())
        .catch(() => {});
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
