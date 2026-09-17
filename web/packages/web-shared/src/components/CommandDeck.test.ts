// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import type { DeckConfirm, DeckItem } from "../command-deck/model";
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
