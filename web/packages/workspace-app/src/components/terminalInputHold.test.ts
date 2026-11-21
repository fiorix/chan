import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  createTerminalInputHold,
  TERMINAL_HOLD_MAX_CHARS,
  TERMINAL_HOLD_MAX_FRAMES,
  type HeldInput,
} from "./terminalInputHold";

const CAP_MS = 10_000;

function entry(data: string, extra: Partial<HeldInput> = {}): HeldInput {
  return { frame: { type: "input", data }, size: data.length, countsAsInput: true, ...extra };
}

function holdWith(open = true) {
  const state = { open, sent: [] as string[], dropped: 0 };
  const hold = createTerminalInputHold({
    canSend: () => state.open,
    deliver: (item) => { state.sent.push(item.frame.data as string); },
    onDropped: () => { state.dropped += 1; },
  });
  return { hold, state };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the terminal input hold", () => {
  test("takes nothing while it is not running", () => {
    const { hold, state } = holdWith();
    expect(hold.offer(entry("a"))).toBe(false);
    expect(hold.interrupt(entry("b"))).toBe(false);
    expect(state.sent).toEqual([]);
  });

  test("a release delivers what it held once and in order", () => {
    const { hold, state } = holdWith();
    hold.begin(CAP_MS);
    hold.offer(entry("a"));
    hold.offer(entry("b"));
    expect(state.sent).toEqual([]);

    hold.release();
    hold.release();
    expect(state.sent).toEqual(["a", "b"]);
    expect(hold.active).toBe(false);
  });

  test("an interrupt goes now behind what was held, and the hold goes on", () => {
    const { hold, state } = holdWith();
    hold.begin(CAP_MS);
    hold.offer(entry("a"));
    hold.interrupt(entry("^C"));
    expect(state.sent).toEqual(["a", "^C"]);
    expect(hold.active).toBe(true);

    hold.offer(entry("b"));
    expect(state.sent).toEqual(["a", "^C"]);
    hold.release();
    expect(state.sent).toEqual(["a", "^C", "b"]);
  });

  test("an interrupt with no socket open keeps its place in the queue", () => {
    const { hold, state } = holdWith(false);
    hold.begin(CAP_MS);
    hold.offer(entry("a"));
    hold.interrupt(entry("^C"));
    hold.offer(entry("b"));
    expect(state.sent).toEqual([]);

    state.open = true;
    hold.release();
    expect(state.sent).toEqual(["a", "^C", "b"]);
  });

  test("the cap lets go to an open socket", () => {
    const { hold, state } = holdWith();
    hold.begin(CAP_MS);
    hold.offer(entry("a"));

    vi.advanceTimersByTime(CAP_MS);
    expect(state.sent).toEqual(["a"]);
    expect(state.dropped).toBe(0);
    expect(hold.active).toBe(false);
  });

  test("the cap with no socket open reports the loss", () => {
    const { hold, state } = holdWith(false);
    hold.begin(CAP_MS);
    hold.offer(entry("a"));

    vi.advanceTimersByTime(CAP_MS);
    expect(state.sent).toEqual([]);
    expect(state.dropped).toBe(1);
    expect(hold.active).toBe(false);
  });

  test("a repeated wake does not extend the cap", () => {
    const { hold, state } = holdWith();
    hold.begin(CAP_MS);
    hold.offer(entry("a"));
    vi.advanceTimersByTime(CAP_MS - 1);
    hold.begin(CAP_MS);
    vi.advanceTimersByTime(1);
    expect(state.sent).toEqual(["a"]);
  });

  test("a replacement gets its own time to connect", () => {
    const { hold, state } = holdWith(false);
    hold.begin(CAP_MS);
    hold.offer(entry("a"));
    vi.advanceTimersByTime(CAP_MS - 1);
    hold.awaitReplacement(CAP_MS);
    vi.advanceTimersByTime(CAP_MS - 1);
    expect(state.dropped).toBe(0);

    state.open = true;
    hold.release();
    expect(state.sent).toEqual(["a"]);
  });

  test("failed redials do not move the replacement's window", () => {
    const { hold, state } = holdWith(false);
    hold.begin(CAP_MS);
    hold.offer(entry("a"));
    hold.awaitReplacement(CAP_MS);
    for (let i = 0; i < 9; i += 1) {
      vi.advanceTimersByTime(1_000);
      hold.awaitReplacement(CAP_MS);
    }
    vi.advanceTimersByTime(1_000);
    expect(state.dropped).toBe(1);
    expect(hold.active).toBe(false);
    state.open = true;
    hold.release();
    expect(state.sent).toEqual([]);
  });

  test("a replacement that reads open has proven nothing until its session", () => {
    const { hold, state } = holdWith();
    hold.begin(CAP_MS);
    hold.offer(entry("a"));
    hold.awaitReplacement(CAP_MS);

    hold.interrupt(entry("^C"));
    expect(state.sent, "the interrupt keeps its place").toEqual([]);
    hold.release();
    expect(state.sent).toEqual(["a", "^C"]);
  });

  test("a replacement's window ends in a drop even on an open socket", () => {
    const { hold, state } = holdWith();
    hold.begin(CAP_MS);
    hold.offer(entry("a"));
    hold.awaitReplacement(CAP_MS);
    vi.advanceTimersByTime(CAP_MS);
    expect(state.sent).toEqual([]);
    expect(state.dropped).toBe(1);
  });

  test("once a replacement has proven its session, an interrupt goes at once", () => {
    const { hold, state } = holdWith();
    hold.begin(CAP_MS);
    hold.offer(entry("a"));
    hold.awaitReplacement(CAP_MS);
    hold.replacementProven();
    hold.interrupt(entry("^C"));
    expect(state.sent).toEqual(["a", "^C"]);
    expect(hold.active).toBe(true);
  });

  test("the cap waits for a probe that is counting down to its verdict", () => {
    const pending = { value: true };
    const sent: string[] = [];
    const hold = createTerminalInputHold({
      canSend: () => true,
      deliver: (item) => { sent.push(item.frame.data as string); },
      onDropped: () => {},
      verdictPending: () => pending.value,
    });
    hold.begin(CAP_MS);
    hold.offer(entry("a"));
    vi.advanceTimersByTime(CAP_MS + 2_000);
    expect(sent, "the verdict decides where the key goes").toEqual([]);
    expect(hold.active).toBe(true);

    // Frames came back: the socket is delivering and the cap applies.
    pending.value = false;
    vi.advanceTimersByTime(1_000);
    expect(sent).toEqual(["a"]);
    expect(hold.active).toBe(false);
  });

  test.each([
    ["frames", () => Array.from({ length: TERMINAL_HOLD_MAX_FRAMES + 1 }, () => entry("x"))],
    ["characters", () => [entry("x".repeat(TERMINAL_HOLD_MAX_CHARS + 1))]],
  ])("past its bound in %s it lets everything go in order", async (_label, items) => {
    const { hold, state } = holdWith();
    hold.begin(CAP_MS);
    const list = items();
    for (const item of list) hold.offer(item);
    expect(state.sent).toEqual([]);

    await Promise.resolve();
    expect(state.sent).toHaveLength(list.length);
    expect(state.dropped).toBe(0);
    expect(hold.active).toBe(false);
  });

  test("abandoning typed input reports it, and mouse reports alone do not", () => {
    const typed = holdWith();
    typed.hold.begin(CAP_MS);
    typed.hold.offer(entry("a"));
    typed.hold.abandon();
    expect(typed.state.dropped).toBe(1);

    const mouse = holdWith();
    mouse.hold.begin(CAP_MS);
    mouse.hold.offer(entry("m", { countsAsInput: false }));
    mouse.hold.abandon();
    expect(mouse.state.dropped).toBe(0);
    expect(mouse.state.sent).toEqual([]);
  });

  test("a recalled prompt leaves the queue and the rest keep their order", () => {
    const { hold, state } = holdWith();
    hold.begin(CAP_MS);
    hold.offer(entry("a"));
    hold.offer(entry("prompt", { promptId: "p1" }));
    hold.offer(entry("b"));

    expect(hold.remove("p1")).toBe(true);
    expect(hold.remove("p1")).toBe(false);
    hold.release();
    expect(state.sent).toEqual(["a", "b"]);
  });
});
