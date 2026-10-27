// The corner notice cards: source chip rendering, error-vs-info announcement
// roles, expand-on-click to the full message, and Dismiss.

import { describe, it, expect, afterEach, vi } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import { exactStamp } from "@chan/web-shared/relative-time";
import NoticeBubbles from "./NoticeBubbles.svelte";
import { pushNotice, pushLocalError, clearNotices, type Notice } from "../state/notices.svelte";

let target: HTMLElement | null = null;
let app: Record<string, unknown> | null = null;

function mountBubbles(): void {
  target = document.createElement("div");
  document.body.appendChild(target);
  app = mount(NoticeBubbles, { target });
}

function gatewayNotice(over: Partial<Notice> = {}): Notice {
  return {
    id: "ntc-9f3a",
    kind: "error",
    source: { type: "gateway", id: "gw-1a2b3c4d", label: "gw.chan.app" },
    title: "Gateway unreachable",
    message: "the roster poll failed three times; keeping the last-known devservers",
    at: 1,
    ...over,
  };
}

afterEach(() => {
  if (app) unmount(app);
  target?.remove();
  target = null;
  app = null;
  clearNotices();
  vi.useRealTimers();
});

describe("NoticeBubbles", () => {
  it("shows the source chip, title, and announcement role per kind", () => {
    mountBubbles();
    pushNotice(gatewayNotice());
    pushNotice(
      gatewayNotice({
        id: "ntc-77aa",
        kind: "info",
        source: { type: "devserver", id: "abc", label: "laptop" },
        title: "Devserver migrated",
      }),
    );
    flushSync();

    const bubbles = [...target!.querySelectorAll(".notice-bubble")];
    expect(bubbles).toHaveLength(2);
    expect(bubbles[0].getAttribute("role")).toBe("alert");
    expect(bubbles[0].textContent).toContain("gateway gw.chan.app");
    expect(bubbles[0].textContent).toContain("Gateway unreachable");
    expect(bubbles[1].getAttribute("role")).toBe("status");
    expect(bubbles[1].textContent).toContain("devserver laptop");
  });

  it("a local error renders without a source chip", () => {
    mountBubbles();
    pushLocalError("boom");
    flushSync();

    const bubble = target!.querySelector(".notice-bubble")!;
    expect(bubble.querySelector(".nb-source")).toBeNull();
    expect(bubble.textContent).toContain("Error");
    expect(bubble.textContent).toContain("boom");
  });

  it("expands on click to the full message and collapses back", () => {
    mountBubbles();
    pushNotice(gatewayNotice());
    flushSync();

    const body = target!.querySelector(".nb-body") as HTMLButtonElement;
    expect(body.getAttribute("aria-expanded")).toBe("false");
    body.click();
    flushSync();
    expect(body.getAttribute("aria-expanded")).toBe("true");
    expect(target!.querySelector(".nb-message.expanded")).not.toBeNull();
    body.click();
    flushSync();
    expect(body.getAttribute("aria-expanded")).toBe("false");
  });

  it("Dismiss removes the bubble", () => {
    mountBubbles();
    pushNotice(gatewayNotice());
    flushSync();

    (target!.querySelector('button[aria-label="Dismiss"]') as HTMLButtonElement).click();
    flushSync();
    expect(target!.querySelector(".notice-bubble")).toBeNull();
  });

  it("shows the event's age and exact stamp in the head", () => {
    vi.useFakeTimers();
    const now = Date.UTC(2026, 0, 10, 12);
    vi.setSystemTime(now);
    const at = now - 5 * 60_000;
    mountBubbles();
    pushNotice(gatewayNotice({ at }));
    flushSync();

    const time = target!.querySelector(".nb-head time")!;
    expect(time.textContent).toBe("5 minutes ago");
    expect(time.getAttribute("datetime")).toBe(new Date(at).toISOString());
    expect(time.getAttribute("title")).toBe(exactStamp(at));
  });

  it("updates the age each minute and stops the clock when the ring empties", () => {
    vi.useFakeTimers();
    const now = Date.UTC(2026, 0, 10, 12);
    vi.setSystemTime(now);
    mountBubbles();
    pushNotice(gatewayNotice({ at: now }));
    flushSync();

    const time = target!.querySelector(".nb-head time")!;
    expect(time.textContent).toBe("just now");
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(60_000);
    flushSync();
    expect(time.textContent).toBe("1 minute ago");
    (target!.querySelector('button[aria-label="Dismiss"]') as HTMLButtonElement).click();
    flushSync();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("refreshes at the 30-second tick when an age crosses one minute", () => {
    vi.useFakeTimers();
    const now = Date.UTC(2026, 0, 10, 12);
    vi.setSystemTime(now);
    mountBubbles();
    pushNotice(gatewayNotice({ at: now - 30_000 }));
    flushSync();

    const time = target!.querySelector(".nb-head time")!;
    expect(time.textContent).toBe("just now");
    vi.advanceTimersByTime(30_000);
    flushSync();
    expect(time.textContent).toBe("1 minute ago");
  });

  it("shows a day-old age and the exact stamp as expanded text", () => {
    vi.useFakeTimers();
    const now = Date.UTC(2026, 0, 10, 12);
    vi.setSystemTime(now);
    const at = now - 24 * 60 * 60_000;
    mountBubbles();
    pushNotice(gatewayNotice({ at }));
    flushSync();

    expect(target!.querySelector(".nb-head time")?.textContent).toBe("1 day ago");
    (target!.querySelector(".nb-body") as HTMLButtonElement).click();
    flushSync();
    expect(target!.querySelector(".nb-stamp")?.textContent).toBe(exactStamp(at));
  });

  it("shows the event date beyond a week", () => {
    vi.useFakeTimers();
    const now = Date.UTC(2026, 0, 10, 12);
    vi.setSystemTime(now);
    mountBubbles();
    pushNotice(gatewayNotice({ at: now - 8 * 24 * 60 * 60_000 }));
    flushSync();
    expect(target!.querySelector(".nb-head time")?.textContent).toBe("2026-01-02");
  });
});
