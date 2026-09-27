// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import type { DeckConfirm, DeckItem } from "../command-deck/model";
import { deckReturnFocus } from "./CommandDeck.svelte";
import CommandDeckHarness from "./CommandDeck.test-harness.svelte";

Element.prototype.scrollIntoView = vi.fn();

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const confirmation = (message: string): DeckConfirm => ({
  title: "Close window?",
  message,
  actionLabel: "Close",
  danger: true,
});

function item(confirm: DeckItem["confirm"]): DeckItem {
  return {
    id: "close",
    title: "Close",
    breadcrumb: "Windows",
    searchText: "close",
    scope: "window",
    awaitResult: true,
    confirm,
  };
}

async function flush(): Promise<void> {
  for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
  await tick();
}

let target: HTMLElement;
let app: Record<string, unknown>;

beforeEach(() => {
  target = document.createElement("div");
  document.body.appendChild(target);
});

afterEach(() => {
  unmount(app);
  target.remove();
});

function mountDeck(
  entry: DeckItem,
  onChoose?: (item: DeckItem) => void | DeckConfirm | Promise<void | DeckConfirm>,
): void {
  app = mount(CommandDeckHarness, {
    target,
    props: { items: [entry], onChoose },
  }) as Record<string, unknown>;
}

function closeResult(): HTMLButtonElement {
  return target.querySelector("button.deck-result") as HTMLButtonElement;
}

function escape(): void {
  (target.querySelector('[role="dialog"]') as HTMLElement).dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
}

describe("CommandDeck lazy confirmation", () => {
  it("re-prepares a confirmation when preparation failed and Retry is chosen", async () => {
    const confirm = vi
      .fn<() => Promise<DeckConfirm>>()
      .mockRejectedValueOnce(new Error("count failed"))
      .mockResolvedValueOnce(confirmation("Fresh confirmation"));
    mountDeck(item(confirm));

    closeResult().click();
    await flush();
    expect(target.querySelector(".deck-operation")?.textContent).toContain("count failed");

    const retry = [...target.querySelectorAll<HTMLButtonElement>(".deck-decisions button")].find(
      (button) => button.textContent === "Retry",
    );
    retry?.click();
    await flush();

    expect(confirm).toHaveBeenCalledTimes(2);
    expect(target.querySelector(".deck-operation")?.textContent).toContain("Fresh confirmation");
  });

  it("keeps the latest result when two preparations overlap", async () => {
    const first = deferred<DeckConfirm>();
    const second = deferred<DeckConfirm>();
    const confirm = vi
      .fn<() => Promise<DeckConfirm>>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    mountDeck(item(confirm));

    closeResult().click();
    await tick();
    escape();
    await tick();
    closeResult().click();
    first.resolve(confirmation("Stale count"));
    await flush();

    second.resolve(confirmation("Latest count"));
    await flush();
    expect(target.querySelector(".deck-operation")?.textContent).toContain("Latest count");
    expect(target.querySelector(".deck-operation")?.textContent).not.toContain("Stale count");
  });

  it("drops a preparation result after Escape", async () => {
    const pending = deferred<DeckConfirm>();
    mountDeck(item(() => pending.promise));

    closeResult().click();
    await tick();
    escape();
    pending.resolve(confirmation("Must stay hidden"));
    await flush();

    expect(target.querySelector(".deck-operation")).toBeNull();
    expect(closeResult()).toBeTruthy();
  });

  it("describes preparation as checking rather than running the command", async () => {
    const pending = deferred<DeckConfirm>();
    mountDeck(item(() => pending.promise));

    closeResult().click();
    await tick();

    expect(target.querySelector(".deck-operation")?.textContent).toContain("Checking...");
    pending.resolve(confirmation("Ready"));
    await flush();
  });

  it("retries a failed static-confirm action without confirming again", async () => {
    const onChoose = vi
      .fn<(entry: DeckItem) => Promise<void>>()
      .mockRejectedValueOnce(new Error("close failed"))
      .mockResolvedValueOnce();
    mountDeck(item(confirmation("Static confirmation")), onChoose);

    closeResult().click();
    await flush();
    expect(target.querySelector(".deck-operation")?.textContent).toContain(
      "Static confirmation",
    );
    const close = [...target.querySelectorAll<HTMLButtonElement>(".deck-decisions button")].find(
      (button) => button.textContent === "Close",
    );
    close?.click();
    await flush();
    expect(target.querySelector(".deck-operation")?.textContent).toContain("close failed");

    const retry = [...target.querySelectorAll<HTMLButtonElement>(".deck-decisions button")].find(
      (button) => button.textContent === "Retry",
    );
    retry?.click();
    await flush();

    expect(onChoose).toHaveBeenCalledTimes(2);
    expect(target.querySelector(".deck-operation")?.textContent).not.toContain(
      "Static confirmation",
    );
    expect(target.querySelector(".deck-decisions")).toBeNull();
  });

  it("drops an action's confirmation after its card was dismissed", async () => {
    const running = deferred<DeckConfirm>();
    const onChoose = vi
      .fn<(entry: DeckItem) => Promise<DeckConfirm>>()
      .mockImplementationOnce(() => running.promise);
    mountDeck(item(undefined), onChoose);

    closeResult().click();
    await tick();
    expect(target.querySelector(".deck-operation")?.textContent).toContain("Working");

    // Escape hands the card back to the list. The command keeps running, but
    // its answer is to a question the deck has stopped asking.
    escape();
    await tick();
    running.resolve(confirmation("Dismissed confirmation"));
    await flush();

    expect(target.querySelector(".deck-operation")).toBeNull();
    expect(closeResult()).toBeTruthy();
  });

  it("selects Cancel when an action returns a confirmation", async () => {
    const onChoose = vi
      .fn<(entry: DeckItem) => Promise<DeckConfirm>>()
      .mockResolvedValueOnce(confirmation("Fresh confirmation"));
    mountDeck(item(undefined), onChoose);

    closeResult().click();
    await flush();

    expect(onChoose).toHaveBeenCalledOnce();
    expect(target.querySelector(".deck-operation")?.textContent).toContain("Fresh confirmation");
    expect(target.querySelector(".deck-decisions button.chosen")?.textContent).toBe("Cancel");
  });
});

describe("CommandDeck focus on close", () => {
  let origin: HTMLButtonElement;

  const run = (over: Partial<DeckItem> = {}): DeckItem => ({
    id: "run",
    title: "Run",
    breadcrumb: "Commands",
    searchText: "run",
    scope: "window",
    ...over,
  });

  /// Focus a control, then mount the deck open over it.
  async function openFromOrigin(
    entries: DeckItem | DeckItem[],
    handlers: {
      onChoose?: (item: DeckItem) => void | DeckConfirm | Promise<void | DeckConfirm>;
      onSuccess?: (item: DeckItem) => void;
    } = {},
  ): Promise<void> {
    origin = document.createElement("button");
    document.body.appendChild(origin);
    origin.focus();
    app = mount(CommandDeckHarness, {
      target,
      props: { items: Array.isArray(entries) ? entries : [entries], ...handlers },
    }) as Record<string, unknown>;
    await flush();
    expect(document.activeElement, "the deck takes focus").toBe(target.querySelector(".deck-input"));
  }

  const close = (): void => (app.close as () => void)();

  function result(title: string): HTMLButtonElement {
    const found = [...target.querySelectorAll<HTMLButtonElement>("button.deck-result")].find(
      (button) => button.querySelector(".deck-result-title")?.textContent === title,
    );
    if (!found) throw new Error(`missing result ${title}`);
    return found;
  }

  afterEach(() => origin.remove());

  it("hands focus back to the element it opened from on Escape", async () => {
    await openFromOrigin(run());
    escape();
    await flush();
    expect(document.activeElement).toBe(origin);
  });

  it("hands focus back when the host hides it", async () => {
    await openFromOrigin(run());
    close();
    await flush();
    expect(document.activeElement).toBe(origin);
  });

  it("leaves focus where it is when a chosen item closes the deck", async () => {
    await openFromOrigin(run(), { onChoose: close });
    closeResult().click();
    await flush();
    expect(target.querySelector(".deck-shell")).toBeNull();
    expect(document.activeElement).not.toBe(origin);
  });

  it("leaves focus where it is when an awaited item's success closes the deck", async () => {
    const onChoose = vi.fn(async () => {});
    await openFromOrigin(run({ awaitResult: true, dismissImmediatelyOnSuccess: true }), {
      onChoose,
      onSuccess: close,
    });
    closeResult().click();
    await flush();
    expect(onChoose).toHaveBeenCalledOnce();
    expect(target.querySelector(".deck-shell")).toBeNull();
    expect(document.activeElement).not.toBe(origin);
  });

  it("treats the next close as a dismissal when a chosen item keeps the deck open", async () => {
    const onChoose = vi.fn();
    await openFromOrigin(run(), { onChoose });
    closeResult().click();
    await flush();
    expect(onChoose).toHaveBeenCalledOnce();
    escape();
    await flush();
    expect(document.activeElement).toBe(origin);
  });

  it("restores focus without scrolling the page", async () => {
    await openFromOrigin(run());
    const focus = vi.spyOn(origin, "focus");
    escape();
    await flush();
    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
  });

  it("does not reach for an element that left the page", async () => {
    await openFromOrigin(run());
    const focus = vi.spyOn(origin, "focus");
    origin.remove();
    escape();
    await flush();
    expect(focus).not.toHaveBeenCalled();
  });

  it("reports the element it opened from, still after it closes", async () => {
    await openFromOrigin(run());
    expect(deckReturnFocus()).toBe(origin);
    escape();
    await flush();
    expect(deckReturnFocus()).toBe(origin);
  });

  it("keeps a newer run's claim when an older run settles first", async () => {
    const older = deferred<void>();
    const newer = deferred<void>();
    const onChoose = vi.fn((item: DeckItem) => (item.id === "older" ? older.promise : newer.promise));
    await openFromOrigin(
      [run({ id: "older", title: "Older", searchText: "older" }), run({ id: "newer", title: "Newer", searchText: "newer" })],
      { onChoose },
    );
    result("Older").click();
    await flush();
    result("Newer").click();
    await flush();
    older.resolve();
    await flush();
    close();
    await flush();
    expect(onChoose).toHaveBeenCalledTimes(2);
    expect(document.activeElement).not.toBe(origin);
    newer.resolve();
  });

  it("hands focus back on Escape after the host's success failed", async () => {
    await openFromOrigin(run({ awaitResult: true, dismissImmediatelyOnSuccess: true }), {
      onChoose: async () => {},
      onSuccess: () => {
        throw new Error("save failed");
      },
    });
    closeResult().click();
    await flush();
    expect(target.querySelector(".deck-operation")?.textContent, "the error card").toContain("save failed");
    escape();
    await flush();
    expect(document.activeElement).toBe(origin);
  });

  it("leaves focus where it is when the success card's timer closes the deck", async () => {
    await openFromOrigin(run({ awaitResult: true }), { onChoose: async () => {}, onSuccess: close });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      closeResult().click();
      await flush();
      expect(target.querySelector(".deck-operation")?.textContent, "the success card").toContain("Run");
      expect(target.querySelector(".deck-shell"), "still open on the card").not.toBeNull();
      vi.advanceTimersByTime(260);
      await flush();
    } finally {
      vi.useRealTimers();
    }
    expect(target.querySelector(".deck-shell")).toBeNull();
    expect(document.activeElement).not.toBe(origin);
  });
});


describe("CommandDeck non-awaited rejection", () => {
  let origin: HTMLButtonElement;
  let unhandled: unknown[];
  const runner = globalThis as unknown as {
    process: {
      on: (event: "unhandledRejection", listener: (reason: unknown) => void) => void;
      off: (event: "unhandledRejection", listener: (reason: unknown) => void) => void;
    };
  };
  const recordUnhandled = (reason: unknown): void => { unhandled.push(reason); };
  const recordWindowRejection = (event: PromiseRejectionEvent): void => {
    recordUnhandled(event.reason);
  };

  beforeEach(() => {
    unhandled = [];
    // jsdom uses Node's promise queue; a browser dispatches the window event.
    runner.process.on("unhandledRejection", recordUnhandled);
    window.addEventListener("unhandledrejection", recordWindowRejection);
    origin = document.createElement("button");
    document.body.appendChild(origin);
    origin.focus();
  });

  afterEach(() => {
    runner.process.off("unhandledRejection", recordUnhandled);
    window.removeEventListener("unhandledrejection", recordWindowRejection);
    origin.remove();
  });

  async function rejectCommand(replaceDraft = false): Promise<void> {
    const pending = deferred<void>();
    mountDeck({ ...item(undefined), awaitResult: false }, () => pending.promise);
    await flush();
    closeResult().click();
    await flush();
    if (replaceDraft) {
      (app.replaceDraft as () => void)();
      await flush();
    }
    pending.reject(new Error("The command was refused"));
    // An unhandled rejection is reported only after the promise queue drains.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flush();
  }

  it("shows the rejection sentence and Back returns to the results", async () => {
    await rejectCommand();
    expect(target.querySelector(".deck-operation")?.textContent).toContain("The command was refused");
    const back = [...target.querySelectorAll<HTMLButtonElement>(".deck-decisions button")]
      .find((button) => button.textContent === "Back");
    expect(back?.classList.contains("chosen")).toBe(true);
    back!.click();
    await flush();
    expect(target.querySelector(".deck-operation")).toBeNull();
    expect(closeResult()).not.toBeNull();
    expect(document.activeElement).toBe(target.querySelector(".deck-input"));
    expect(unhandled).toEqual([]);
  });

  it("closes the error card on Escape and restores the opening focus", async () => {
    await rejectCommand();
    expect(target.querySelector(".deck-operation")?.textContent).toContain("The command was refused");
    escape();
    await flush();
    expect(target.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(origin);
    expect(unhandled).toEqual([]);
  });

  it("handles a late rejection without painting into a replacement draft", async () => {
    await rejectCommand(true);
    expect(target.querySelector(".deck-operation")).toBeNull();
    expect(closeResult()).not.toBeNull();
    expect(unhandled).toEqual([]);
  });
});

describe("command rejection ownership", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function host(method: "open" | "close" | "resetDraft"): void {
    (app[method] as () => void)();
  }

  function draft(): import("../command-deck/model").DeckDraft {
    return (app.currentDraft as () => import("../command-deck/model").DeckDraft)();
  }

  function start(id: string, awaitResult: boolean, onChoose: (entry: DeckItem) => Promise<void>): {
    entry: DeckItem;
    onError: ReturnType<typeof vi.fn>;
  } {
    const entry = { ...item(undefined), id, title: id, awaitResult };
    const onError = vi.fn();
    app = mount(CommandDeckHarness, { target, props: { items: [entry], onChoose, onError } });
    closeResult().click();
    return { entry, onError };
  }

  for (const awaitResult of [false, true]) {
    const path = awaitResult ? "awaited" : "plain";
    for (const state of ["owned", "hidden", "hidden replacement", "visible replacement"] as const) {
      it(`${path} rejection on ${state} uses exactly one destination`, async () => {
        const pending = deferred<void>();
        const { entry, onError } = start(`${path} ${state}`, awaitResult, () => pending.promise);
        await flush();
        const original = draft();
        if (state !== "owned") host("close");
        if (state.includes("replacement")) {
          (app.replaceDraft as (visible: boolean) => void)(state === "visible replacement");
        }
        await flush();
        const error = new Error(`${path} ${state} refused`);
        pending.reject(error);
        await flush();
        if (state === "owned") {
          expect(target.querySelector(".deck-operation")?.textContent).toContain(error.message);
          expect(target.querySelectorAll(".deck-operation-icon.error")).toHaveLength(1);
          expect(onError).not.toHaveBeenCalled();
        } else {
          expect(onError).toHaveBeenCalledExactlyOnceWith(entry, error);
          expect(original.operation).toBeNull();
          expect(draft().operation).toBeNull();
          host("open");
          await flush();
          expect(target.querySelector(".deck-operation")).toBeNull();
          expect(closeResult()).not.toBeNull();
        }
      });
    }
  }

  it("released pending rejection stays off the card after reopening", async () => {
    const pending = deferred<void>();
    const { entry, onError } = start("released", true, () => pending.promise);
    await flush();
    escape();
    await flush();
    host("close");
    await flush();
    host("open");
    await flush();
    const error = new Error("released refused");
    pending.reject(error);
    await flush();
    expect(onError).toHaveBeenCalledExactlyOnceWith(entry, error);
    expect(draft().operation).toBeNull();
    expect(closeResult()).not.toBeNull();
  });

  it("plain rejection remembers a flushed close and reopen", async () => {
    const pending = deferred<void>();
    const { entry, onError } = start("reopened", false, () => pending.promise);
    await flush();
    host("close");
    await flush();
    host("open");
    await flush();
    const error = new Error("reopened refused");
    pending.reject(error);
    await flush();
    expect(onError).toHaveBeenCalledExactlyOnceWith(entry, error);
    expect(draft().operation).toBeNull();
  });

  for (const firstAwaited of [false, true]) {
    for (const secondAwaited of [false, true]) {
      it(`first ${firstAwaited ? "awaited" : "plain"} rejection preserves a newer ${secondAwaited ? "pending" : "plain"} run`, async () => {
        const first = deferred<void>();
        const second = deferred<void>();
        const onChoose = vi.fn().mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
        const { entry, onError } = start(`overlap ${firstAwaited} ${secondAwaited}`, firstAwaited, onChoose);
        await flush();
        if (firstAwaited) { escape(); await flush(); }
        (app.setItems as (entries: DeckItem[]) => void)([{ ...entry, awaitResult: secondAwaited }]);
        await flush();
        closeResult().click();
        await flush();
        const newerOperation = draft().operation;
        const error = new Error("first refused");
        first.reject(error);
        await flush();
        expect(onError).toHaveBeenCalledExactlyOnceWith(entry, error);
        expect(draft().operation).toBe(newerOperation);
        expect(draft().operation?.kind ?? null).toBe(secondAwaited ? "pending" : null);
        host("close");
        second.resolve();
        await flush();
        await vi.advanceTimersByTimeAsync(260);
      });
    }
  }

  for (const lazy of [false, true]) {
    it(`a newer ${lazy ? "preparation" : "confirmation"} keeps its card when a plain run rejects`, async () => {
      const pending = deferred<void>();
      const preparing = deferred<DeckConfirm>();
      const { entry, onError } = start(`question ${lazy}`, false, () => pending.promise);
      await flush();
      (app.setItems as (entries: DeckItem[]) => void)([{
        ...entry, confirm: lazy ? () => preparing.promise : confirmation("Current question"),
      }]);
      await flush();
      closeResult().click();
      await flush();
      const question = draft().operation;
      const error = new Error("old command refused");
      pending.reject(error);
      await flush();
      expect(onError).toHaveBeenCalledExactlyOnceWith(entry, error);
      expect(draft().operation).toBe(question);
      expect(draft().operation?.kind).toBe(lazy ? "preparing" : "confirm");
      preparing.resolve(confirmation("Current question"));
      await flush();
    });
  }

  it("remembers the host closing before the run even when reopened before effects", async () => {
    const pending = deferred<void>();
    const { entry, onError } = start("synchronous close", false, () => {
      host("close");
      host("resetDraft");
      return pending.promise;
    });
    // Both host writes happen before Svelte can observe a closed prop in an effect.
    host("open");
    await flush();
    const error = new Error("reset command refused");
    pending.reject(error);
    await flush();
    expect(onError).toHaveBeenCalledExactlyOnceWith(entry, error);
    expect(draft().operation).toBeNull();
    expect(closeResult()).not.toBeNull();
  });
  it("retires its own pending card after a different draft starts another run", async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    const onChoose = vi.fn().mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    const { entry, onError } = start("different drafts", true, onChoose);
    await flush();
    const original = draft();
    (app.replaceDraft as () => void)();
    await flush();
    closeResult().click();
    await flush();
    const current = draft();
    const newerOperation = current.operation;
    const error = new Error("old draft refused");
    first.reject(error);
    await flush();
    expect(onError).toHaveBeenCalledExactlyOnceWith(entry, error);
    expect(current.operation).toBe(newerOperation);
    expect(current.operation?.kind).toBe("pending");
    expect(original.operation).toBeNull();
    host("close");
    second.resolve();
    await flush();
    await vi.advanceTimersByTimeAsync(260);
  });

});
