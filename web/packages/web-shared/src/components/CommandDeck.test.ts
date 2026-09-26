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
    entry: DeckItem,
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
      props: { items: [entry], ...handlers },
    }) as Record<string, unknown>;
    await flush();
    expect(document.activeElement, "the deck takes focus").toBe(target.querySelector(".deck-input"));
  }

  const close = (): void => (app.close as () => void)();

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
});
