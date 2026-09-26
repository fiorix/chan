// @vitest-environment jsdom
//
// How a terminal's session ends, as the window's saved session records it.
// A devserver shutdown is a restart the PTY outlives, so the blob keeps the
// session id and the reloaded window reattaches to the restored PTY; every
// other `closed` reason and a process exit drop it, and an explicit close
// deletes the blob with its tab. A TerminalTab is mounted over the stand-in
// xterm and attached on its socket; the assertions read the blobs the
// window writes and deletes.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/terminalTab")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/terminalTab")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/terminalTab")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/terminalTab")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/terminalTab")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/terminalTab")).webglAddonModule());

import TerminalTab from "./TerminalTab.svelte";
import { api } from "../api/client";
import { __testReadLayoutReloadSnapshot } from "../state/store.svelte";
import {
  attach,
  installTerminalDom,
  mountTerminal,
  receive,
  resetTerminals,
  seatTerminals,
  terminalTab,
  TerminalSocket,
} from "../__tests__/terminalTab";

installTerminalDom();

// Past the terminal's one-second save throttle and the store's debounce.
const SETTLE_MS = 5_000;

/// Every write of the window's blob, in order: the payload put, or null
/// for a delete.
let writes: unknown[] = [];
let sessions = 0;

beforeEach(() => {
  vi.useFakeTimers();
  writes = [];
  vi.spyOn(api, "putSession").mockImplementation(async (body: unknown) => {
    writes.push(body);
  });
  vi.spyOn(api, "deleteSession").mockImplementation(async () => {
    writes.push(null);
  });
});

afterEach(() => {
  // Before resetTerminals, which puts back the requestAnimationFrame
  // stand-in that uninstalling the fake clock removes.
  vi.useRealTimers();
  resetTerminals();
  vi.restoreAllMocks();
});

/// The terminal session ids a serialized layout carries.
function tsids(node: unknown): string[] {
  if (!node || typeof node !== "object") return [];
  const tsid = (node as { tsid?: unknown }).tsid;
  return [...(typeof tsid === "string" ? [tsid] : []), ...Object.values(node).flatMap(tsids)];
}

/// What the window's blob holds after its last write.
function persisted(): string[] | "deleted" {
  expect(writes.length, "the window wrote its blob").toBeGreaterThan(0);
  const last = writes.at(-1);
  return last === null ? "deleted" : tsids(last);
}

/// Mount a terminal attached to a session of its own and let the save the
/// attach schedules land. A fresh id per test keeps the store's on-disk
/// dedupe from swallowing the write.
async function attachedSession(): Promise<{ id: string; socket: TerminalSocket }> {
  const id = `sess-end-${++sessions}`;
  const [tab] = seatTerminals([terminalTab()]);
  await mountTerminal(TerminalTab, tab!);
  const socket = TerminalSocket.all.at(-1)!;
  await attach(socket, { id, generation: 1, seq: 0 });
  await vi.advanceTimersByTimeAsync(SETTLE_MS);
  expect(persisted(), "the blob after the attach").toEqual([id]);
  return { id, socket };
}

describe("a devserver shutdown", () => {
  test("keeps the session id in the window's blob and its reload snapshot", async () => {
    const { id, socket } = await attachedSession();
    await receive(socket, { type: "closed", reason: "shutdown" });
    await vi.advanceTimersByTimeAsync(SETTLE_MS);

    expect(persisted(), "the blob a reload reads").toEqual([id]);
    expect(tsids(__testReadLayoutReloadSnapshot()), "the same-tab reload snapshot").toEqual([id]);
  });
});

describe("every other end drops the session id", () => {
  for (const reason of ["idle", "workspace", "capped", "error"]) {
    test(`closed (${reason})`, async () => {
      const { socket } = await attachedSession();
      await receive(socket, { type: "closed", reason });
      await vi.advanceTimersByTimeAsync(SETTLE_MS);

      expect(persisted()).toEqual([]);
    });
  }

  test("closed (explicit) deletes the blob with the tab", async () => {
    const { socket } = await attachedSession();
    await receive(socket, { type: "closed", reason: "explicit" });
    await vi.advanceTimersByTimeAsync(SETTLE_MS);

    expect(persisted()).toBe("deleted");
  });

  test("exit", async () => {
    const { socket } = await attachedSession();
    await receive(socket, { type: "exit", code: 0 });
    await vi.advanceTimersByTimeAsync(SETTLE_MS);

    expect(persisted()).toEqual([]);
  });
});
