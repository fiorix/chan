// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, test } from "vitest";
import TerminalStallStrip from "./TerminalStallStrip.svelte";
import TerminalStallStripHarness from "../__tests__/TerminalStallStripHarness.svelte";

const mounted: Array<ReturnType<typeof mount>> = [];
afterEach(() => {
  for (const component of mounted.splice(0)) unmount(component);
  document.body.innerHTML = "";
});

function show(visible: boolean, waitMs: number): HTMLElement {
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(TerminalStallStrip, { target, props: { visible, waitMs } }));
  flushSync();
  return target;
}

describe("terminal stall strip", () => {
  test("appears only while stalled and shows the counted ping wait", () => {
    expect(show(false, 8_000).querySelector("[data-terminal-stall-strip]")).toBeNull();
    expect(show(true, 8_900).querySelector("[data-terminal-stall-strip]")?.textContent).toContain("No response for 8 s. Waiting for the connection.");
  });

  test("takes no pointer or focus and announces a fixed message once", () => {
    const target = show(true, 9_000);
    const strip = target.querySelector<HTMLElement>("[data-terminal-stall-strip]")!;
    expect(strip.style.pointerEvents).toBe("none");
    expect(strip.tabIndex).toBe(-1);
    expect(strip.querySelector("button, a, input, textarea, [tabindex]")).toBeNull();
    expect(strip.getAttribute("aria-hidden")).toBe("true");
    expect(target.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(target.querySelector('[role="status"]')?.textContent).toBe("Terminal connection stalled. Waiting for the connection.");
    expect(strip.textContent).toBe("No response for 9 s. Waiting for the connection.");
  });

  test("keeps one live region mounted while its text appears and the visible count changes", () => {
    const target = document.body.appendChild(document.createElement("div"));
    const component = mount(TerminalStallStripHarness, { target });
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
    expect(target.querySelector('[data-terminal-stall-strip]')?.textContent).toContain("No response for 9 s.");
    component.hide();
    flushSync();
    expect(target.querySelector('[role="status"]')).toBe(region);
    expect(region.textContent).toBe("");
  });

  test("overlays the host without taking layout space", () => {
    // jsdom computes no layout, so the overlay's positioning is a source contract.
    const source = readFileSync("src/components/TerminalStallStrip.svelte", "utf8");
    expect(source).toMatch(/\.terminal-stall-strip\s*\{[^}]*\bposition:\s*absolute;/);
    expect(source).toMatch(/\.terminal-stall-strip\s*\{[^}]*\btext-align:\s*left;/);
  });

  test("keeps the permanent status region out of the terminal flex row", () => {
    const source = readFileSync("src/components/TerminalStallStrip.svelte", "utf8");
    expect(source).toMatch(/\.sr-only\s*\{[^}]*\bposition:\s*absolute;/);
  });
});
