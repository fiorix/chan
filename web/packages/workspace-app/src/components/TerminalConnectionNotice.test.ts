// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";
import TerminalConnectionNotice from "./TerminalConnectionNotice.svelte";
import TerminalConnectionNoticeHarness from "../__tests__/TerminalConnectionNoticeHarness.svelte";
import { APP_STATUS_PILL_SELECTOR } from "./terminalNoticePlacement";
import AppStatusBar from "./AppStatusBar.svelte";
import { ui } from "../state/store.svelte";

const SENTENCE = "Reconnected. Input typed while disconnected may not have been sent.";
const mounted: Array<ReturnType<typeof mount>> = [];
afterEach(() => {
  for (const component of mounted.splice(0)) unmount(component);
  document.body.innerHTML = "";
});

function show(
  notice: boolean,
  options: Partial<{ findOpen: boolean; inspectorOpen: boolean; inspectorWidth: number }> = {},
  parent: HTMLElement = document.body,
): HTMLElement {
  const target = document.createElement("div");
  target.className = "terminal-main";
  parent.append(target);
  mounted.push(mount(TerminalConnectionNotice, { target, props: { notice, findOpen: false, inspectorOpen: false, inspectorWidth: 0, ...options } }));
  flushSync();
  return target;
}

describe("terminal connection pill", () => {
  test("appears only while a note is owed and says what may not have been sent", () => {
    expect(show(false).querySelector("[data-terminal-connection-pill]")).toBeNull();
    expect(show(true).querySelector("[data-terminal-connection-pill]")?.textContent?.trim()).toBe(SENTENCE);
  });

  test("takes no pointer or focus and announces its sentence once", () => {
    const target = show(true);
    const pill = target.querySelector<HTMLElement>("[data-terminal-connection-pill]")!;
    expect(pill.style.pointerEvents).toBe("none");
    expect(pill.tabIndex).toBe(-1);
    expect(pill.querySelector("button, a, input, textarea, [tabindex]")).toBeNull();
    expect(pill.getAttribute("aria-hidden")).toBe("true");
    expect(target.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(target.querySelector('[role="status"]')?.textContent).toBe(SENTENCE);
  });

  test("find and inspector props keep the pill below and left of their boxes", () => {
    const plain = show(true).querySelector<HTMLElement>('[data-terminal-connection-pill]')!;
    expect(plain.style.top).toBe("5px");
    expect(plain.style.right).toBe("5px");
    const moved = show(true, { findOpen: true, inspectorOpen: true, inspectorWidth: 280 }).querySelector<HTMLElement>('[data-terminal-connection-pill]')!;
    expect(moved.style.top).toBe("50px");
    expect(moved.style.right).toBe("309px");
    expect(moved.style.maxWidth).toContain("314px");
  });

  test("keeps one live region mounted while its text appears and goes", () => {
    const target = document.body.appendChild(document.createElement("div"));
    const component = mount(TerminalConnectionNoticeHarness, { target });
    mounted.push(component);
    flushSync();
    const region = target.querySelector<HTMLElement>('[role="status"]')!;
    expect(region).not.toBeNull();
    expect(region!.textContent).toBe("");
    component.show();
    flushSync();
    expect(target.querySelector('[role="status"]')).toBe(region);
    expect(region.textContent).toBe(SENTENCE);
    component.hide();
    flushSync();
    expect(target.querySelector('[role="status"]')).toBe(region);
    expect(region.textContent).toBe("");
  });

  test("occupies only its own text box with opaque theme colours", () => {
    // jsdom computes no layout, so the overlay's positioning is a source contract.
    const source = readFileSync("src/components/TerminalConnectionNotice.svelte", "utf8");
    expect(source).toMatch(/\.terminal-connection-pill\s*\{[^}]*\bposition:\s*absolute;/);
    expect(source).toMatch(/\.terminal-connection-pill\s*\{[^}]*\bwidth:\s*max-content;/);
    expect(source).toMatch(/\.terminal-connection-pill\s*\{[^}]*\bmax-width:\s*min\(70%, 36rem\);/);
    expect(source).not.toMatch(/\.terminal-connection-pill\s*\{[^}]*\binset:/);
    expect(source).toMatch(/\.terminal-connection-pill\s*\{[^}]*\bbackground:\s*var\(--bg-card\);/);
    expect(source).toMatch(/\.terminal-connection-pill\s*\{[^}]*\bborder:\s*1px solid var\(--border\);/);
    expect(source).not.toMatch(/\b(?:animation|transition):/);
  });

  test("keeps the permanent status region out of the terminal flex row", () => {
    // The stable live region must take no space in the flex row: it stays absolutely positioned.
    const source = readFileSync("src/components/TerminalConnectionNotice.svelte", "utf8");
    expect(source).toMatch(/\.sr-only\s*\{[^}]*\bposition:\s*absolute;/);
  });
});

describe("terminal connection pill clears the app status pill", () => {
  let frames: FrameRequestCallback[];
  let observers: Array<{ target: Element[]; callback: ResizeObserverCallback }>;
  let paneLeft: number;
  let paneTop: number;
  let statusLeft: number;
  let statusTop: number;
  let statusWidth: number;
  let noticeWidth: number;
  let status: HTMLElement;
  let reads: ReturnType<typeof vi.spyOn>;

  function runFrames(): void {
    for (const frame of frames.splice(0)) frame(0);
    flushSync();
  }

  async function mutations(): Promise<void> {
    await Promise.resolve();
    runFrames();
  }

  function pill(target: HTMLElement): HTMLElement {
    return target.querySelector<HTMLElement>("[data-terminal-connection-pill]")!;
  }

  function setup(): void {
    frames = [];
    observers = [];
    paneLeft = 1283;
    paneTop = 33;
    statusLeft = 1447;
    statusTop = 48;
    statusWidth = 140;
    noticeWidth = 307;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    vi.stubGlobal("ResizeObserver", class {
      target: Element[] = [];
      callback: ResizeObserverCallback;
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
        observers.push(this);
      }
      observe(target: Element) { this.target.push(target); }
      unobserve(target: Element) { this.target = this.target.filter((item) => item !== target); }
      disconnect() { this.target = []; }
    });
    reads = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.matches(APP_STATUS_PILL_SELECTOR)) return new DOMRect(statusLeft, statusTop, statusWidth, 30);
      if (this.matches("[data-terminal-connection-pill]")) return new DOMRect(paneLeft + 312 - noticeWidth - (Number.parseFloat(this.style.right) - 5), paneTop + Number.parseFloat(this.style.top), noticeWidth, 28);
      return new DOMRect();
    });
    status = document.createElement("div");
    status.setAttribute("data-app-status-pill", "");
    status.textContent = "indexing 1 file";
    document.body.append(status);
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    ui.status = null;
  });

  test("the app's status pill carries the selector the pill finds it by", () => {
    ui.status = "saved";
    const target = document.body.appendChild(document.createElement("div"));
    mounted.push(mount(AppStatusBar, { target }));
    flushSync();
    expect(target.querySelector(APP_STATUS_PILL_SELECTOR)?.classList.contains("app-statusbar")).toBe(true);
  });

  test("drops below an overlapping app status pill and returns when it goes", async () => {
    setup();
    const target = show(true);
    expect(pill(target).style.top).toBe("50px");
    status.remove();
    await mutations();
    expect(pill(target).style.top).toBe("5px");
  });

  test("follows a status pill that grows into the notice while it is shown", () => {
    setup();
    statusLeft = 1595;
    statusWidth = 0;
    const target = show(true);
    expect(pill(target).style.top).toBe("5px");
    statusLeft = 1447;
    statusWidth = 140;
    const observer = observers.find((item) => item.target.includes(status));
    expect(observer).toBeDefined();
    observer?.callback([], observer as unknown as ResizeObserver);
    runFrames();
    expect(pill(target).style.top).toBe("50px");
  });

  test("follows a newly mounted status pill", async () => {
    setup();
    status.remove();
    const target = show(true);
    expect(pill(target).style.top).toBe("5px");
    document.body.append(status);
    await mutations();
    expect(pill(target).style.top).toBe("50px");
  });

  test("follows a status pill moving without changing size", async () => {
    setup();
    const target = show(true);
    expect(pill(target).style.top).toBe("50px");
    statusTop = 90;
    status.style.top = "90px";
    await mutations();
    expect(pill(target).style.top).toBe("5px");
  });

  test("follows the notice's own width", () => {
    setup();
    statusLeft = 1280;
    statusWidth = 120;
    noticeWidth = 100;
    const target = show(true);
    expect(pill(target).style.top).toBe("5px");
    noticeWidth = 307;
    const observer = observers.find((item) => item.target.includes(pill(target)));
    expect(observer).toBeDefined();
    observer?.callback([], observer as unknown as ResizeObserver);
    runFrames();
    expect(pill(target).style.top).toBe("50px");
  });

  test("follows a pane moving without changing size", async () => {
    setup();
    const ancestor = document.body.appendChild(document.createElement("div"));
    const target = show(true, {}, ancestor);
    expect(pill(target).style.top).toBe("50px");
    expect(frames).toHaveLength(0);
    paneLeft = 800;
    ancestor.style.left = "800px";
    await mutations();
    expect(pill(target).style.top).toBe("5px");
  });

  test("follows a terminal main style change without changing size", async () => {
    setup();
    const target = show(true);
    expect(pill(target).style.top).toBe("50px");
    paneLeft = 800;
    target.style.left = "800px";
    await mutations();
    expect(pill(target).style.top).toBe("5px");
  });

  test("ignores style mutations inside the terminal main", async () => {
    setup();
    const target = show(true);
    expect(frames).toHaveLength(0);
    pill(target).style.color = "red";
    await Promise.resolve();
    expect(frames).toHaveLength(0);
  });

  test("does not measure for a text-only status change of unchanged size", async () => {
    setup();
    show(true);
    const before = reads.mock.calls.length;
    status.firstChild!.textContent = "indexing 2 files";
    await Promise.resolve();
    expect(frames).toHaveLength(0);
    expect(reads).toHaveBeenCalledTimes(before);
  });

  test("measures inspector width changes without rebuilding observers or the resize listener", () => {
    setup();
    const mutationObserve = vi.spyOn(MutationObserver.prototype, "observe");
    const addListener = vi.spyOn(window, "addEventListener");
    const target = document.body.appendChild(document.createElement("div"));
    target.className = "terminal-main";
    const component = mount(TerminalConnectionNoticeHarness, { target });
    mounted.push(component);
    flushSync();
    component.show();
    component.inspect(true);
    flushSync();
    const observerCount = observers.length;
    const bodyObserveCount = mutationObserve.mock.calls.filter(([node]) => node === document.body).length;
    const resizeListenerCount = addListener.mock.calls.filter(([type]) => type === "resize").length;
    const before = reads.mock.calls.length;
    component.width(320);
    flushSync();
    expect(pill(target).style.right).toBe("349px");
    expect(reads.mock.calls.length).toBeGreaterThan(before);
    expect(observers).toHaveLength(observerCount);
    expect(mutationObserve.mock.calls.filter(([node]) => node === document.body)).toHaveLength(bodyObserveCount);
    expect(addListener.mock.calls.filter(([type]) => type === "resize")).toHaveLength(resizeListenerCount);
  });

  test("rechecks the default place when find or inspector opens", () => {
    setup();
    statusTop = 93;
    const target = document.body.appendChild(document.createElement("div"));
    target.className = "terminal-main";
    const component = mount(TerminalConnectionNoticeHarness, { target });
    mounted.push(component);
    flushSync();
    component.show();
    flushSync();
    expect(pill(target).style.top).toBe("5px");
    component.find(true);
    flushSync();
    expect(pill(target).style.top).toBe("95px");
    component.inspect(true);
    flushSync();
    expect(pill(target).style.top).toBe("50px");
  });

  test("rechecks the boxes after a window resize moves the pane", () => {
    setup();
    const target = show(true);
    expect(pill(target).style.top).toBe("50px");
    paneLeft = 800;
    window.dispatchEvent(new Event("resize"));
    runFrames();
    expect(pill(target).style.top).toBe("5px");
  });

  test("does not observe or measure while the notice is absent", () => {
    setup();
    const mutationObserve = vi.spyOn(MutationObserver.prototype, "observe");
    const addListener = vi.spyOn(window, "addEventListener");
    const target = show(false);
    expect(pill(target)).toBeNull();
    expect(observers).toHaveLength(0);
    expect(mutationObserve.mock.calls.filter(([node]) => node === document.body)).toHaveLength(0);
    expect(addListener.mock.calls.filter(([type]) => type === "resize")).toHaveLength(0);
    expect(reads).not.toHaveBeenCalled();
    expect(frames).toHaveLength(0);
  });

  test("stops observing and responding to resize after the pill hides", async () => {
    setup();
    const target = document.body.appendChild(document.createElement("div"));
    target.className = "terminal-main";
    const component = mount(TerminalConnectionNoticeHarness, { target });
    mounted.push(component);
    flushSync();
    component.show();
    flushSync();
    component.hide();
    flushSync();
    expect(observers.every((observer) => observer.target.length === 0)).toBe(true);
    const before = reads.mock.calls.length;
    status.style.left = "1400px";
    await Promise.resolve();
    expect(frames).toHaveLength(0);
    window.dispatchEvent(new Event("resize"));
    expect(frames).toHaveLength(0);
    expect(reads).toHaveBeenCalledTimes(before);
  });

  test("stops observing and responding to resize after unmount", async () => {
    setup();
    const target = show(true);
    expect(pill(target).style.top).toBe("50px");
    unmount(mounted.pop()!);
    expect(observers.every((observer) => observer.target.length === 0)).toBe(true);
    const before = reads.mock.calls.length;
    status.style.left = "1400px";
    await Promise.resolve();
    expect(frames).toHaveLength(0);
    window.dispatchEvent(new Event("resize"));
    expect(frames).toHaveLength(0);
    expect(reads).toHaveBeenCalledTimes(before);
  });
});
