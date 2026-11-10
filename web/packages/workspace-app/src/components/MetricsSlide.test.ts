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
    transfers: { queued: 0, running: 0, workerCapacity: 2, queueCapacity: 32, finished: 0, cancelled: 0, stalled: 0, panicked: 0, refused: 0 },
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
