// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import type { DeckConfirm, DeckDraft, DeckIcon, DeckItem, DeckScope } from "../command-deck/model";
import { deckPendingReturnFocus } from "./CommandDeck.svelte";
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
  it("answers navigation and execution after focus falls to the page", async () => {
    const onChoose = vi.fn();
    const first = { ...item(undefined), id: "first", awaitResult: false };
    const second = { ...first, id: "second" };
    mountDeck(first, onChoose);
    (app.setItems as (items: DeckItem[]) => void)([first, second]);
    await flush();
    (document.activeElement as HTMLElement).blur();
    expect(document.activeElement).toBe(document.body);

    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flush();

    expect(onChoose, "page focus still executes the selected command").toHaveBeenCalledExactlyOnceWith(second);
  });

  it("closes from page focus and leaves keys alone while closed", async () => {
    const onChoose = vi.fn();
    mountDeck({ ...item(undefined), awaitResult: false }, onChoose);
    await flush();
    (document.activeElement as HTMLElement).blur();
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.body.dispatchEvent(escape);
    await flush();
    expect(target.querySelector(".deck-shell"), "Escape closes the deck from the page").toBeNull();
    expect(escape.defaultPrevented).toBe(true);

    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    document.body.dispatchEvent(enter);
    await flush();
    expect(enter.defaultPrevented, "a closed deck leaves page keys alone").toBe(false);
    expect(onChoose).not.toHaveBeenCalled();
  });

  it("takes the keyboard back from a control under it and leaves a modal dialog its keys", async () => {
    const onChoose = vi.fn();
    mountDeck({ ...item(undefined), awaitResult: false }, onChoose);
    await flush();
    const query = target.querySelector(".deck-input");
    const outside = document.createElement("div");
    outside.innerHTML = '<input><textarea class="xterm-helper-textarea"></textarea><div contenteditable="true"></div><div role="dialog" aria-modal="true" tabindex="-1"></div>';
    document.body.append(outside);
    try {
      const modal = outside.querySelector<HTMLElement>('[role="dialog"]')!;
      modal.hidden = true;
      for (const control of outside.querySelectorAll<HTMLElement>("input, textarea, [contenteditable]")) {
        control.focus();
        expect(document.activeElement, "the query takes the keyboard back").toBe(query);
      }
      modal.hidden = false;
      modal.focus();
      expect(document.activeElement, "a modal dialog keeps the focus it takes").toBe(modal);
      modal.blur();
      const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
      document.body.dispatchEvent(event);
      await flush();
      expect(event.defaultPrevented, "the modal keeps page keys").toBe(false);
      expect(target.querySelector(".deck-shell")).not.toBeNull();
      expect(onChoose).not.toHaveBeenCalled();
    } finally {
      outside.remove();
    }
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flush();
    expect(target.querySelector(".deck-shell"), "the deck resumes after the modal closes").toBeNull();
  });

  it("ignores a hidden dialog while answering page keys", async () => {
    mountDeck(item(undefined));
    await flush();
    const hidden = document.createElement("div");
    hidden.style.display = "none";
    hidden.innerHTML = '<div role="dialog" aria-modal="true"></div>';
    document.body.append(hidden);
    try {
      (document.activeElement as HTMLElement).blur();
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await flush();
      expect(target.querySelector(".deck-shell"), "a hidden dialog does not own the page").toBeNull();
    } finally {
      hidden.remove();
    }
  });

  it("accepts the first Enter to cancel a pointer-opened confirmation", async () => {
    const onChoose = vi.fn();
    mountDeck(item(confirmation("Pointer confirmation")), onChoose);
    await flush();
    closeResult().click();
    await flush();
    expect(target.querySelector(".deck-decisions button.chosen")?.textContent).toBe("Cancel");

    target.querySelector(".deck-input")!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    await flush();

    expect(target.querySelector(".deck-operation"), "the first Enter chooses Cancel").toBeNull();
    expect(onChoose).not.toHaveBeenCalled();
  });

  it("accepts the first Enter after a pointer starts lazy confirmation", async () => {
    const preparing = deferred<DeckConfirm>();
    const onChoose = vi.fn();
    mountDeck({ ...item(() => preparing.promise), awaitResult: false }, onChoose);
    await flush();
    closeResult().click();
    await flush();
    expect(target.querySelector(".deck-operation")?.textContent).toContain("Checking...");
    preparing.resolve(confirmation("Pointer confirmation"));
    await flush();

    const input = target.querySelector(".deck-input")!;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await flush();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flush();

    expect(onChoose, "the first Enter chooses the selected action").toHaveBeenCalledOnce();
  });

  it("requires an Enter release before a keyboard-opened confirmation can act", async () => {
    const onChoose = vi.fn();
    mountDeck({ ...item(confirmation("Keyboard confirmation")), awaitResult: false }, onChoose);
    await flush();
    const input = target.querySelector(".deck-input")!;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flush();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await flush();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", repeat: true, bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flush();
    expect(onChoose, "a held opening Enter cannot execute the action").not.toHaveBeenCalled();

    input.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flush();
    expect(onChoose).toHaveBeenCalledOnce();
  });

  it("retains an Enter release that arrives during confirmation preparation", async () => {
    const preparing = deferred<DeckConfirm>();
    mountDeck(item(() => preparing.promise));
    await flush();
    const input = target.querySelector(".deck-input")!;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flush();
    input.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
    preparing.resolve(confirmation("Keyboard confirmation"));
    await flush();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flush();
    expect(target.querySelector(".deck-operation")).toBeNull();
  });

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

    // Escape returns to the results while the pending command settles.
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
      onFocusLost?: () => void;
      mayTakeFocus?: () => boolean;
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

  /// A field a command puts focus on, as a command that opens a surface does.
  function field(): HTMLInputElement {
    const input = document.createElement("input");
    document.body.appendChild(input);
    return input;
  }

  it("hands focus back when a chosen item closes the deck and takes none", async () => {
    await openFromOrigin(run(), { onChoose: close });
    closeResult().click();
    await flush();
    expect(target.querySelector(".deck-shell")).toBeNull();
    expect(document.activeElement).toBe(origin);
  });

  it("leaves focus where a chosen item put it", async () => {
    const taken = field();
    await openFromOrigin(run(), { onChoose: () => { close(); taken.focus(); } });
    closeResult().click();
    await flush();
    expect(target.querySelector(".deck-shell")).toBeNull();
    expect(document.activeElement).toBe(taken);
    taken.remove();
  });

  it("leaves focus where a chosen item puts it after it settles", async () => {
    const taken = field();
    const settled = deferred<void>();
    await openFromOrigin(run(), {
      onChoose: async () => {
        close();
        await settled.promise;
        taken.focus();
      },
    });
    closeResult().click();
    await flush();
    expect(target.querySelector(".deck-shell")).toBeNull();
    expect(document.activeElement, "nothing is restored while the run is in flight").toBe(document.body);
    settled.resolve();
    await flush();
    expect(document.activeElement).toBe(taken);
    taken.remove();
  });

  it("hands focus back when an awaited item's success closes the deck and took none", async () => {
    const onChoose = vi.fn(async () => {});
    await openFromOrigin(run({ awaitResult: true, dismissImmediatelyOnSuccess: true }), {
      onChoose,
      onSuccess: close,
    });
    closeResult().click();
    await flush();
    expect(onChoose).toHaveBeenCalledOnce();
    expect(target.querySelector(".deck-shell")).toBeNull();
    expect(document.activeElement).toBe(origin);
  });

  it("leaves focus where an awaited item put it before its success", async () => {
    const taken = field();
    await openFromOrigin(run({ awaitResult: true, dismissImmediatelyOnSuccess: true }), {
      onChoose: async () => { taken.focus(); },
      onSuccess: close,
    });
    closeResult().click();
    await flush();
    expect(target.querySelector(".deck-shell")).toBeNull();
    expect(document.activeElement).toBe(taken);
    taken.remove();
  });

  it("hands focus back when a chosen item fails after closing the deck", async () => {
    await openFromOrigin(run(), {
      onChoose: async () => {
        close();
        throw new Error("refused");
      },
    });
    closeResult().click();
    await flush();
    expect(target.querySelector(".deck-shell")).toBeNull();
    expect(document.activeElement).toBe(origin);
  });

  it("tells the host when the element it opened from left the page", async () => {
    const onFocusLost = vi.fn();
    await openFromOrigin(run(), { onChoose: () => { close(); origin.remove(); }, onFocusLost });
    closeResult().click();
    await flush();
    expect(onFocusLost).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(document.body);
  });

  it("treats an element hidden under another surface as gone", async () => {
    const onFocusLost = vi.fn();
    await openFromOrigin(run(), {
      onChoose: () => { close(); origin.style.visibility = "hidden"; },
      onFocusLost,
    });
    const focus = vi.spyOn(origin, "focus");
    closeResult().click();
    await flush();
    expect(focus).not.toHaveBeenCalled();
    expect(onFocusLost).toHaveBeenCalledOnce();
  });

  it("hands focus to nothing while the host says the page may not take it", async () => {
    const onFocusLost = vi.fn();
    const mayTakeFocus = vi.fn(() => false);
    await openFromOrigin(run(), { onChoose: close, onFocusLost, mayTakeFocus });
    const focus = vi.spyOn(origin, "focus");
    closeResult().click();
    await flush();
    expect(mayTakeFocus).toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    expect(onFocusLost).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(document.body);
  });

  it("publishes the element a run will hand focus to until the close has rendered", async () => {
    const held = deferred<void>();
    await openFromOrigin(run(), {
      onChoose: () => {
        close();
        expect(deckPendingReturnFocus(), "for a dialog the command opens as it runs").toBe(origin);
        return held.promise;
      },
    });
    closeResult().click();
    await flush();
    expect(target.querySelector(".deck-shell")).toBeNull();
    expect(deckPendingReturnFocus(), "a dialog opened later is not the command's").toBeNull();
    held.resolve();
    await flush();
    expect(document.activeElement).toBe(origin);
  });

  it("asks nothing of the host while the element it opened from can take focus", async () => {
    const onFocusLost = vi.fn();
    await openFromOrigin(run(), { onChoose: close, onFocusLost });
    closeResult().click();
    await flush();
    expect(onFocusLost).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(origin);
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
    expect(document.activeElement, "the newer run still decides").not.toBe(origin);
    newer.resolve();
    await flush();
    expect(document.activeElement, "the newer run took no focus").toBe(origin);
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
    expect(target.querySelector(".deck-operation"), "Escape leaves the card first").toBeNull();
    expect(target.querySelector(".deck-shell")).not.toBeNull();
    escape();
    await flush();
    expect(document.activeElement).toBe(origin);
  });

  it("hands focus back when the success card's timer closes the deck", async () => {
    await openFromOrigin(run({ awaitResult: true }), { onChoose: async () => {}, onSuccess: close });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      closeResult().click();
      await flush();
      expect(target.querySelector(".deck-operation")?.textContent, "the success card").toContain("Run");
      expect(target.querySelector(".deck-shell"), "still open on the card").not.toBeNull();
      expect(document.activeElement, "the card keeps the deck's focus").not.toBe(origin);
      vi.advanceTimersByTime(260);
      await flush();
    } finally {
      vi.useRealTimers();
    }
    await flush();
    expect(target.querySelector(".deck-shell")).toBeNull();
    expect(document.activeElement).toBe(origin);
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

  it("leaves the error card on Escape, then closes and restores the opening focus", async () => {
    await rejectCommand();
    expect(target.querySelector(".deck-operation")?.textContent).toContain("The command was refused");
    escape();
    await flush();
    expect(target.querySelector(".deck-operation"), "the first Escape returns to the list").toBeNull();
    expect(closeResult()).not.toBeNull();
    expect(document.activeElement).toBe(target.querySelector(".deck-input"));
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

describe("command success ownership", () => {
  type Draft = import("../command-deck/model").DeckDraft;

  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function host(method: "open" | "close"): void {
    (app[method] as () => void)();
  }

  function draft(): Draft {
    return (app.currentDraft as () => Draft)();
  }

  /// Mount one awaited command and choose it. `card` picks the success that
  /// shows a card for 260 ms over the one that dismisses at once.
  function start(card: boolean, onChoose: (entry: DeckItem) => Promise<void>): {
    entry: DeckItem;
    onSuccess: ReturnType<typeof vi.fn>;
  } {
    const entry = { ...item(undefined), dismissImmediatelyOnSuccess: !card };
    const onSuccess = vi.fn();
    app = mount(CommandDeckHarness, { target, props: { items: [entry], onChoose, onSuccess } });
    closeResult().click();
    return { entry, onSuccess };
  }

  /// Carry an answered command past its success card's 260 ms.
  async function settle(): Promise<void> {
    await flush();
    await vi.advanceTimersByTimeAsync(260);
    await flush();
  }

  for (const card of [true, false]) {
    const shape = card ? "with a success card" : "dismissing at once";

    it(`a released command ${shape} leaves the list and closes nothing`, async () => {
      const running = deferred<void>();
      const { onSuccess } = start(card, () => running.promise);
      await flush();
      escape();
      await flush();
      running.resolve();
      await flush();
      expect(target.querySelector(".deck-operation"), "no card over the list").toBeNull();
      await settle();
      expect(onSuccess).not.toHaveBeenCalled();
      expect(draft().operation).toBeNull();
      expect(closeResult()).not.toBeNull();
    });

    it(`a released command ${shape} leaves a newer command's card`, async () => {
      const first = deferred<void>();
      const second = deferred<void>();
      const onChoose = vi.fn()
        .mockImplementationOnce(() => first.promise)
        .mockImplementationOnce(() => second.promise);
      const { entry, onSuccess } = start(card, onChoose);
      await flush();
      escape();
      await flush();
      closeResult().click();
      await flush();
      const newer = draft().operation;
      expect(newer?.kind).toBe("pending");
      first.resolve();
      await settle();
      expect(onSuccess).not.toHaveBeenCalled();
      expect(draft().operation).toBe(newer);
      expect(target.querySelector(".deck-operation")?.textContent).toContain("Working");
      // The newer run still owns its card, so its success is the one shown.
      second.resolve();
      await settle();
      expect(onSuccess).toHaveBeenCalledExactlyOnceWith(entry);
    });

    for (const lazy of [false, true]) {
      it(`a released command ${shape} leaves a ${lazy ? "preparation" : "question"}`, async () => {
        const running = deferred<void>();
        const preparing = deferred<DeckConfirm>();
        const { entry, onSuccess } = start(card, () => running.promise);
        await flush();
        escape();
        await flush();
        (app.setItems as (entries: DeckItem[]) => void)([{
          ...entry, confirm: lazy ? () => preparing.promise : confirmation("Current question"),
        }]);
        await flush();
        closeResult().click();
        await flush();
        const question = draft().operation;
        expect(question?.kind).toBe(lazy ? "preparing" : "confirm");
        running.resolve();
        await settle();
        expect(onSuccess).not.toHaveBeenCalled();
        expect(draft().operation).toBe(question);
        preparing.resolve(confirmation("Current question"));
        await flush();
        expect(target.querySelector(".deck-operation")?.textContent).toContain("Current question");
      });
    }

    it(`a command ${shape} that answers a hidden deck retires its card and closes nothing`, async () => {
      const running = deferred<void>();
      const { onSuccess } = start(card, () => running.promise);
      await flush();
      host("close");
      await flush();
      running.resolve();
      await settle();
      expect(onSuccess).not.toHaveBeenCalled();
      expect(draft().operation).toBeNull();
      host("open");
      await flush();
      expect(target.querySelector(".deck-operation")).toBeNull();
      expect(closeResult()).not.toBeNull();
    });

    // A host clears the card when the command's own effect changes what the
    // deck lists. That is not the user leaving the command.
    it(`a command ${shape} whose card the host cleared still shows its success`, async () => {
      const running = deferred<void>();
      const { entry, onSuccess } = start(card, () => running.promise);
      await flush();
      draft().operation = null;
      await flush();
      expect(closeResult()).not.toBeNull();
      running.resolve();
      await flush();
      expect(target.querySelectorAll(".deck-operation-icon.success")).toHaveLength(card ? 1 : 0);
      await settle();
      expect(onSuccess).toHaveBeenCalledExactlyOnceWith(entry);
    });

    it(`a command ${shape} whose cleared card gave way to a newer command shows no success`, async () => {
      const first = deferred<void>();
      const second = deferred<void>();
      const onChoose = vi.fn()
        .mockImplementationOnce(() => first.promise)
        .mockImplementationOnce(() => second.promise);
      const { entry, onSuccess } = start(card, onChoose);
      await flush();
      draft().operation = null;
      await flush();
      closeResult().click();
      await flush();
      const newer = draft().operation;
      expect(newer?.kind).toBe("pending");
      first.resolve();
      await settle();
      expect(onSuccess).not.toHaveBeenCalled();
      expect(draft().operation).toBe(newer);
      second.resolve();
      await settle();
      expect(onSuccess).toHaveBeenCalledExactlyOnceWith(entry);
    });

    it(`a command ${shape} retires its own card on a replaced draft`, async () => {
      const running = deferred<void>();
      const { onSuccess } = start(card, () => running.promise);
      await flush();
      const original = draft();
      (app.replaceDraft as () => void)();
      await flush();
      running.resolve();
      await settle();
      expect(onSuccess).not.toHaveBeenCalled();
      expect(original.operation).toBeNull();
      expect(draft().operation).toBeNull();
    });

    // A close is the user leaving the command, whatever the host does with
    // the card: this harness keeps it across a reopen, both hosts clear it.
    it(`a command ${shape} hidden and reopened under its own card retires the card and closes nothing`, async () => {
      const running = deferred<void>();
      const { onSuccess } = start(card, () => running.promise);
      await flush();
      host("close");
      await flush();
      host("open");
      await flush();
      expect(target.querySelector(".deck-operation")?.textContent).toContain("Working");
      running.resolve();
      await settle();
      expect(onSuccess).not.toHaveBeenCalled();
      expect(target.querySelector(".deck-operation")).toBeNull();
      expect(closeResult()).not.toBeNull();
    });

    const dismissals: [string, () => Promise<void>][] = [
      ["a click on the scrim", async () => {
        (target.querySelector(".deck-backdrop") as HTMLButtonElement).click();
      }],
      ["the host hiding the deck", async () => host("close")],
      ["Escape on its card and Escape again", async () => {
        escape();
        await flush();
        expect(target.querySelector(".deck-shell"), "the first Escape releases the card").not.toBeNull();
        escape();
      }],
    ];
    for (const [how, dismiss] of dismissals) {
      it(`a command ${shape} dismissed by ${how} answers nothing in the deck opened after it`, async () => {
        const running = deferred<void>();
        const { onSuccess } = start(card, () => running.promise);
        await flush();
        await dismiss();
        await flush();
        expect(target.querySelector(".deck-shell")).toBeNull();
        // Both hosts open the deck again at the root with the card cleared.
        draft().operation = null;
        host("open");
        await flush();
        await typeQuery("clo");
        running.resolve();
        await settle();
        expect(onSuccess, "the host is not told to close the deck").not.toHaveBeenCalled();
        expect(target.querySelector(".deck-operation"), "no card of the earlier run").toBeNull();
        expect(draft().query, "what was typed since stays").toBe("clo");
        expect(closeResult()).not.toBeNull();
      });
    }
  }

  it("a command dismissed and reopened puts no question it answers with", async () => {
    const running = deferred<DeckConfirm>();
    start(true, () => running.promise as unknown as Promise<void>);
    await flush();
    host("close");
    await flush();
    draft().operation = null;
    host("open");
    await flush();
    running.resolve(confirmation("A question nobody is waiting for"));
    await settle();
    expect(target.querySelector(".deck-operation")).toBeNull();
    expect(closeResult()).not.toBeNull();
  });

  it("a command whose host closed the deck as it started answers nothing after a reopen before effects", async () => {
    const running = deferred<void>();
    const { onSuccess } = start(true, () => {
      // Closed and reopened before Svelte can observe a closed prop in an effect.
      host("close");
      return running.promise;
    });
    host("open");
    await flush();
    running.resolve();
    await settle();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(target.querySelector(".deck-operation")).toBeNull();
  });

  it("a command that still owns its card shows its success, then runs the host's handler", async () => {
    const running = deferred<void>();
    const { entry, onSuccess } = start(true, () => running.promise);
    await flush();
    expect(draft().operation?.kind).toBe("pending");
    running.resolve();
    await flush();
    expect(target.querySelectorAll(".deck-operation-icon.success")).toHaveLength(1);
    expect(target.querySelector(".deck-operation")?.textContent).toContain("Done");
    await vi.advanceTimersByTimeAsync(259);
    expect(onSuccess).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(onSuccess).toHaveBeenCalledExactlyOnceWith(entry);
  });

  it("a command that dismisses at once runs the host's handler with no success card", async () => {
    const running = deferred<void>();
    const { entry, onSuccess } = start(false, () => running.promise);
    await flush();
    running.resolve();
    await flush();
    expect(onSuccess).toHaveBeenCalledExactlyOnceWith(entry);
    expect(target.querySelector(".deck-operation-icon.success")).toBeNull();
  });

  it("a success card hidden inside its 260 ms closes nothing and leaves no card", async () => {
    const { onSuccess } = start(true, async () => {});
    await flush();
    expect(draft().operation?.kind).toBe("success");
    escape();
    await flush();
    expect(target.querySelector(".deck-shell")).toBeNull();
    await settle();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(draft().operation).toBeNull();
    host("open");
    await flush();
    expect(closeResult()).not.toBeNull();
  });

  it("a success card the host cleared inside its 260 ms still runs the host's handler", async () => {
    const { entry, onSuccess } = start(true, async () => {});
    await flush();
    expect(draft().operation?.kind).toBe("success");
    draft().operation = null;
    await settle();
    expect(onSuccess).toHaveBeenCalledExactlyOnceWith(entry);
  });

  it("a success card the host cleared gives way to a newer command inside its 260 ms", async () => {
    const second = deferred<void>();
    const onChoose = vi.fn()
      .mockImplementationOnce(async () => {})
      .mockImplementationOnce(() => second.promise);
    const { entry, onSuccess } = start(true, onChoose);
    await flush();
    expect(draft().operation?.kind).toBe("success");
    draft().operation = null;
    await flush();
    closeResult().click();
    await flush();
    const newer = draft().operation;
    expect(newer?.kind).toBe("pending");
    await settle();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(draft().operation).toBe(newer);
    second.resolve();
    await settle();
    expect(onSuccess).toHaveBeenCalledExactlyOnceWith(entry);
  });

  it("a success card retires on a draft replaced inside its 260 ms", async () => {
    const { onSuccess } = start(true, async () => {});
    await flush();
    const original = draft();
    expect(original.operation?.kind).toBe("success");
    (app.replaceDraft as () => void)();
    await settle();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(original.operation).toBeNull();
  });
});

/// Rows `Row 1` to `Row <count>`, each an action with a breadcrumb.
function plainRows(count: number, over: (index: number) => Partial<DeckItem> = () => ({})): DeckItem[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `row-${index + 1}`,
    title: `Row ${index + 1}`,
    breadcrumb: "Commands",
    searchText: "",
    scope: "window",
    ...over(index),
  }));
}

function named(id: string, title: string, over: Partial<DeckItem> = {}): DeckItem {
  return { id, title, breadcrumb: "Commands", searchText: "", scope: "window", ...over };
}

/// A stand-in icon component that leaves a mark where it was drawn.
function markerIcon(name: string): DeckIcon {
  return (anchor: Node): void => {
    const mark = document.createElement("i");
    mark.dataset.icon = name;
    anchor.parentNode?.insertBefore(mark, anchor);
  };
}

/// Three scopes; the middle one is not available.
function railScopes(): DeckScope[] {
  return [
    { id: "app", label: "Terminal", icon: markerIcon("app") },
    { id: "pane", label: "Pane", icon: markerIcon("pane"), available: false },
    { id: "window", label: "Window", caption: "Win", icon: markerIcon("window") },
  ];
}

async function mountWith(props: Record<string, unknown>): Promise<void> {
  app = mount(CommandDeckHarness, { target, props: props as never }) as Record<string, unknown>;
  await flush();
}

function deckInput(): HTMLInputElement {
  return target.querySelector(".deck-input") as HTMLInputElement;
}

function hostDraft(): DeckDraft {
  return (app.currentDraft as () => DeckDraft)();
}

/// Send one keydown to the input, where focus rests while the deck is open.
async function press(key: string, init: KeyboardEventInit = {}): Promise<KeyboardEvent> {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  deckInput().dispatchEvent(event);
  await flush();
  return event;
}

async function typeQuery(query: string): Promise<void> {
  const field = deckInput();
  field.value = query;
  field.dispatchEvent(new InputEvent("input", { bubbles: true, data: query }));
  await flush();
}

function activeTitle(): string | null {
  return target.querySelector(".deck-result.active .deck-result-title")?.textContent ?? null;
}

function resultRows(): HTMLButtonElement[] {
  return [...target.querySelectorAll<HTMLButtonElement>("button.deck-result")];
}

function rowTitled(title: string): HTMLButtonElement {
  const found = resultRows().find(
    (button) => button.querySelector(".deck-result-title")?.textContent === title,
  );
  if (!found) throw new Error(`missing row ${title}`);
  return found;
}

function orb(label: string): HTMLButtonElement {
  const found = target.querySelector<HTMLButtonElement>(`.deck-scope[aria-label="${label} scope"]`);
  if (!found) throw new Error(`missing orb ${label}`);
  return found;
}

describe("CommandDeck row keys", () => {
  it("selects row 1 on open, and the first Down selects row 2", async () => {
    await mountWith({ items: plainRows(3) });
    expect(activeTitle()).toBe("Row 1");
    const down = await press("ArrowDown");
    expect(activeTitle()).toBe("Row 2");
    expect(down.defaultPrevented).toBe(true);
    expect(deckInput().getAttribute("aria-activedescendant")).toBe(rowTitled("Row 2").id);
    expect(hostDraft().selectedId).toBe("row-2");
  });

  it("wraps Up from the first row and Down from the last", async () => {
    await mountWith({ items: plainRows(3) });
    await press("ArrowUp");
    expect(activeTitle()).toBe("Row 3");
    await press("ArrowDown");
    expect(activeTitle()).toBe("Row 1");
  });

  it("leaves Ctrl+N and Ctrl+P to the browser: only the arrows move rows", async () => {
    await mountWith({ items: plainRows(3) });
    await press("ArrowDown");
    for (const [key, code] of [["n", "KeyN"], ["p", "KeyP"], ["c", "KeyC"]] as const) {
      const chord = await press(key, { ctrlKey: true, code });
      expect(chord.defaultPrevented, `Ctrl+${key.toUpperCase()}`).toBe(false);
      expect(activeTitle(), `Ctrl+${key.toUpperCase()}`).toBe("Row 2");
    }
  });

  it("pages by the number of rows the list shows, without wrapping", async () => {
    await mountWith({ items: plainRows(30) });
    Object.defineProperty(target.querySelector(".deck-results"), "clientHeight", {
      configurable: true,
      value: 180,
    });
    for (const row of resultRows()) {
      Object.defineProperty(row, "offsetHeight", { configurable: true, value: 36 });
    }
    const down = await press("PageDown");
    expect(down.defaultPrevented).toBe(true);
    expect(activeTitle(), "180 px of 36 px rows is five").toBe("Row 6");
    await press("PageDown");
    expect(activeTitle()).toBe("Row 11");
    await press("PageUp");
    expect(activeTitle()).toBe("Row 6");
    await press("PageUp");
    await press("PageUp");
    expect(activeTitle(), "PageUp stops at the first row").toBe("Row 1");
    await press("End");
    await press("PageDown");
    expect(activeTitle(), "PageDown stops at the last row").toBe("Row 30");
  });

  it("pages by ten rows where the list has no layout to measure", async () => {
    await mountWith({ items: plainRows(30) });
    await press("PageDown");
    expect(activeTitle()).toBe("Row 11");
  });

  it("takes Home and End for the rows on an empty query and leaves them to the caret otherwise", async () => {
    await mountWith({ items: plainRows(5) });
    const end = await press("End");
    expect(activeTitle()).toBe("Row 5");
    expect(end.defaultPrevented).toBe(true);
    const home = await press("Home");
    expect(activeTitle()).toBe("Row 1");
    expect(home.defaultPrevented).toBe(true);

    await typeQuery("row");
    const caretEnd = await press("End");
    const caretHome = await press("Home");
    expect(caretEnd.defaultPrevented).toBe(false);
    expect(caretHome.defaultPrevented).toBe(false);
    expect(activeTitle()).toBe("Row 1");
  });

  it("moves to the first row of the next and the previous section on Alt+Down and Alt+Up", async () => {
    // Recent holds rows 1 and 2, Terminal 3 to 5, Pane 6 and 7.
    const items = plainRows(7, (index) => ({
      section: index < 2 ? "Recent" : index < 5 ? "Terminal" : "Pane",
    }));
    await mountWith({ items });
    const next = await press("ArrowDown", { altKey: true });
    expect(next.defaultPrevented).toBe(true);
    expect(activeTitle()).toBe("Row 3");
    await press("ArrowDown");
    expect(activeTitle()).toBe("Row 4");
    await press("ArrowDown", { altKey: true });
    expect(activeTitle()).toBe("Row 6");
    await press("ArrowDown", { altKey: true });
    expect(activeTitle(), "the last section wraps to the first").toBe("Row 1");
    await press("ArrowUp", { altKey: true });
    expect(activeTitle(), "the first section wraps to the last").toBe("Row 6");
    await press("ArrowDown");
    expect(activeTitle()).toBe("Row 7");
    await press("ArrowUp", { altKey: true });
    expect(activeTitle(), "from inside a section, the previous one's first row").toBe("Row 3");
  });

  it("moves from the row the pointer selected, and a pointer at rest does not take the selection back", async () => {
    await mountWith({ items: plainRows(4) });
    const move = async (title: string, x: number): Promise<void> => {
      rowTitled(title).dispatchEvent(
        new MouseEvent("pointermove", { bubbles: true, screenX: x, screenY: 40 }),
      );
      await flush();
    };
    await move("Row 3", 10);
    expect(activeTitle(), "the first report only places the pointer").toBe("Row 1");
    await move("Row 3", 11);
    expect(activeTitle()).toBe("Row 3");
    await press("ArrowDown");
    expect(activeTitle()).toBe("Row 4");
    // The list scrolled under the pointer: a report from where it already was.
    await move("Row 2", 11);
    expect(activeTitle()).toBe("Row 4");
    await move("Row 2", 12);
    expect(activeTitle()).toBe("Row 2");
  });
});

describe("CommandDeck scope keys", () => {
  it("cycles the available scopes on Tab and Shift+Tab, wrapping through no scope", async () => {
    const onScope = vi.fn();
    const onClearScope = vi.fn();
    await mountWith({ items: plainRows(2), scopes: railScopes(), onScope, onClearScope });

    const tab = await press("Tab");
    expect(tab.defaultPrevented).toBe(true);
    expect(onScope).toHaveBeenLastCalledWith("app");
    expect(hostDraft().scope).toBe("app");
    expect(orb("Terminal").classList.contains("active")).toBe(true);

    await press("Tab");
    expect(onScope, "the unavailable scope is passed over").toHaveBeenLastCalledWith("window");
    expect(hostDraft().scope).toBe("window");

    await press("Tab");
    expect(onClearScope, "after the last scope comes no scope").toHaveBeenCalledTimes(1);
    expect(hostDraft().scope).toBeNull();

    await press("Tab");
    expect(onScope).toHaveBeenLastCalledWith("app");
    expect(onScope).toHaveBeenCalledTimes(3);

    const back = await press("Tab", { shiftKey: true });
    expect(back.defaultPrevented).toBe(true);
    expect(onClearScope).toHaveBeenCalledTimes(2);
    expect(hostDraft().scope).toBeNull();

    await press("Tab", { shiftKey: true });
    expect(onScope, "before no scope comes the last scope").toHaveBeenLastCalledWith("window");
    expect(document.activeElement, "focus stays on the input").toBe(deckInput());
  });

  it("keeps Tab on the input when the host offers no scope", async () => {
    const onScope = vi.fn();
    const onClearScope = vi.fn();
    await mountWith({ items: plainRows(2), onScope, onClearScope });
    const tab = await press("Tab");
    expect(tab.defaultPrevented).toBe(true);
    expect(onScope).not.toHaveBeenCalled();
    expect(onClearScope).not.toHaveBeenCalled();
    expect(target.querySelector(".deck-scopes"), "no rail without scopes").toBeNull();
  });

  it("leaves Alt+digit to the browser: a scope is reached by Tab or its orb", async () => {
    const onScope = vi.fn();
    const onClearScope = vi.fn();
    await mountWith({ items: plainRows(2), scopes: railScopes(), onScope, onClearScope });
    await press("Tab");
    expect(hostDraft().scope).toBe("app");

    for (const [key, code] of [["3", "Digit3"], ["¡", "Digit1"], ["0", "Digit0"]] as const) {
      const chord = await press(key, { altKey: true, code });
      expect(chord.defaultPrevented, `Alt+${code}`).toBe(false);
    }
    expect(onScope).toHaveBeenCalledExactlyOnceWith("app");
    expect(onClearScope).not.toHaveBeenCalled();
    expect(hostDraft().scope).toBe("app");
    expect(orb("Terminal").getAttribute("title"), "an orb's tooltip names no chord").toBe("Terminal");
  });
});

describe("CommandDeck run and navigation keys", () => {
  it("runs the selected row on Enter", async () => {
    const onChoose = vi.fn();
    const items = plainRows(3);
    await mountWith({ items, onChoose });
    await press("ArrowDown");
    const enter = await press("Enter");
    expect(enter.defaultPrevented).toBe(true);
    expect(onChoose).toHaveBeenCalledExactlyOnceWith(items[1]);
  });

  it("enters a branch or a choice on Right, opens an expandable row's page, and never runs an action", async () => {
    const onChoose = vi.fn();
    const onExpand = vi.fn();
    const items = [
      named("run", "Run"),
      named("branch", "Windows", { kind: "branch" }),
      named("choice", "Theme", { kind: "choice" }),
      named("toggle", "Details", { kind: "toggle" }),
      named("window", "Window 1", { expandable: true }),
      named("locked", "Locked", { kind: "branch", disabled: true }),
    ];
    await mountWith({ items, onChoose, onExpand });

    const onAction = await press("ArrowRight");
    expect(onChoose, "Right on an action row does nothing").not.toHaveBeenCalled();
    expect(onExpand).not.toHaveBeenCalled();
    expect(onAction.defaultPrevented).toBe(false);

    await press("ArrowDown");
    const onBranch = await press("ArrowRight");
    expect(onBranch.defaultPrevented).toBe(true);
    expect(onChoose).toHaveBeenLastCalledWith(items[1]);

    await press("ArrowDown");
    await press("ArrowRight");
    expect(onChoose).toHaveBeenLastCalledWith(items[2]);
    expect(onChoose).toHaveBeenCalledTimes(2);

    await press("ArrowDown");
    await press("ArrowRight");
    expect(onChoose, "a toggle flips on Enter only").toHaveBeenCalledTimes(2);

    await press("ArrowDown");
    const onExpandable = await press("ArrowRight");
    expect(onExpandable.defaultPrevented).toBe(true);
    expect(onExpand).toHaveBeenCalledExactlyOnceWith(items[4]);
    expect(onChoose, "Right opens the page and does not run the row").toHaveBeenCalledTimes(2);

    await press("ArrowDown");
    await press("ArrowRight");
    expect(onChoose, "a disabled branch stays shut").toHaveBeenCalledTimes(2);
  });

  it("leaves Right to the text caret until the caret is at the end of the query", async () => {
    const onChoose = vi.fn();
    const items = [named("branch", "Windows", { kind: "branch" })];
    await mountWith({ items, onChoose });
    await typeQuery("win");
    const field = deckInput();

    field.setSelectionRange(1, 1);
    const inside = await press("ArrowRight");
    expect(inside.defaultPrevented).toBe(false);
    expect(onChoose).not.toHaveBeenCalled();

    field.setSelectionRange(0, 3);
    const selected = await press("ArrowRight");
    expect(selected.defaultPrevented, "a selection collapses first").toBe(false);
    expect(onChoose).not.toHaveBeenCalled();

    field.setSelectionRange(3, 3);
    const atEnd = await press("ArrowRight");
    expect(atEnd.defaultPrevented).toBe(true);
    expect(onChoose).toHaveBeenCalledExactlyOnceWith(items[0]);
  });

  it("goes back on Left and Backspace with an empty query and edits the text otherwise", async () => {
    const onBack = vi.fn();
    await mountWith({ items: plainRows(2), onBack });
    const left = await press("ArrowLeft");
    const backspace = await press("Backspace");
    expect(onBack).toHaveBeenCalledTimes(2);
    expect(left.defaultPrevented).toBe(true);
    expect(backspace.defaultPrevented).toBe(true);

    await typeQuery("ab");
    const caretLeft = await press("ArrowLeft");
    const erase = await press("Backspace");
    expect(onBack).toHaveBeenCalledTimes(2);
    expect(caretLeft.defaultPrevented).toBe(false);
    expect(erase.defaultPrevented).toBe(false);
  });

  it("leaves a branch one level per Escape before it closes", async () => {
    // The host owns the path; this one pops a level, as both hosts do.
    const onBack = vi.fn(() => {
      const draft = hostDraft();
      draft.path = draft.path.slice(0, -1);
    });
    const onClose = vi.fn();
    await mountWith({
      items: plainRows(2),
      initialDraft: { path: ["windows", "w-1"] },
      onBack,
      onClose,
    });

    await press("Escape");
    expect(onBack).toHaveBeenCalledTimes(1);
    await press("Escape");
    expect(onBack).toHaveBeenCalledTimes(2);
    expect(onClose).not.toHaveBeenCalled();
    expect(target.querySelector(".deck-shell")).not.toBeNull();

    const last = await press("Escape");
    expect(last.defaultPrevented).toBe(true);
    expect(onBack).toHaveBeenCalledTimes(2);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(target.querySelector(".deck-shell")).toBeNull();
  });

  it("returns from a confirmation card to the list on Escape", async () => {
    const onChoose = vi.fn();
    const onClose = vi.fn();
    await mountWith({
      items: [named("close", "Close", { confirm: confirmation("Sure?") })],
      onChoose,
      onClose,
    });
    await press("Enter");
    expect(target.querySelector(".deck-operation")?.textContent).toContain("Sure?");

    await press("Escape");
    expect(target.querySelector(".deck-operation")).toBeNull();
    expect(activeTitle()).toBe("Close");
    expect(onClose).not.toHaveBeenCalled();
    expect(onChoose).not.toHaveBeenCalled();

    await press("Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("CommandDeck key list", () => {
  const keyList = (): Element | null => target.querySelector(".deck-keys");

  it("shows the keys in place of the rows on ? with an empty query", async () => {
    await mountWith({ items: plainRows(3) });
    const question = await press("?", { shiftKey: true });
    expect(question.defaultPrevented).toBe(true);
    expect(keyList()?.textContent).toContain("Shift+Tab");
    // Every key the list names is one the deck answers.
    const named = [...keyList()!.querySelectorAll("kbd")].map((cap) => cap.textContent);
    expect(named).toEqual([
      "↑", "↓", "PageUp", "PageDown", "Home", "End", "Alt+↑", "Alt+↓",
      "Tab", "Shift+Tab", "Enter", "→", "←", "Backspace", "Esc", "?",
    ]);
    expect(resultRows(), "the rows give way").toHaveLength(0);
    expect(deckInput().hasAttribute("aria-activedescendant")).toBe(false);
    expect(deckInput().value).toBe("");
  });

  it("leaves the key list on any key, which does nothing else", async () => {
    const onChoose = vi.fn();
    const onClose = vi.fn();
    await mountWith({ items: plainRows(3), onChoose, onClose });

    await press("?", { shiftKey: true });
    await press("Shift", { shiftKey: true });
    expect(keyList(), "a modifier going down is not a key press").not.toBeNull();
    const enter = await press("Enter");
    expect(keyList()).toBeNull();
    expect(enter.defaultPrevented).toBe(true);
    expect(onChoose).not.toHaveBeenCalled();

    await press("?");
    await press("ArrowDown");
    expect(keyList()).toBeNull();
    expect(activeTitle(), "the selection did not move").toBe("Row 1");

    await press("?");
    await press("Escape");
    expect(keyList()).toBeNull();
    expect(onClose, "Escape leaves the list, not the deck").not.toHaveBeenCalled();

    await press("?");
    await press("?");
    expect(keyList(), "? closes what it opened").toBeNull();

    await press("?");
    const letter = await press("a");
    expect(keyList()).toBeNull();
    expect(letter.defaultPrevented, "a character is left to the query").toBe(false);
  });

  it("leaves ? to the text once the query holds something", async () => {
    await mountWith({ items: plainRows(3) });
    await typeQuery("what");
    const question = await press("?", { shiftKey: true });
    expect(question.defaultPrevented).toBe(false);
    expect(keyList()).toBeNull();
  });

  it("opens from the footer too", async () => {
    await mountWith({ items: plainRows(3) });
    const toggle = target.querySelector<HTMLButtonElement>(".deck-keys-toggle")!;
    toggle.click();
    await flush();
    expect(keyList()).not.toBeNull();
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    toggle.click();
    await flush();
    expect(keyList()).toBeNull();
  });
});

describe("CommandDeck focus", () => {
  it("focuses the input and selects the query each time it opens", async () => {
    await mountWith({ items: plainRows(2), initialDraft: { query: "split" } });
    const field = deckInput();
    expect(document.activeElement).toBe(field);
    expect(field.value).toBe("split");
    expect([field.selectionStart, field.selectionEnd]).toEqual([0, 5]);

    field.setSelectionRange(5, 5);
    (app.close as () => void)();
    await flush();
    (app.open as () => void)();
    await flush();
    const reopened = deckInput();
    expect(document.activeElement).toBe(reopened);
    expect([reopened.selectionStart, reopened.selectionEnd]).toEqual([0, 5]);
  });

  it("scrolls a restored selection into view as it opens", async () => {
    const scrolled = vi.mocked(Element.prototype.scrollIntoView);
    scrolled.mockClear();
    await mountWith({ items: plainRows(30), initialDraft: { selectedId: "row-22" } });
    expect(activeTitle()).toBe("Row 22");
    expect(scrolled.mock.contexts, "one row is scrolled to").toHaveLength(1);
    expect(scrolled.mock.contexts[0], "the selected one").toBe(rowTitled("Row 22"));
    expect(scrolled).toHaveBeenCalledWith({ block: "nearest" });
  });

  it("opens and moves where elements have no scrollIntoView", async () => {
    const unhandled: unknown[] = [];
    const record = (reason: unknown): void => { unhandled.push(reason); };
    const runner = globalThis as unknown as {
      process: {
        on: (event: "unhandledRejection", listener: (reason: unknown) => void) => void;
        off: (event: "unhandledRejection", listener: (reason: unknown) => void) => void;
      };
    };
    const stub = Element.prototype.scrollIntoView;
    runner.process.on("unhandledRejection", record);
    // jsdom's own shape: the method does not exist.
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    try {
      await mountWith({ items: plainRows(30), initialDraft: { selectedId: "row-22" } });
      await press("ArrowDown");
      expect(activeTitle()).toBe("Row 23");
      // An unhandled rejection is reported only after the promise queue drains.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      Element.prototype.scrollIntoView = stub;
      runner.process.off("unhandledRejection", record);
    }
  });

  it("keeps rows and orbs out of the tab order", async () => {
    await mountWith({ items: plainRows(2), scopes: railScopes(), initialDraft: { scope: "app" } });
    const controls = target.querySelectorAll(
      ".deck-result, .deck-scope, .deck-crumbs-clear, .deck-keys-toggle",
    );
    expect(controls).toHaveLength(7);
    for (const control of controls) expect(control.getAttribute("tabindex")).toBe("-1");
  });

  it("holds focus on the input through a press on a row or an orb", async () => {
    const onChoose = vi.fn();
    await mountWith({ items: plainRows(2), scopes: railScopes(), onChoose });
    const pressDown = (element: Element): MouseEvent => {
      const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
      element.dispatchEvent(event);
      return event;
    };
    expect(pressDown(rowTitled("Row 2")).defaultPrevented, "a row does not take focus").toBe(true);
    expect(pressDown(orb("Terminal")).defaultPrevented, "an orb does not take focus").toBe(true);
    expect(pressDown(deckInput()).defaultPrevented, "the input keeps its own presses").toBe(false);
    const listbox = target.querySelector<HTMLElement>(".deck-results")!;
    expect(pressDown(listbox).defaultPrevented, "the list's own box keeps its scrollbar").toBe(false);
    listbox.focus();
    expect(document.activeElement, "the list hands back the focus a press gave it").toBe(deckInput());

    deckInput().blur();
    expect(document.activeElement).toBe(document.body);
    rowTitled("Row 2").click();
    await flush();
    expect(onChoose).toHaveBeenCalledOnce();
    expect(document.activeElement, "a press on a row hands focus back").toBe(deckInput());

    deckInput().blur();
    orb("Terminal").click();
    await flush();
    expect(document.activeElement, "a press on an orb hands focus back").toBe(deckInput());
  });

  it("leaves a key an input method is composing with to the composition", async () => {
    const onChoose = vi.fn();
    await mountWith({ items: plainRows(2), onChoose });
    const enter = await press("Enter", { isComposing: true });
    await press("ArrowDown", { isComposing: true });
    expect(enter.defaultPrevented).toBe(false);
    expect(onChoose).not.toHaveBeenCalled();
    expect(activeTitle()).toBe("Row 1");
  });

  it("leaves the key that commits a composition to the input method", async () => {
    // WebKit sends the Enter that commits a composition after the composition
    // has ended: not composing any more, and still the input method's key,
    // which it marks with key code 229.
    const onChoose = vi.fn();
    await mountWith({ items: plainRows(2), onChoose });
    const enter = await press("Enter", { keyCode: 229 });
    await press("ArrowDown", { keyCode: 229 });
    expect(enter.defaultPrevented).toBe(false);
    expect(onChoose).not.toHaveBeenCalled();
    expect(activeTitle()).toBe("Row 1");

    await press("Enter", { keyCode: 13 });
    expect(onChoose, "the next Enter is the deck's").toHaveBeenCalledOnce();
  });
});

describe("CommandDeck keyboard hold", () => {
  let origin: HTMLButtonElement;

  beforeEach(() => {
    origin = document.createElement("button");
    document.body.appendChild(origin);
    origin.focus();
  });

  afterEach(() => {
    origin.remove();
    for (const dialog of dialogs.splice(0)) dialog.remove();
  });

  type Grab = "sync" | "microtask" | "tick" | "timer" | "mount";
  const WHEN: Record<Grab, string> = {
    sync: "as the row runs",
    microtask: "in a microtask",
    tick: "after a tick",
    timer: "on a zero-delay timer",
    mount: "as it mounts",
  };

  const surface = (): HTMLTextAreaElement | null => target.querySelector(".stand-in-surface");
  const showSurface = (grab: Grab): void => (app.showSurface as (grab: Grab) => void)(grab);
  const toggle = (): DeckItem => named("prompt", "Rich Prompt", { kind: "toggle" });

  /// Let a zero-delay timer run, then what it scheduled.
  async function settle(): Promise<void> {
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flush();
  }

  /// Send one keydown to the element that holds the keyboard, as a key press
  /// does.
  async function pressFocused(key: string): Promise<KeyboardEvent> {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    (document.activeElement ?? document.body).dispatchEvent(event);
    await settle();
    return event;
  }

  // The dialogs a test raised, taken down after it whatever it asserted, so
  // a failure cannot leave one showing over the tests that follow.
  const dialogs: HTMLElement[] = [];

  function modalDialog(): HTMLElement {
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.append(document.createElement("input"));
    document.body.append(dialog);
    dialogs.push(dialog);
    return dialog;
  }

  for (const grab of ["sync", "microtask", "tick", "timer", "mount"] as const) {
    it(`keeps the keyboard from a surface a row shows, which takes focus ${WHEN[grab]}`, async () => {
      const onChoose = vi.fn(() => showSurface(grab));
      await mountWith({ items: [toggle()], onChoose });
      await pressFocused("Enter");
      expect(onChoose).toHaveBeenCalledOnce();
      expect(surface(), "the surface shows under the deck").not.toBeNull();
      expect(document.activeElement, "the query keeps the keyboard").toBe(deckInput());

      await pressFocused("Enter");
      expect(onChoose, "the next Enter is the deck's").toHaveBeenCalledTimes(2);
      await pressFocused("Escape");
      expect(target.querySelector(".deck-shell"), "and so is Escape").toBeNull();
      expect(document.activeElement, "the close hands the keyboard to what the row showed").toBe(surface());
    });
  }

  it("hands the keyboard to the element it opened from when the surface that asked for it is gone", async () => {
    await mountWith({ items: [toggle()], onChoose: () => showSurface("sync") });
    await pressFocused("Enter");
    (app.hideSurface as () => void)();
    await settle();
    await pressFocused("Escape");
    expect(target.querySelector(".deck-shell")).toBeNull();
    expect(document.activeElement).toBe(origin);
  });

  it("hands the keyboard to the surface when a later row closes the deck and takes no focus", async () => {
    const onChoose = vi.fn((chosen: DeckItem) => {
      if (chosen.id === "prompt") showSurface("sync");
      else (app.close as () => void)();
    });
    await mountWith({ items: [toggle(), named("run", "Run")], onChoose });
    await pressFocused("Enter");
    await pressFocused("ArrowDown");
    await pressFocused("Enter");
    expect(onChoose).toHaveBeenCalledTimes(2);
    expect(target.querySelector(".deck-shell")).toBeNull();
    expect(document.activeElement).toBe(surface());
  });

  it("leaves a modal dialog a row opens the keyboard, and takes it back from what the dialog returns it to", async () => {
    let dialog: HTMLElement | null = null;
    const onChoose = vi.fn(() => {
      dialog = modalDialog();
      dialog.querySelector("input")!.focus();
    });
    await mountWith({ items: [toggle()], onChoose });
    await pressFocused("Enter");
    expect(document.activeElement, "the dialog's field").toBe(dialog!.querySelector("input"));
    const enter = await pressFocused("Enter");
    expect(enter.defaultPrevented, "the dialog keeps its keys").toBe(false);
    expect(onChoose).toHaveBeenCalledOnce();
    dialog!.remove();
    // The dialog hands focus back to the element under the deck it took as
    // its opener.
    origin.focus();
    expect(document.activeElement).toBe(deckInput());
  });

  it("moves no focus while the host says the page may not take it", async () => {
    await mountWith({ items: [toggle()], onChoose: () => showSurface("sync"), mayTakeFocus: () => false });
    await pressFocused("Enter");
    expect(document.activeElement).toBe(surface());
  });

  it("takes a key pressed in an element under it, and the keyboard with it", async () => {
    const onChoose = vi.fn();
    await mountWith({ items: plainRows(2), onChoose });
    // Focus that reached an element while a dialog was up is still there
    // when the dialog goes.
    const dialog = modalDialog();
    origin.focus();
    expect(document.activeElement, "the deck yields while the dialog is up").toBe(origin);
    dialog.remove();

    const letter = await pressFocused("x");
    expect(letter.defaultPrevented, "a character is left to the query").toBe(false);
    expect(document.activeElement, "which now holds the keyboard").toBe(deckInput());

    const again = modalDialog();
    origin.focus();
    again.remove();
    expect(document.activeElement).toBe(origin);
    const enter = await pressFocused("Enter");
    expect(enter.defaultPrevented).toBe(true);
    expect(onChoose).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(deckInput());
  });
});

describe("CommandDeck sections and rows", () => {
  it("groups consecutive rows under a header that names their section and carries their scope's icon", async () => {
    const items = [
      named("recent-a", "New terminal", { section: "Recent", scope: "app" }),
      named("recent-b", "Reload window", { section: "Recent", scope: "window" }),
      named("restart", "Restart terminal", { section: "Terminal", scope: "app" }),
      named("details", "Details", { section: "Terminal", scope: "app" }),
      named("flat", "Split right", { scope: "pane" }),
      named("rename", "Rename terminal", { section: "Terminal", scope: "app" }),
    ];
    await mountWith({ items, scopes: railScopes() });

    const listbox = target.querySelector('[role="listbox"]')!;
    const groups = [...listbox.querySelectorAll('.deck-section[role="group"]')];
    const header = (group: Element): Element => group.querySelector(".deck-section-header")!;
    const titles = (group: Element): (string | null)[] =>
      [...group.querySelectorAll(".deck-result-title")].map((node) => node.textContent);

    expect(groups.map((group) => header(group).querySelector(".deck-section-title")?.textContent)).toEqual([
      "Recent",
      "Terminal",
      "Terminal",
    ]);
    expect(groups.map(titles), "a section holds its consecutive rows only").toEqual([
      ["New terminal", "Reload window"],
      ["Restart terminal", "Details"],
      ["Rename terminal"],
    ]);
    for (const group of groups) {
      expect(header(group).id).not.toBe("");
      expect(group.getAttribute("aria-labelledby")).toBe(header(group).id);
    }
    expect(new Set(groups.map((group) => header(group).id)).size, "each header has its own id").toBe(3);

    expect(header(groups[1]!).querySelector("[data-icon]")?.getAttribute("data-icon")).toBe("app");
    expect(header(groups[0]!).querySelector("[data-icon]"), "rows of two scopes share no icon").toBeNull();

    expect(rowTitled("Split right").parentElement, "a row without a section sits in no group").toBe(listbox);
    expect(listbox.querySelectorAll('[role="option"]')).toHaveLength(items.length);
    expect(
      [...listbox.querySelectorAll('[role="option"]')].map((option) => option.id),
      "options are numbered in list order across sections",
    ).toEqual(items.map((_, index) => `chan-command-deck-option-${index}`));
  });

  it("gives a row a second line for its subtitle, or its breadcrumb when it sits under no section", async () => {
    const items = [
      named("sectioned", "Restart terminal", { section: "Terminal", breadcrumb: "Tab > Terminal" }),
      named("object", "Window 1", { section: "Windows", subtitle: "geekom" }),
      named("typed", "Reload window", { breadcrumb: "Window > Global" }),
      named("refused", "Copy path", { breadcrumb: "Tab > Files", subtitle: "Needs a selection" }),
      named("bare", "Quit", { breadcrumb: "" }),
    ];
    await mountWith({ items });
    const second = (title: string): [string | null, string | null] => [
      rowTitled(title).querySelector(".deck-result-path")?.textContent ?? null,
      rowTitled(title).querySelector(".deck-result-subtitle")?.textContent ?? null,
    ];
    expect(second("Restart terminal"), "a sectioned row is one line").toEqual([null, null]);
    expect(second("Window 1")).toEqual([null, "geekom"]);
    expect(second("Reload window"), "a flat row keeps its breadcrumb").toEqual(["Window > Global", null]);
    expect(second("Copy path"), "a subtitle takes the line").toEqual([null, "Needs a selection"]);
    expect(second("Quit")).toEqual([null, null]);
  });

  it("lays the right column out as value, check, shortcut, chevron", async () => {
    const items = [
      named("all", "Editor body theme", { value: "Dark", checked: true, shortcut: "Ctrl+K", kind: "choice" }),
      named("on", "Details", { kind: "toggle", value: "on" }),
      named("off", "Rich Prompt", { kind: "toggle", value: "off", shortcut: "Ctrl+R" }),
      named("branch", "Windows", { kind: "branch" }),
      named("page", "Window 1", { expandable: true }),
      named("plain", "Reload window"),
    ];
    await mountWith({ items });
    const slots = (title: string): Element[] =>
      [...rowTitled(title).children].filter((cell) => cell.matches(".deck-slot"));
    /// What a row's right column holds, slot by slot, in the order drawn.
    const column = (title: string): string[] =>
      slots(title)
        .map((slot) => {
          const value = slot.querySelector(".deck-result-value");
          const shortcut = slot.querySelector("kbd");
          if (value) return `value:${value.textContent}`;
          if (slot.querySelector(".deck-check")) return "check";
          if (shortcut) return `shortcut:${shortcut.textContent}`;
          return slot.querySelector(".deck-chevron") ? "chevron" : "";
        })
        .filter(Boolean);
    const slotKinds = (title: string): string[] =>
      slots(title).map((slot) =>
        [...slot.classList].find((name) => name.startsWith("deck-slot-")) ?? "",
      );

    for (const item of items) {
      expect(slotKinds(item.title), `${item.title} reserves every slot the list uses, in order`).toEqual([
        "deck-slot-value",
        "deck-slot-check",
        "deck-slot-shortcut",
        "deck-slot-chevron",
      ]);
    }
    expect(column("Editor body theme")).toEqual(["value:Dark", "check", "shortcut:Ctrl+K", "chevron"]);
    expect(column("Details")).toEqual(["value:on"]);
    expect(column("Rich Prompt"), "a row that is not selected shows its shortcut").toEqual([
      "value:off",
      "shortcut:Ctrl+R",
    ]);
    expect(column("Windows")).toEqual(["chevron"]);
    expect(column("Window 1")).toEqual(["chevron"]);
    expect(column("Reload window")).toEqual([]);

    const value = (title: string): Element => rowTitled(title).querySelector(".deck-result-value")!;
    expect(value("Details").classList.contains("on")).toBe(true);
    expect(value("Rich Prompt").classList.contains("on")).toBe(false);
    expect(value("Editor body theme").classList.contains("on")).toBe(false);
    expect(rowTitled("Editor body theme").getAttribute("aria-checked")).toBe("true");
    expect(rowTitled("Details").hasAttribute("aria-checked")).toBe(false);
  });

  it("sizes each slot of the right column once for the list, from its longest entry", async () => {
    const listbox = (): HTMLElement => target.querySelector<HTMLElement>(".deck-results")!;
    const cells = (name: string): string => listbox().style.getPropertyValue(name);
    await mountWith({
      items: [
        named("name", "Rename terminal", { value: "build-watch" }),
        named("details", "Details", { value: "off", shortcut: "Ctrl+I" }),
        named("prompt", "Rich Prompt", { shortcut: "Ctrl+Alt+R" }),
        named("plain", "Restart terminal"),
      ],
    });
    expect(cells("--deck-value-cells"), "build-watch is eleven characters").toBe("11");
    expect(cells("--deck-shortcut-cells"), "Ctrl+Alt+R is ten").toBe("10");
    expect(
      resultRows().map((row) => row.querySelectorAll(".deck-slot").length),
      "no row uses a check or a chevron, so no row reserves one",
    ).toEqual([2, 2, 2, 2]);
    expect(rowTitled("Restart terminal").querySelector(".deck-slot-value")?.textContent?.trim()).toBe("");

    (app.setItems as (items: DeckItem[]) => void)([
      named("long", "Rename terminal", { value: "a-terminal-name-far-too-long-for-a-column" }),
      named("wide", "Details", { shortcut: "\u4e2d" }),
    ]);
    await flush();
    expect(cells("--deck-value-cells"), "a long value is capped and cut short").toBe("24");
    expect(cells("--deck-shortcut-cells"), "a wide character takes two cells").toBe("2");

    (app.setItems as (items: DeckItem[]) => void)(plainRows(2));
    await flush();
    expect(target.querySelector(".deck-slot"), "a list with an empty right column reserves nothing").toBeNull();
  });

  it("marks a destructive row and a disabled one", async () => {
    const items = [
      named("close", "Close window", { danger: true }),
      named("locked", "Turn off", { disabled: true, subtitle: "Session leader only" }),
      named("plain", "Reload window"),
    ];
    await mountWith({ items });
    expect(rowTitled("Close window").classList.contains("danger")).toBe(true);
    expect(rowTitled("Reload window").classList.contains("danger")).toBe(false);
    const locked = rowTitled("Turn off");
    expect(locked.classList.contains("disabled")).toBe(true);
    expect(locked.getAttribute("aria-disabled")).toBe("true");
    expect(locked.disabled).toBe(true);
    expect(rowTitled("Reload window").getAttribute("aria-disabled")).toBe("false");
  });
});

describe("CommandDeck rail, crumbs and footer", () => {
  const crumbTexts = (): (string | null)[] =>
    [...target.querySelectorAll(".deck-crumbs .deck-crumb")].map((node) => node.textContent);
  const footerHint = (key: string): string | null => {
    const hint = [...target.querySelectorAll(".deck-footer .deck-hint")].find(
      (candidate) => candidate.querySelector("kbd")?.textContent === key,
    );
    return hint?.querySelector("span")?.textContent ?? null;
  };

  it("draws an orb per scope with its caption, and an unavailable one inert", async () => {
    const onScope = vi.fn();
    await mountWith({ items: plainRows(2), scopes: railScopes(), onScope });
    expect(
      [...target.querySelectorAll(".deck-scope .deck-scope-caption")].map((node) => node.textContent),
      "the caption, or the label where there is none",
    ).toEqual(["Terminal", "Pane", "Win"]);
    expect(target.querySelectorAll(".deck-scope [data-icon]")).toHaveLength(3);
    expect(orb("Pane").disabled).toBe(true);
    orb("Pane").click();
    await flush();
    expect(onScope).not.toHaveBeenCalled();
    expect(hostDraft().scope).toBeNull();
  });

  it("applies a scope on a press of its orb and clears it on a press of the active one", async () => {
    const onScope = vi.fn();
    const onClearScope = vi.fn();
    await mountWith({ items: plainRows(2), scopes: railScopes(), onScope, onClearScope });

    orb("Window").click();
    await flush();
    expect(onScope).toHaveBeenCalledExactlyOnceWith("window");
    expect(hostDraft().scope).toBe("window");
    expect(orb("Window").classList.contains("active")).toBe(true);
    expect(orb("Window").getAttribute("aria-pressed")).toBe("true");
    expect(orb("Terminal").classList.contains("active")).toBe(false);

    orb("Window").click();
    await flush();
    expect(onClearScope).toHaveBeenCalledTimes(1);
    expect(onScope).toHaveBeenCalledTimes(1);
    expect(hostDraft().scope).toBeNull();
    expect(orb("Window").getAttribute("aria-pressed")).toBe("false");
  });

  it("shows the active scope's label as a chip that clears it", async () => {
    const onClearScope = vi.fn();
    await mountWith({ items: plainRows(2), scopes: railScopes(), onClearScope });
    expect(target.querySelector(".deck-crumbs"), "no chip at the root").toBeNull();

    orb("Window").click();
    await flush();
    expect(crumbTexts(), "the label, not the rail's caption").toEqual(["Window"]);

    target.querySelector<HTMLButtonElement>(".deck-crumbs-clear")!.click();
    await flush();
    expect(onClearScope).toHaveBeenCalledTimes(1);
    expect(hostDraft().scope).toBeNull();
    expect(target.querySelector(".deck-crumbs")).toBeNull();
  });

  it("shows the host's crumbs in place of the scope's label", async () => {
    const onClearScope = vi.fn();
    await mountWith({
      items: plainRows(2),
      scopes: railScopes(),
      crumbs: ["Computers", "geekom", "Windows"],
      initialDraft: { scope: "window", path: ["geekom", "windows"] },
      onClearScope,
    });
    expect(crumbTexts()).toEqual(["Computers", "geekom", "Windows"]);
    expect(
      target.querySelector(".deck-crumbs")?.getAttribute("title"),
      "the whole trail stays readable where the chip cuts it short",
    ).toBe("Computers \u203a geekom \u203a Windows");
    target.querySelector<HTMLButtonElement>(".deck-crumbs-clear")!.click();
    await flush();
    expect(onClearScope).toHaveBeenCalledTimes(1);
  });

  it("shows a plain Search beside the chip and keeps the host's placeholder as the input's name", async () => {
    const shown = (): string | null => target.querySelector(".deck-placeholder")?.textContent ?? null;
    await mountWith({ items: plainRows(2), scopes: railScopes(), placeholder: "Pane" });
    expect(shown(), "with no chip the host's words show").toBe("Pane");
    expect(deckInput().getAttribute("aria-label")).toBe("Pane");

    orb("Window").click();
    await flush();
    expect(crumbTexts()).toEqual(["Window"]);
    expect(shown(), "the chip already names the place").toBe("Search");
    expect(deckInput().getAttribute("aria-label")).toBe("Pane");

    orb("Window").click();
    await flush();
    expect(shown()).toBe("Pane");
  });

  it("reads Escape as back in a branch and as close at the root, and counts the rows", async () => {
    const onBack = vi.fn(() => {
      hostDraft().path = [];
    });
    await mountWith({ items: plainRows(3), initialDraft: { path: ["windows"] }, onBack });
    expect(footerHint("Esc")).toBe("back");
    expect(target.querySelector(".deck-count")?.textContent).toBe("3 items");

    await press("Escape");
    expect(footerHint("Esc")).toBe("close");

    (app.setItems as (items: DeckItem[]) => void)(plainRows(1));
    await flush();
    expect(target.querySelector(".deck-count")?.textContent).toBe("1 item");
  });

  it("names the scope key only where there is a scope to move to", async () => {
    await mountWith({ items: plainRows(2) });
    expect(footerHint("Tab")).toBeNull();
    expect(footerHint("Enter")).toBe("run");
  });

  it("names a card's own keys while one is showing", async () => {
    await mountWith({ items: [named("close", "Close", { confirm: confirmation("Sure?") })] });
    await press("Enter");
    expect(footerHint("Esc")).toBe("cancel");
    expect(target.querySelector(".deck-count"), "a card has no rows to count").toBeNull();
  });
});
