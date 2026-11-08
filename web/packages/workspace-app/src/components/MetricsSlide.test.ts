// @vitest-environment jsdom
import { mount, tick, unmount } from "svelte";
import { afterEach, expect, test, vi } from "vitest";
import { api } from "../api/client";
import { metrics } from "../state/metrics.svelte";
import type { MetricsView } from "../api/metrics";
import MetricsSlide from "./MetricsSlide.svelte";

let mounted: ReturnType<typeof mount> | undefined;
afterEach(async () => {
  if (mounted) await unmount(mounted);
  mounted = undefined;
  vi.restoreAllMocks(); vi.useRealTimers();
  metrics.view = null; metrics.samples = []; metrics.error = null;
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
