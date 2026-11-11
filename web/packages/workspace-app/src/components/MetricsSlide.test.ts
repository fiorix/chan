// @vitest-environment jsdom
import { mount, tick, unmount } from "svelte";
import { afterEach, expect, test, vi } from "vitest";
import { privacy } from "@chan/web-shared/privacy";
import { api } from "../api/client";
import { metrics } from "../state/metrics.svelte";
import type { MetricSample, MetricsView } from "../api/metrics";
import MetricsSlide from "./MetricsSlide.svelte";

let mounted: ReturnType<typeof mount> | undefined;
afterEach(async () => {
  if (mounted) await unmount(mounted);
  mounted = undefined;
  vi.restoreAllMocks(); vi.useRealTimers();
  metrics.view = null; metrics.samples = []; metrics.error = null;
  privacy.enabled = false;
  document.body.innerHTML = "";
});

test("receiving a snapshot does not retrigger the visibility effect or bypass the poll interval", async () => {
  vi.useFakeTimers();
  const view = { schemaVersion: 1, identity: { instanceId: "a", version: "1", build: "abc", pid: 42, hostname: "devserver.example" }, latest: null, history: [] } as unknown as MetricsView;
  const request = vi.spyOn(api, "metrics").mockResolvedValue(view);
  const target = document.createElement("div"); document.body.append(target);
  mounted = mount(MetricsSlide, { target });
  await tick(); await vi.advanceTimersByTimeAsync(0); await tick();
  expect(target.textContent).toContain("PID 42");
  expect(target.textContent).toContain("Host: devserver.example");
  expect(request).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(999); await tick();
  expect(request).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1); await tick();
  expect(request).toHaveBeenCalledTimes(2);
  await unmount(mounted); mounted = undefined;
  await vi.advanceTimersByTimeAsync(3000);
  expect(request).toHaveBeenCalledTimes(2);
});

test("unavailable process I/O is labelled and leaves gaps instead of plotting zero", async () => {
  const traffic = { active: 0, opened: 0, receivedBytes: 0, sentBytes: 0, receivedBytesPerSecond: null, sentBytesPerSecond: null };
  const sample: MetricSample = {
    sequence: 1, elapsedMs: 1000, sampledAtMs: 1000, collectionMicros: 1,
    process: { uptimeSeconds: 1, cpuTimeMs: 1, cpuPercent: null, residentBytes: 1024, ioScope: "unavailable", readBytes: null, writtenBytes: null, readBytesPerSecond: null, writtenBytesPerSecond: null },
    network: traffic, http2: traffic, yamux: traffic, reverseConnections: traffic, transferPayload: traffic,
    transfers: { queued: 0, running: 0, workerCapacity: 2, queueCapacity: 32, finished: 9, cancelled: 3, stalled: 5, panicked: 6, refused: 8 },
    gatewayTunnels: 0, tunnelDialFailures: 0, reverseListeners: 0, yamuxWaiting: 0, yamuxServing: 0, yamuxServiceCapacity: 0, yamuxStreamLimit: 256,
  };
  metrics.view = {
    schemaVersion: 1, identity: { instanceId: "bsd", version: "1", build: "abc", pid: 42, hostname: "bsd.example" },
    latest: sample, history: [sample],
    storage: { path: "/home/test/.chan", logicalBytes: null, allocatedBytes: null, files: null, sampledAtMs: null, scanMs: null, error: null },
  };
  metrics.samples = [sample];
  const target = document.createElement("div"); document.body.append(target);
  mounted = mount(MetricsSlide, { target, props: { active: false } });
  await tick();
  expect(target.textContent).toContain("9 finished · 3 cancelled · 5 stalled · 6 panicked · 8 refused");
  const cards = [...target.querySelectorAll("article")].filter((card) => card.querySelector("h3")?.textContent?.startsWith("I/O"));
  expect(cards).toHaveLength(2);
  expect(cards[0].textContent).toContain("Unavailable on this platform");
  for (const card of cards) {
    expect(card.querySelector("strong")?.textContent).toBe("n/a");
    expect(card.querySelector("svg path:last-child")?.getAttribute("d")).toBe("");
  }
});

test("privacy mode masks the host name and the chan home path, and follows a toggle while mounted", async () => {
  const traffic = { active: 0, opened: 0, receivedBytes: 0, sentBytes: 0, receivedBytesPerSecond: null, sentBytesPerSecond: null };
  const sample: MetricSample = {
    sequence: 1, elapsedMs: 1000, sampledAtMs: 1000, collectionMicros: 1,
    process: { uptimeSeconds: 1, cpuTimeMs: 1, cpuPercent: 1, residentBytes: 1024, ioScope: "storage_io", readBytes: 1, writtenBytes: 1, readBytesPerSecond: 0, writtenBytesPerSecond: 0 },
    network: traffic, http2: traffic, yamux: traffic, reverseConnections: traffic, transferPayload: traffic,
    transfers: { queued: 0, running: 0, workerCapacity: 2, queueCapacity: 32, finished: 0, cancelled: 0, stalled: 0, panicked: 0, refused: 0 },
    gatewayTunnels: 1, tunnelDialFailures: 0, reverseListeners: 0, yamuxWaiting: 0, yamuxServing: 0, yamuxServiceCapacity: 0, yamuxStreamLimit: 256,
  };
  metrics.view = {
    schemaVersion: 1, identity: { instanceId: "a", version: "1", build: "abc", pid: 42, hostname: "devserver.example" },
    latest: sample, history: [sample],
    storage: { path: "/home/alice/.chan", logicalBytes: 5, allocatedBytes: 4096, files: 1, sampledAtMs: 1000, scanMs: 1, error: null },
  };
  metrics.samples = [sample];
  const target = document.createElement("div"); document.body.append(target);
  mounted = mount(MetricsSlide, { target, props: { active: false } });
  await tick();
  const shown = () => {
    expect(target.textContent).toContain("Host: devserver.example");
    expect(target.textContent).toContain("/home/alice/.chan");
    expect(target.querySelector(".redacted")).toBeNull();
  };
  shown();
  privacy.enabled = true;
  await tick();
  // Neither value is anywhere in the slide, a hover title included.
  expect(target.innerHTML).not.toContain("devserver.example");
  expect(target.innerHTML).not.toContain("alice");
  expect(target.querySelector('[aria-label="host name hidden"]')?.textContent).toBe("Hidden");
  expect(target.querySelector('[aria-label="chan home path hidden"]')?.textContent).toBe("Hidden");
  // The readings that name nobody stay.
  expect(target.textContent).toContain("PID 42");
  expect(target.textContent).toContain("1 gateway");
  privacy.enabled = false;
  await tick();
  shown();
});

test("a failed storage scan shows its error and names a last completed total only when the view holds one", async () => {
  const traffic = { active: 0, opened: 0, receivedBytes: 0, sentBytes: 0, receivedBytesPerSecond: null, sentBytesPerSecond: null };
  const sample: MetricSample = {
    sequence: 1, elapsedMs: 1000, sampledAtMs: 1000, collectionMicros: 1,
    process: { uptimeSeconds: 1, cpuTimeMs: 1, cpuPercent: 1, residentBytes: 1024, ioScope: "storage_io", readBytes: 1, writtenBytes: 1, readBytesPerSecond: 0, writtenBytesPerSecond: 0 },
    network: traffic, http2: traffic, yamux: traffic, reverseConnections: traffic, transferPayload: traffic,
    transfers: { queued: 0, running: 0, workerCapacity: 2, queueCapacity: 32, finished: 0, cancelled: 0, stalled: 0, panicked: 0, refused: 0 },
    gatewayTunnels: 0, tunnelDialFailures: 0, reverseListeners: 0, yamuxWaiting: 0, yamuxServing: 0, yamuxServiceCapacity: 0, yamuxStreamLimit: 256,
  };
  const pending = { path: "/home/test/.chan", logicalBytes: null, allocatedBytes: null, files: null, sampledAtMs: null, scanMs: null, error: null };
  const scanned = { ...pending, logicalBytes: 2048, allocatedBytes: 4096, files: 3, sampledAtMs: 1000, scanMs: 2 };
  const show = async (storage: MetricsView["storage"]) => {
    metrics.view = { schemaVersion: 1, identity: { instanceId: "a", version: "1", build: "abc", pid: 42, hostname: "box" }, latest: sample, history: [sample], storage };
    await tick();
    // The storage card, by its heading.
    const card = [...target.querySelectorAll("article")].find((article) => article.querySelector("h3")?.textContent?.startsWith("Storage"));
    return card?.textContent ?? "";
  };
  metrics.samples = [sample];
  const target = document.createElement("div"); document.body.append(target);
  mounted = mount(MetricsSlide, { target, props: { active: false } });
  // The first scan failed: there is no total, and the reason is the server's.
  let card = await show({ ...pending, error: "Permission denied (os error 13)" });
  expect(card).not.toContain("last completed total");
  expect(card).toContain("Storage scan failed: Permission denied (os error 13).");
  expect(card).toContain("Scan pending");
  // A later scan failed: the totals are those of the last completed one.
  card = await show({ ...scanned, error: "storage scan interrupted or exceeded its bound" });
  expect(card).toContain("Storage scan failed: storage scan interrupted or exceeded its bound; showing the last completed total.");
  expect(card).toContain("2.0 KiB");
  // No failure: a scan still pending, then a completed one.
  card = await show(pending);
  expect(card).toContain("Scan pending");
  expect(card).not.toContain("scan failed");
  card = await show(scanned);
  expect(card).toContain("Scanned ");
  expect(card).not.toContain("scan failed");
  // The error is text, never markup.
  card = await show({ ...pending, error: "<b>boom</b>" });
  expect(card).toContain("Storage scan failed: <b>boom</b>.");
  expect(target.querySelector("b")).toBeNull();

  const pathError = "cannot scan /home/test/.chan/cache: permission denied";
  card = await show({ ...scanned, error: pathError });
  expect(card).toContain(pathError);
  privacy.enabled = true;
  await tick();
  expect(target.innerHTML).not.toContain("/home/test/.chan");
  expect(target.querySelector('[aria-label="storage scan error hidden"]')?.textContent).toBe("Hidden");
  expect(target.textContent).toContain("Storage scan failed:");
  expect(target.textContent).toContain("showing the last completed total.");
  privacy.enabled = false;
  await tick();
  expect(target.textContent).toContain(pathError);
});

