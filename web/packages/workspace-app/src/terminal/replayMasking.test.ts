// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from "vitest";

/// What the terminal's secret masker was asked to do.
const masker = vi.hoisted(() => ({ captures: 0, scans: 0, scanAlls: 0 }));

vi.mock("@xterm/xterm", async () => (await import("../__tests__/terminalTab")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/terminalTab")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/terminalTab")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/terminalTab")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/terminalTab")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/terminalTab")).webglAddonModule());
vi.mock("./secretMasking", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./secretMasking")>()),
  TerminalSecretMasker: class {
    setEnabled() {}
    setColor() {}
    captureWrite() {
      masker.captures += 1;
      return {};
    }
    scanWrite() {
      masker.scans += 1;
    }
    scanAll() {
      masker.scanAlls += 1;
    }
    clear() {}
    dispose() {}
  },
}));

import TerminalTab from "../components/TerminalTab.svelte";
import { ReplayMaskScanBatch } from "./replayMasking";
import {
  attach,
  installTerminalDom,
  mountTerminal,
  output,
  receive,
  resetTerminals,
  seatTerminals,
  terminalTab,
  TerminalSocket,
} from "../__tests__/terminalTab";

installTerminalDom();

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

describe("a mounted terminal's secret masking", () => {
  afterEach(() => {
    resetTerminals();
    Object.assign(masker, { captures: 0, scans: 0, scanAlls: 0 });
  });

  async function reattached() {
    const [tab] = seatTerminals([terminalTab({ terminalSessionId: "sess-1" })]);
    await mountTerminal(TerminalTab, tab!);
    const socket = TerminalSocket.all.at(-1)!;
    await attach(socket, { id: "sess-1" });
    return socket;
  }

  test("scans a replay once, when it ends, not write by write", async () => {
    const socket = await reattached();
    const before = masker.scanAlls;
    await output(socket, "export TOKEN=abc\r\n");
    await output(socket, "export KEY=def\r\n");
    expect(masker.scans, "no per-write scan during the replay").toBe(0);
    expect(masker.scanAlls).toBe(before);

    await receive(socket, { type: "ready", cols: 80, rows: 24 });
    expect(masker.scanAlls).toBe(before + 1);
  });

  test("scans live output write by write", async () => {
    const socket = await reattached();
    await receive(socket, { type: "ready", cols: 80, rows: 24 });
    await output(socket, "one\r\n");
    await output(socket, "two\r\n");
    expect([masker.captures, masker.scans]).toEqual([2, 2]);
  });
});
