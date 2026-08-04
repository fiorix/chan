import { describe, expect, test, vi } from "vitest";
import terminalTab from "../components/TerminalTab.svelte?raw";
import { ReplayMaskScanBatch } from "./replayMasking";

describe("attach replay secret-mask scans", () => {
  test("keeps live writes on the per-write capture and scan path", () => {
    const scans = new ReplayMaskScanBatch();
    const snapshot = Symbol("snapshot");
    const captureWrite = vi.fn(() => snapshot);
    const scanWrite = vi.fn();

    const complete = scans.track(false, captureWrite, scanWrite);

    expect(captureWrite).toHaveBeenCalledOnce();
    expect(scanWrite).not.toHaveBeenCalled();
    complete();
    complete();
    expect(scanWrite).toHaveBeenCalledOnce();
    expect(scanWrite).toHaveBeenCalledWith(snapshot);
  });

  test("skips per-write replay scans and scans all once after ready drains", () => {
    const scans = new ReplayMaskScanBatch();
    const captureWrite = vi.fn(() => Symbol("snapshot"));
    const scanWrite = vi.fn();
    const scanAll = vi.fn();

    scans.begin(scanAll);
    const completeFirst = scans.track(true, captureWrite, scanWrite);
    const completeLast = scans.track(true, captureWrite, scanWrite);

    expect(captureWrite).not.toHaveBeenCalled();
    completeFirst();
    scans.ready();
    expect(scanWrite).not.toHaveBeenCalled();
    expect(scanAll).not.toHaveBeenCalled();

    completeLast();
    completeLast();
    scans.ready();
    expect(scanWrite).not.toHaveBeenCalled();
    expect(scanAll).toHaveBeenCalledOnce();
  });

  test("scans once at ready when an attach has no replay writes", () => {
    const scans = new ReplayMaskScanBatch();
    const scanAll = vi.fn();

    scans.begin(scanAll);
    scans.ready();
    scans.ready();

    expect(scanAll).toHaveBeenCalledOnce();
  });

  test("leaves live writes byte-for-byte on their scan path while replay drains", () => {
    const scans = new ReplayMaskScanBatch();
    const scanAll = vi.fn();
    const replayComplete = (() => {
      scans.begin(scanAll);
      return scans.track(
        true,
        () => Symbol("unused replay snapshot"),
        () => {},
      );
    })();
    scans.ready();

    const liveSnapshot = Symbol("live snapshot");
    const captureLive = vi.fn(() => liveSnapshot);
    const scanLive = vi.fn();
    const liveComplete = scans.track(false, captureLive, scanLive);

    expect(captureLive).toHaveBeenCalledOnce();
    liveComplete();
    expect(scanLive).toHaveBeenCalledWith(liveSnapshot);
    expect(scanAll).not.toHaveBeenCalled();

    replayComplete();
    expect(scanAll).toHaveBeenCalledOnce();
  });

  test("a new attach supersedes callbacks from an abandoned replay", () => {
    const scans = new ReplayMaskScanBatch();
    const abandonedScanAll = vi.fn();
    const currentScanAll = vi.fn();

    scans.begin(abandonedScanAll);
    const abandonedComplete = scans.track(true, () => null, () => {});
    scans.begin(currentScanAll);
    scans.ready();
    expect(currentScanAll).not.toHaveBeenCalled();
    abandonedComplete();

    expect(abandonedScanAll).not.toHaveBeenCalled();
    expect(currentScanAll).toHaveBeenCalledOnce();
  });
});

describe("TerminalTab replay mask wiring", () => {
  test("batches attach-replay writes and closes the batch at ready", () => {
    expect(terminalTab).toContain(
      "const replayMaskScans = new ReplayMaskScanBatch();",
    );
    expect(terminalTab).toMatch(
      /frame\.type === "session"[\s\S]*?attachReplayActive = true;[\s\S]*?replayMaskScans\.begin\(\(\) => secretMasker\?\.scanAll\(\)\);/,
    );
    expect(terminalTab).toMatch(
      /frame\.type === "ready"[\s\S]*?attachReplayActive = false;[\s\S]*?replayMaskScans\.ready\(\);/,
    );
    expect(terminalTab).toMatch(
      /const completeMaskScan = replayMaskScans\.track\(\s*attachReplayActive,\s*\(\) => masker\?\.captureWrite\(\) \?\? null,\s*\(snapshot\) => masker\?\.scanWrite\(snapshot\),\s*\);[\s\S]*?ptyWrites\.write\(termWriter, bytes, origin, completeMaskScan\);/,
    );
  });
});
