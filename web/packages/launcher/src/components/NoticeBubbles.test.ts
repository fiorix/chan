// The corner notice cards: source chip rendering, error-vs-info announcement
// roles, expand-on-click to the full message, and Dismiss.

import { describe, it, expect, afterEach } from "vitest";
import { mount, unmount, flushSync } from "svelte";
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
});
