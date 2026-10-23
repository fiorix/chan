// @vitest-environment jsdom

// The session save path with every write held for the test to answer or fail.
// The stored blob changes only when a write is answered, so the order the test
// answers in is the order the server stores in.

import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock("./caretIndex");

const socket = vi.hoisted(() => ({ ready: null as (() => void) | null }));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    openWatchSocket: (_onEvent: unknown, _onStatus: unknown, onReady?: () => void) => {
      socket.ready = onReady ?? null;
      return Object.assign(() => {}, {
        subscribeDir() {},
        unsubscribeDir() {},
        reportTransfers() {},
      });
    },
  };
});

let client: typeof import("../api/client");
let store: typeof import("./store.svelte");
let tabs: typeof import("./tabs.svelte");
let fixtures: typeof import("../__tests__/tabs");

const W = "window-session-saves";

let stored: unknown = null;
let writes: { payload: unknown; answer: () => void; fail: (reason?: string) => void }[] = [];
let reads = 0;

function holdWrites(): void {
  vi.spyOn(client.api, "putSession").mockImplementation((payload) =>
    new Promise<void>((resolve, reject) => {
      writes.push({
        payload,
        answer: () => {
          stored = structuredClone(payload);
          resolve();
        },
        fail: (reason = "disk full") => reject(new Error(reason)),
      });
    }),
  );
  vi.spyOn(client.api, "getSession").mockImplementation(async () => {
    reads += 1;
    return structuredClone(stored);
  });
}

/// The DELETEs sent with `keepalive`: a discard's, outside the write chain.
function spyDiscards() {
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(null, { status: 204 }));
  return () => fetchSpy.mock.calls.filter(([, init]) => init?.method === "DELETE");
}

function peerFrame(): void {
  store.onWatchEvent({ kind: "session_changed", w: W, client: "peer" });
}

function pageHasTerminal(sessionId: string): boolean {
  return tabs.activePane().tabs.some((t) => t.kind === "terminal" && t.terminalSessionId === sessionId);
}

function storedHasTerminal(sessionId: string): boolean {
  return JSON.stringify(stored ?? null).includes(`"tsid":"${sessionId}"`);
}

function colorOf(payload: unknown): string | undefined {
  return (payload as { layout?: { wc?: string } } | null)?.layout?.wc;
}

async function save(): Promise<void> {
  store.scheduleSessionSave();
  await vi.advanceTimersByTimeAsync(750);
}

/// A failed write, settled.
async function fail(n: number, reason?: string): Promise<void> {
  writes[n]!.fail(reason);
  await vi.advanceTimersByTimeAsync(0);
}

/// A terminal and a file tab, saved and stored.
async function savedTerminal() {
  const terminal = fixtures.terminalTab({ id: "term-1", terminalSessionId: "s-1" });
  const pane = fixtures.resetLayout([terminal, fixtures.fileTab()], { id: "pane-saves" });
  holdWrites();
  await save();
  writes[0]!.answer();
  await vi.advanceTimersByTimeAsync(0);
  return { terminal, pane };
}

async function closeLocally(pane: { id: string }, terminal: { id: string }): Promise<void> {
  await tabs.closeTab(pane.id, terminal.id, { force: true });
  store.scheduleSessionSave();
}

beforeEach(async () => {
  vi.resetModules();
  window.history.replaceState({}, "", `/?w=${W}`);
  client = await import("../api/client");
  store = await import("./store.svelte");
  tabs = await import("./tabs.svelte");
  fixtures = await import("../__tests__/tabs");
  vi.spyOn(client.api, "terminalRoster").mockResolvedValue([]);
  vi.spyOn(client.api, "health").mockResolvedValue({ instance: "a" } as never);
  vi.spyOn(client.api, "extensions").mockResolvedValue([]);
  vi.spyOn(client.api, "list").mockResolvedValue([]);
  fixtures.resetLayout([fixtures.fileTab()], { id: "pane-saves" });
  stored = null;
  writes = [];
  reads = 0;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  store.resumeWatcher();
});

afterEach(async () => {
  store.discardWindowSessionLocal();
  for (const write of writes) write.answer();
  await vi.runOnlyPendingTimersAsync();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test("a save waits for the save in flight and the server ends with the newer", async () => {
  holdWrites();
  tabs.layout.focusColor = "green";
  await save();
  tabs.layout.focusColor = "blue";
  await save();

  expect(writes, "one save in flight at a time").toHaveLength(1);

  writes[0]!.answer();
  await vi.advanceTimersByTimeAsync(0);
  expect(writes, "the waiting save goes out once the first lands").toHaveLength(2);
  writes[1]!.answer();
  await vi.advanceTimersByTimeAsync(0);
  expect(colorOf(stored), "the server ends with the newer layout").toBe("b");
});

test("three saves during one write give one follow-up carrying the latest", async () => {
  holdWrites();
  await save();
  for (const color of ["green", "orange", "pink"] as const) {
    tabs.layout.focusColor = color;
    await save();
  }
  expect(writes).toHaveLength(1);

  writes[0]!.answer();
  await vi.advanceTimersByTimeAsync(0);
  writes[1]?.answer();
  await vi.advanceTimersByTimeAsync(5_000);

  expect(writes, "one follow-up").toHaveLength(2);
  expect(colorOf(writes[1]!.payload), "it carries the latest layout").toBe("p");
});

test("a layout changed and back while its save is out is not sent again", async () => {
  holdWrites();
  await save();
  tabs.layout.focusColor = "green";
  await save();
  tabs.layout.focusColor = "blue";
  await save();

  writes[0]!.answer();
  await vi.advanceTimersByTimeAsync(5_000);

  expect(writes, "the waiting save finds the server holding the layout").toHaveLength(1);
});

test("a failed save is sent again by its retry although the layout has not changed", async () => {
  holdWrites();
  tabs.layout.focusColor = "green";
  await save();
  await fail(0);

  await save();
  expect(writes, "a save during the back-off waits for the retry").toHaveLength(1);
  await vi.advanceTimersByTimeAsync(250);

  expect(writes, "the retry sends the failed layout again").toHaveLength(2);
  expect(colorOf(writes[1]!.payload)).toBe("g");
  writes[1]!.answer();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(colorOf(stored)).toBe("g");
  expect(writes, "a stored layout is not retried").toHaveLength(2);
});

test("a flushed save that failed is retried and the server ends without the closed terminal", async () => {
  const { terminal, pane } = await savedTerminal();
  peerFrame();
  await vi.advanceTimersByTimeAsync(160);
  await closeLocally(pane, terminal);
  await vi.advanceTimersByTimeAsync(90);
  expect(writes, "the read flushes the close").toHaveLength(2);
  await fail(1);

  await vi.advanceTimersByTimeAsync(1_000);

  expect(writes, "the retry sends the close again").toHaveLength(3);
  writes[2]!.answer();
  await vi.advanceTimersByTimeAsync(0);
  expect(storedHasTerminal("s-1"), "the server holds the close").toBe(false);
  expect(pageHasTerminal("s-1")).toBe(false);
});

test("a save queued behind a write that fails waits for the back-off, then the retry carries the latest", async () => {
  holdWrites();
  await save();
  tabs.layout.focusColor = "green";
  await save();
  await fail(0);

  await vi.advanceTimersByTimeAsync(999);
  expect(writes, "nothing before the back-off elapses").toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);

  expect(writes, "one retry").toHaveLength(2);
  expect(colorOf(writes[1]!.payload), "with the latest layout").toBe("g");
});

test("the back-off doubles from one second, stops at thirty, and a success resets it", async () => {
  holdWrites();
  await save();
  let failed = 0;
  // The retry after the nth failure in a row: 1, 2, 4, 8, 16 s, then 30.
  for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
    await fail(failed);
    failed += 1;
    await vi.advanceTimersByTimeAsync(delay - 1);
    expect(writes, `no retry 1 ms before ${delay} ms`).toHaveLength(failed);
    await vi.advanceTimersByTimeAsync(1);
    expect(writes, `the retry at ${delay} ms`).toHaveLength(failed + 1);
  }
  writes[failed]!.answer();
  await vi.advanceTimersByTimeAsync(0);
  tabs.layout.focusColor = "green";
  await save();
  await fail(failed + 1);
  await vi.advanceTimersByTimeAsync(999);
  expect(writes, "a success resets the back-off").toHaveLength(failed + 2);
  await vi.advanceTimersByTimeAsync(1);
  expect(writes).toHaveLength(failed + 3);
});

test("two failed saves in a row report the unsaved layout and a later success clears it", async () => {
  holdWrites();
  await save();
  await fail(0);
  expect(store.ui.status ?? "", "one failure is retried without a report").not.toContain("layout not saved");
  await vi.advanceTimersByTimeAsync(1_000);
  await fail(1);

  expect(store.ui.status, "the second failure is reported").toBe("layout not saved: disk full");
  expect(store.ui.statusKind).toBe("persistent");

  await vi.advanceTimersByTimeAsync(2_000);
  writes[2]!.answer();
  await vi.advanceTimersByTimeAsync(0);
  expect(store.ui.status, "a success clears the report").toBeNull();
});

test("a status set after the report survives the success", async () => {
  holdWrites();
  await save();
  await fail(0);
  await vi.advanceTimersByTimeAsync(1_000);
  await fail(1);
  store.ui.status = "files context failed: gone";
  store.ui.statusKind = "persistent";

  await vi.advanceTimersByTimeAsync(2_000);
  writes[2]!.answer();
  await vi.advanceTimersByTimeAsync(0);

  expect(store.ui.status).toBe("files context failed: gone");
  expect(store.ui.statusKind).toBe("persistent");
});

test("a status set after the report survives a later failure and the success", async () => {
  holdWrites();
  await save();
  await fail(0);
  await vi.advanceTimersByTimeAsync(1_000);
  await fail(1);
  store.ui.status = "files context failed: gone";
  store.ui.statusKind = "persistent";

  await vi.advanceTimersByTimeAsync(2_000);
  await fail(2);
  expect(store.ui.status, "after the third failure").toBe("files context failed: gone");
  await vi.advanceTimersByTimeAsync(4_000);
  writes[3]!.answer();
  await vi.advanceTimersByTimeAsync(0);
  expect(store.ui.status, "after the success").toBe("files context failed: gone");
});

test("a later failure updates the report while it shows", async () => {
  holdWrites();
  await save();
  await fail(0);
  await vi.advanceTimersByTimeAsync(1_000);
  await fail(1);
  await vi.advanceTimersByTimeAsync(2_000);
  await fail(2, "read-only file system");

  expect(store.ui.status).toBe("layout not saved: read-only file system");
});

test("a seed during the back-off ends the series", async () => {
  holdWrites();
  await save();
  await fail(0);
  await vi.advanceTimersByTimeAsync(1_000);
  await fail(1);
  expect(store.ui.status, "setup: reported").toBe("layout not saved: disk full");

  // A peer's DELETE seeds the layout this window holds.
  store.onWatchEvent({ kind: "session_changed", w: W, client: "peer", deleted: true });
  expect(store.ui.status, "a seeded layout has nothing owed").toBeNull();
  await vi.advanceTimersByTimeAsync(2_000);
  expect(writes, "the retry finds the layout held").toHaveLength(2);

  tabs.layout.focusColor = "green";
  await save();
  await fail(2);
  expect(store.ui.status ?? "", "the next failure is the first of its series").not.toContain("layout not saved");
  await vi.advanceTimersByTimeAsync(999);
  expect(writes, "with the first back-off").toHaveLength(3);
  await vi.advanceTimersByTimeAsync(1);
  expect(writes).toHaveLength(4);
});

test("an apply that leaves the window owing its layout keeps the series open", async () => {
  const dirty = fixtures.fileTab({ id: "file-dirty", path: "notes/dirty.md", content: "edited" });
  fixtures.resetLayout([fixtures.terminalTab({ id: "term-1", terminalSessionId: "s-1" }), dirty], { id: "pane-saves" });
  holdWrites();
  await save();
  await fail(0);
  await vi.advanceTimersByTimeAsync(1_000);
  await fail(1);
  expect(store.ui.status, "setup: reported").toBe("layout not saved: disk full");

  // Hybrid Nav reads during the back-off; the peer's blob lacks the dirty
  // tab, which the apply at the end of Hybrid Nav keeps for the server.
  stored = { layout: { k: "l", t: [{ k: "t", n: "Terminal", tsid: "s-1" }] } };
  tabs.enterPaneMode();
  peerFrame();
  await vi.advanceTimersByTimeAsync(250);
  expect(reads, "setup: the read goes out").toBe(1);
  tabs.cancelPaneMode();

  expect(tabs.activePane().tabs.some((t) => t.id === "file-dirty"), "setup: the dirty tab is kept").toBe(true);
  expect(store.ui.status, "the kept layout is still owed").toBe("layout not saved: disk full");
});

test("a peer frame during a save in flight reads the blob only after the save lands", async () => {
  const { terminal, pane } = await savedTerminal();
  await closeLocally(pane, terminal);
  await vi.advanceTimersByTimeAsync(750);
  expect(writes, "the debounce sends the close").toHaveLength(2);

  peerFrame();
  await vi.advanceTimersByTimeAsync(250);
  expect(pageHasTerminal("s-1"), "the older blob does not bring the closed terminal back").toBe(false);
  expect(reads, "the read waits for the save in flight").toBe(0);

  writes[1]!.answer();
  await vi.advanceTimersByTimeAsync(500);
  expect(reads).toBe(1);
  expect(pageHasTerminal("s-1")).toBe(false);
});

test("a peer frame in Hybrid Nav during a save in flight reads the blob only after the save lands", async () => {
  const { terminal, pane } = await savedTerminal();
  await closeLocally(pane, terminal);
  await vi.advanceTimersByTimeAsync(750);
  expect(writes, "setup: the debounce sends the close").toHaveLength(2);
  tabs.enterPaneMode();

  peerFrame();
  await vi.advanceTimersByTimeAsync(250);
  expect(reads, "the read waits for the save in flight").toBe(0);

  writes[1]!.answer();
  await vi.advanceTimersByTimeAsync(500);
  expect(reads).toBe(1);
  tabs.cancelPaneMode();
});

test("a second peer frame during the read's flush waits for that flush", async () => {
  const { terminal, pane } = await savedTerminal();
  peerFrame();
  await vi.advanceTimersByTimeAsync(160);
  await closeLocally(pane, terminal);
  await vi.advanceTimersByTimeAsync(90);
  expect(writes, "the read flushes the close").toHaveLength(2);

  peerFrame();
  await vi.advanceTimersByTimeAsync(250);
  expect(pageHasTerminal("s-1"), "the older blob does not bring the closed terminal back").toBe(false);
  expect(reads, "the second frame's read waits for the flush").toBe(0);

  writes[1]!.answer();
  await vi.advanceTimersByTimeAsync(500);
  expect(pageHasTerminal("s-1")).toBe(false);
});

test("a pending save with nothing to send does not delay the read", async () => {
  await savedTerminal();
  store.scheduleSessionSave();
  peerFrame();

  await vi.advanceTimersByTimeAsync(250);

  expect(reads, "the read goes out at once").toBe(1);
  expect(writes, "nothing new is sent").toHaveLength(1);
});

test("a read while a retry is armed sends the retry at once and its failure counts", async () => {
  holdWrites();
  await save();
  await fail(0);
  peerFrame();

  await vi.advanceTimersByTimeAsync(250);
  expect(writes, "the read sends the retry before its back-off").toHaveLength(2);
  expect(reads, "and waits for it").toBe(0);
  await fail(1);

  expect(store.ui.status, "the early retry's failure is the second in a row").toBe("layout not saved: disk full");
  expect(reads, "a failed retry leaves the read owed").toBe(0);
});

test("a read answered after a local save started is not applied", async () => {
  await savedTerminal();
  vi.spyOn(client.api, "getSession").mockImplementationOnce(() => {
    reads += 1;
    // A peer's layout with one more file tab.
    return Promise.resolve({ layout: { k: "l", t: [{ k: "t", n: "Terminal", tsid: "s-1" }, { p: "notes/a.md" }, { p: "notes/peer.md" }] } }).then(
      (blob) => new Promise((resolve) => setTimeout(() => resolve(blob), 1_000)),
    );
  });
  peerFrame();
  await vi.advanceTimersByTimeAsync(250);
  expect(reads, "setup: the read is out").toBe(1);
  // Changed and changed back while the read is out: the layout is as it was
  // when the GET went out, but a write of the change has started.
  tabs.layout.focusColor = "green";
  await save();
  tabs.layout.focusColor = "blue";
  store.scheduleSessionSave();
  expect(writes, "setup: the change is sent while the read is out").toHaveLength(2);

  await vi.advanceTimersByTimeAsync(250);

  const files = () => tabs.activePane().tabs.filter((t) => t.kind === "file").length;
  expect(files(), "the blob answered after the write started is not applied").toBe(1);
});

test("a read answered after a local save started and landed is not applied", async () => {
  await savedTerminal();
  vi.spyOn(client.api, "getSession").mockImplementationOnce(() => {
    reads += 1;
    return Promise.resolve({ layout: { k: "l", t: [{ k: "t", n: "Terminal", tsid: "s-1" }, { p: "notes/a.md" }, { p: "notes/peer.md" }] } }).then(
      (blob) => new Promise((resolve) => setTimeout(() => resolve(blob), 1_000)),
    );
  });
  peerFrame();
  await vi.advanceTimersByTimeAsync(250);
  expect(reads, "setup: the read is out").toBe(1);
  tabs.layout.focusColor = "green";
  await save();
  tabs.layout.focusColor = "blue";
  store.scheduleSessionSave();
  expect(writes, "setup: the change is sent while the read is out").toHaveLength(2);
  // The write lands before the read answers: no write is out, and the layout
  // is as it was when the GET went out.
  writes[1]!.answer();
  await vi.advanceTimersByTimeAsync(0);

  await vi.advanceTimersByTimeAsync(250);

  const files = () => tabs.activePane().tabs.filter((t) => t.kind === "file").length;
  expect(files(), "the blob answered after the write started and landed is not applied").toBe(1);
});

test("a read answered after a local change, before its save, is not applied", async () => {
  const { terminal, pane } = await savedTerminal();
  // A peer's layout taken before the close: it holds the terminal and one
  // more file tab, so it is no echo of this window's own save.
  const peerBlob = structuredClone(stored) as { layout: { t: unknown[] } };
  peerBlob.layout.t.push({ p: "notes/peer.md" });
  let answerRead!: () => void;
  vi.spyOn(client.api, "getSession").mockImplementationOnce(() => {
    reads += 1;
    return new Promise((resolve) => {
      answerRead = () => resolve(peerBlob);
    });
  });
  peerFrame();
  await vi.advanceTimersByTimeAsync(250);
  expect(reads, "setup: the read is out").toBe(1);
  await closeLocally(pane, terminal);

  answerRead();
  await vi.advanceTimersByTimeAsync(0);

  expect(pageHasTerminal("s-1"), "the read taken before the close does not bring it back").toBe(false);
  expect(writes, "setup: the close is not sent yet").toHaveLength(1);
});

test("a peer frame taken while a save fails is read once the retry lands", async () => {
  const { terminal, pane } = await savedTerminal();
  peerFrame();
  await vi.advanceTimersByTimeAsync(160);
  await closeLocally(pane, terminal);
  await vi.advanceTimersByTimeAsync(90);
  await fail(1);
  await vi.advanceTimersByTimeAsync(500);
  expect(reads, "no read while the close is unsaved").toBe(0);

  await vi.advanceTimersByTimeAsync(500);
  expect(writes, "setup: the retry is sent").toHaveLength(3);
  writes[2]!.answer();
  await vi.advanceTimersByTimeAsync(250);

  expect(reads, "the frame's read follows the retry").toBe(1);
  expect(pageHasTerminal("s-1")).toBe(false);
});

test("a discard while a save waits behind a write sends nothing after the discard", async () => {
  holdWrites();
  const discards = spyDiscards();
  await save();
  tabs.layout.focusColor = "green";
  await save();

  store.discardWindowSessionLocal();
  writes[0]!.answer();
  await vi.advanceTimersByTimeAsync(60_000);

  expect(writes, "the waiting save is dropped").toHaveLength(1);
  expect(discards()).toHaveLength(0);
});

test("a discard while a retry is armed sends nothing after the discard", async () => {
  holdWrites();
  const discards = spyDiscards();
  await save();
  await fail(0);

  store.discardWindowSessionLocal();
  await vi.advanceTimersByTimeAsync(60_000);

  expect(writes, "the retry sends no PUT").toHaveLength(1);
  expect(discards(), "nor a DELETE").toHaveLength(0);
});

test("a discard during a write sends its DELETE again once the write settles", async () => {
  holdWrites();
  const discards = spyDiscards();
  await save();

  const discarded = store.discardWindowSession({ reap: false, movedSession: "s-9" });
  await vi.advanceTimersByTimeAsync(0);
  expect(discards(), "the DELETE goes at once").toHaveLength(1);
  writes[0]!.answer();
  await discarded;

  const sent = discards();
  expect(sent, "and again after the write that could have written the blob back").toHaveLength(2);
  expect(String(sent[1]![0])).toContain("&moved=1&session=s-9");
  expect(writes).toHaveLength(1);
});

test("a discard with no write in flight sends one DELETE", async () => {
  holdWrites();
  const discards = spyDiscards();
  await save();
  writes[0]!.answer();
  await vi.advanceTimersByTimeAsync(0);

  await store.discardWindowSession();

  expect(discards()).toHaveLength(1);
});
