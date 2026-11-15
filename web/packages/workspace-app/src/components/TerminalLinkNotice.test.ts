// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, test } from "vitest";
import TerminalLinkNotice from "./TerminalLinkNotice.svelte";
import TerminalLinkNoticeHarness from "../__tests__/TerminalLinkNoticeHarness.svelte";

const mounted: Array<ReturnType<typeof mount>> = [];
afterEach(() => {
  for (const component of mounted.splice(0)) unmount(component);
  document.body.innerHTML = "";
});

function show(
  stalled: boolean,
  waitMs: number,
  notice = false,
  options: Partial<{ lost: boolean; findOpen: boolean; inspectorOpen: boolean; inspectorWidth: number }> = {},
): HTMLElement {
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(TerminalLinkNotice, { target, props: { stalled, lost: false, notice, waitMs, findOpen: false, inspectorOpen: false, inspectorWidth: 0, ...options } }));
  flushSync();
  return target;
}

describe("terminal link pill", () => {
  test("appears only while stalled and shows the counted ping wait", () => {
    expect(show(false, 8_000).querySelector("[data-terminal-link-pill]")).toBeNull();
    expect(show(true, 8_900).querySelector("[data-terminal-link-pill]")?.textContent).toContain("No response for 8 s. Waiting for the connection.");
  });

  test("takes no pointer or focus and announces a fixed message once", () => {
    const target = show(true, 9_000);
    const strip = target.querySelector<HTMLElement>("[data-terminal-link-pill]")!;
    expect(strip.style.pointerEvents).toBe("none");
    expect(strip.tabIndex).toBe(-1);
    expect(strip.querySelector("button, a, input, textarea, [tabindex]")).toBeNull();
    expect(strip.getAttribute("aria-hidden")).toBe("true");
    expect(target.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(target.querySelector('[role="status"]')?.textContent).toBe("Terminal connection stalled. Waiting for the connection.");
    expect(strip.textContent).toBe("No response for 9 s. Waiting for the connection.");
  });

  test("shows the lost-input sentence through the same fixed live region", () => {
    const target = show(false, 0, true);
    const sentence = "Reconnected. Input typed while disconnected may not have been sent.";
    expect(target.querySelector('[data-terminal-link-pill]')?.textContent?.trim()).toBe(sentence);
    expect(target.querySelector('[role="status"]')?.textContent).toBe(sentence);
  });

  test("shows a fixed connection-lost sentence instead of a stall count", () => {
    const target = show(true, 50_000, false, { lost: true });
    const sentence = "Connection lost. Typing is not being sent until it reconnects.";
    expect(target.querySelector('[data-terminal-link-pill]')?.textContent?.trim()).toBe(sentence);
    expect(target.querySelector('[role="status"]')?.textContent).toBe(sentence);
    expect(target.querySelector('[data-terminal-link-pill]')?.textContent).not.toContain("No response for");
  });

  test("find and inspector props keep the pill below and left of their boxes", () => {
    const plain = show(true, 8_000).querySelector<HTMLElement>('[data-terminal-link-pill]')!;
    expect(plain.style.top).toBe("5px");
    expect(plain.style.right).toBe("5px");
    const moved = show(true, 8_000, false, { findOpen: true, inspectorOpen: true, inspectorWidth: 280 }).querySelector<HTMLElement>('[data-terminal-link-pill]')!;
    expect(moved.style.top).toBe("50px");
    expect(moved.style.right).toBe("309px");
    expect(moved.style.maxWidth).toContain("314px");
  });

  test("keeps one live region mounted while its text appears and the visible count changes", () => {
    const target = document.body.appendChild(document.createElement("div"));
    const component = mount(TerminalLinkNoticeHarness, { target });
    mounted.push(component);
    flushSync();
    const region = target.querySelector<HTMLElement>('[role="status"]')!;
    expect(region).not.toBeNull();
    expect(region!.textContent).toBe("");
    component.show(8_000);
    flushSync();
    expect(target.querySelector('[role="status"]')).toBe(region);
    expect(region.textContent).toBe("Terminal connection stalled. Waiting for the connection.");
    component.count(9_000);
    flushSync();
    expect(target.querySelector('[role="status"]')).toBe(region);
    expect(region.textContent).toBe("Terminal connection stalled. Waiting for the connection.");
    expect(target.querySelector('[data-terminal-link-pill]')?.textContent).toContain("No response for 9 s.");
    component.hide();
    flushSync();
    expect(target.querySelector('[role="status"]')).toBe(region);
    expect(region.textContent).toBe("");
  });

  test("occupies only its top-right text box with opaque theme colours", () => {
    // jsdom computes no layout, so the overlay's positioning is a source contract.
    const source = readFileSync("src/components/TerminalLinkNotice.svelte", "utf8");
    expect(source).toMatch(/\.terminal-link-pill\s*\{[^}]*\bposition:\s*absolute;/);
    expect(source).toMatch(/\.terminal-link-pill\s*\{[^}]*\btop:\s*5px;/);
    expect(source).toMatch(/\.terminal-link-pill\s*\{[^}]*\bright:\s*5px;/);
    expect(source).toMatch(/\.terminal-link-pill\s*\{[^}]*\bwidth:\s*max-content;/);
    expect(source).toMatch(/\.terminal-link-pill\s*\{[^}]*\bmax-width:\s*min\(70%, 36rem\);/);
    expect(source).not.toMatch(/\.terminal-link-pill\s*\{[^}]*\binset:/);
    expect(source).toMatch(/\.terminal-link-pill\s*\{[^}]*\bbackground:\s*var\(--bg-card\);/);
    expect(source).toMatch(/\.terminal-link-pill\s*\{[^}]*\bborder:\s*1px solid var\(--border\);/);
    expect(source).toMatch(/\.terminal-link-pill\s*\{[^}]*\bfont-variant-numeric:\s*tabular-nums;/);
    expect(source).toMatch(/style:top=\{findOpen \? "50px" : "5px"\}/);
    expect(source).toMatch(/style:right=\{inspectorOpen \? `\$\{inspectorWidth \+ 29\}px` : "5px"\}/);
    expect(source).not.toMatch(/\b(?:animation|transition):/);
  });

  test("keeps the permanent status region out of the terminal flex row", () => {
    const source = readFileSync("src/components/TerminalLinkNotice.svelte", "utf8");
    expect(source).toMatch(/\.sr-only\s*\{[^}]*\bposition:\s*absolute;/);
  });
});
