// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("../terminal/backend", async (importOriginal) =>
  (await import("../__tests__/ghosttyTab")).ghosttyBackendModule(importOriginal));

import TerminalTab from "../components/TerminalTab.svelte";
import { GhosttySecretMasker } from "./secretMaskingGhostty";
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
  test("scans all once, after ready and the last replay write", () => {
    const scans = new ReplayMaskScanBatch();
    const scanAll = vi.fn();

    scans.begin(scanAll);
    const completeFirst = scans.track(true);
    const completeLast = scans.track(true);

    completeFirst();
    scans.ready();
    expect(scanAll).not.toHaveBeenCalled();

    completeLast();
    completeLast();
    scans.ready();
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

  test("a live write while a replay drains neither holds nor runs its scan", () => {
    const scans = new ReplayMaskScanBatch();
    const scanAll = vi.fn();
    scans.begin(scanAll);
    const replayComplete = scans.track(true);
    scans.ready();
    const liveComplete = scans.track(false);

    replayComplete();
    expect(scanAll, "the live write still parsing does not hold the scan").toHaveBeenCalledOnce();
    liveComplete();
    expect(scanAll, "and its end runs no second one").toHaveBeenCalledOnce();
  });

  test("a new attach supersedes callbacks from an abandoned replay", () => {
    const scans = new ReplayMaskScanBatch();
    const abandonedScanAll = vi.fn();
    const currentScanAll = vi.fn();

    scans.begin(abandonedScanAll);
    const abandonedComplete = scans.track(true);
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
    vi.restoreAllMocks();
  });

  async function reattached() {
    const [tab] = seatTerminals([terminalTab({ terminalSessionId: "sess-1" })]);
    await mountTerminal(TerminalTab, tab!);
    const socket = TerminalSocket.all.at(-1)!;
    await attach(socket, { id: "sess-1" });
    return socket;
  }

  test("scans a replay once, when it ends, not write by write", async () => {
    const scanAlls = vi.spyOn(GhosttySecretMasker.prototype, "scanAll");
    const socket = await reattached();
    const before = scanAlls.mock.calls.length;
    await output(socket, "export TOKEN=abc\r\n");
    await output(socket, "export KEY=def\r\n");
    expect(scanAlls, "no scan during the replay").toHaveBeenCalledTimes(before);

    await receive(socket, { type: "ready", cols: 80, rows: 24 });
    expect(scanAlls).toHaveBeenCalledTimes(before + 1);
  });
});
