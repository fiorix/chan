import { describe, expect, test } from "vitest";
import tabs from "../state/tabs.svelte.ts?raw";
import terminalTab from "./TerminalTab.svelte?raw";
import fileEditorTab from "./FileEditorTab.svelte?raw";
import pane from "./Pane.svelte?raw";
import source from "../editor/Source.svelte?raw";
import wysiwyg from "../editor/Wysiwyg.svelte?raw";

function sourceBetween(startMarker: string, endMarker: string): string {
  const start = tabs.indexOf(startMarker);
  const end = tabs.indexOf(endMarker, start + startMarker.length);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return tabs.slice(start, end);
}

// Chord-driven tab switch (Cmd+Shift+[/], Ctrl+Alt+1..9) must
// move keyboard focus to the new tab so keystrokes go to the
// correct surface. The `tabFocusPulse` $state mechanism drives
// this: helpers bump the pulse, and each tab-kind component
// re-focuses its surface in a $effect that tracks it.
// `bumpTabFocusPulse` also blurs the current element so the
// prior contenteditable releases DOM focus before the new
// tab's focus call lands.

describe("tabFocusPulse mechanism", () => {
  test("tabFocusPulse exported from tabs.svelte.ts", () => {
    expect(tabs).toMatch(/export const tabFocusPulse = \$state\(\{ value: 0 \}\);/);
  });

  test("bumpTabFocusPulse increments the pulse + blurs the prior focus", () => {
    expect(tabs).toMatch(
      /function bumpTabFocusPulse\(\): void \{[\s\S]*?tabFocusPulse\.value \+= 1;[\s\S]*?if \(typeof document === "undefined"\) return;[\s\S]*?const el = document\.activeElement;[\s\S]*?el\.blur\(\);/,
    );
  });

  test("selectPrevTabInActivePane bumps the pulse after mutating activeTabId", () => {
    const selector = sourceBetween(
      "export function selectPrevTabInActivePane",
      "export function selectNextTabInActivePane",
    );
    expect(selector).toMatch(
      /export function selectPrevTabInActivePane\(\): void \{[\s\S]*?const side = paneSide\(p\);[\s\S]*?const tabs = paneTabOrder\(p\);[\s\S]*?setPaneActiveTabId\(p, target\.tab\.id, target\.side\);[\s\S]*?p\.side = target\.side;[\s\S]*?bumpTabFocusPulse\(\);/,
    );
  });

  test("selectNextTabInActivePane bumps the pulse after selecting and flipping", () => {
    const selector = sourceBetween(
      "export function selectNextTabInActivePane",
      "export function selectTabAtIndexInActivePane",
    );
    expect(selector).toMatch(
      /export function selectNextTabInActivePane\(\): void \{[\s\S]*?const side = paneSide\(p\);[\s\S]*?const tabs = paneTabOrder\(p\);[\s\S]*?setPaneActiveTabId\(p, target\.tab\.id, target\.side\);[\s\S]*?p\.side = target\.side;[\s\S]*?bumpTabFocusPulse\(\);/,
    );
  });

  test("selectTabAtIndexInActivePane bumps the pulse", () => {
    expect(tabs).toMatch(
      /export function selectTabAtIndexInActivePane\(index: number\): void \{[\s\S]*?const side = paneSide\(p\);[\s\S]*?const tabs = paneTabs\(p, side\);[\s\S]*?setPaneActiveTabId\(p, tabs\[index\]\.id, side\);[\s\S]*?bumpTabFocusPulse\(\);/,
    );
  });
});

// `cs open {path}` and File-Browser opens both route through openInPane.
// Like a tab switch, activating the file tab isn't enough on its own: the
// editor's focus effect only grabs the live ref on a pulse, and the prior
// terminal's xterm keeps DOM focus until something blurs it. openInPane must
// bump the pulse on every activation path, and TerminalTab must blur when it
// stops being focused.
describe("openInPane moves focus to the opened editor", () => {
  test("new-tab path bumps the pulse after activating", () => {
    expect(tabs).toMatch(
      /export async function openInPane\([\s\S]*?tabs\.push\(newTab\);[\s\S]*?setPaneActiveTabId\(p, newTab\.id, side\);[\s\S]*?p\.side = side;[\s\S]*?bumpTabFocusPulse\(\);/,
    );
  });

  test("existing-tab path bumps the pulse after activating", () => {
    expect(tabs).toMatch(
      /export async function openInPane\([\s\S]*?setPaneActiveTabId\(p, existing\.id, side\);[\s\S]*?p\.side = side;[\s\S]*?bumpTabFocusPulse\(\);/,
    );
  });

  test("TerminalTab blurs the xterm when it loses focus", () => {
    expect(terminalTab).toMatch(
      /\$effect\(\(\) => \{[\s\S]*?if \(focused\) return;[\s\S]*?term\?\.blur\(\);/,
    );
  });
});

describe("tab header click refocuses input-capable tabs", () => {
  test("Pane imports bumpTabFocusPulse for tab-strip clicks", () => {
    expect(pane).toMatch(/import \{[\s\S]*?\bbumpTabFocusPulse,[\s\S]*?\} from "\.\.\/state\/tabs\.svelte";/);
  });

  test("terminal/editor tab mousedown selects the tab then pulses content focus", () => {
    expect(pane).toMatch(
      /onmousedown=\{\(\) => \{[\s\S]*?selectTabInPane\(pane\.id, t\.id\);[\s\S]*?if \(t\.kind === "terminal"\) setTerminalActivity\(t, false\);[\s\S]*?if \(t\.kind === "terminal" \|\| t\.kind === "file"\) bumpTabFocusPulse\(\);/,
    );
  });

  test("tab mouseup re-pulses so the focus call outlives the mousedown default action", () => {
    // The mousedown pulse alone is not enough: the browser's mousedown
    // DEFAULT ACTION focuses the tabindex="0" .tab div AFTER the
    // pulse's queueMicrotask focus ran (microtask checkpoints run
    // between listeners, before the default action), so a clicked
    // terminal tab activated without keyboard focus landing in xterm.
    // The left-button mouseup re-pulse runs after focus settled on the
    // tab, making the content-focus microtask the last word.
    expect(pane).toMatch(
      /onmouseup=\{\(e\) => \{[\s\S]*?if \(e\.button !== 0\) return;[\s\S]*?if \(t\.kind === "terminal" \|\| t\.kind === "file"\) bumpTabFocusPulse\(\);/,
    );
  });
});

describe("TerminalTab reacts to pulse", () => {
  test("TerminalTab imports tabFocusPulse", () => {
    expect(terminalTab).toMatch(/tabFocusPulse,/);
  });

  test("focus effect reads tabFocusPulse.value so chord switches re-focus xterm", () => {
    expect(terminalTab).toMatch(
      /\$effect\(\(\) => \{[\s\S]*?if \(!focused\) return;[\s\S]*?tabFocusPulse\.value;[\s\S]*?term\?\.focus\(\);/,
    );
  });
});

describe("FileEditorTab reacts to pulse", () => {
  test("FileEditorTab imports tabFocusPulse", () => {
    expect(fileEditorTab).toMatch(/tabFocusPulse,/);
  });

  test("focus effect routes to the live editor ref (Wysiwyg vs Source) on pulse", () => {
    expect(fileEditorTab).toMatch(
      /\$effect\(\(\) => \{[\s\S]*?tabFocusPulse\.value;[\s\S]*?queueMicrotask\([\s\S]*?if \(tab\.mode === "wysiwyg"\) wysiwygRef\?\.focus\(\);[\s\S]*?else sourceRef\?\.focus\(\);/,
    );
  });
});

describe("editor refs expose focus", () => {
  test("Source.svelte exports focus()", () => {
    expect(source).toMatch(
      /export function focus\(\): boolean \{[\s\S]*?if \(!view\) return false;[\s\S]*?view\.focus\(\);[\s\S]*?return true;/,
    );
  });

  test("Wysiwyg.svelte exports focus()", () => {
    expect(wysiwyg).toMatch(
      /export function focus\(\): boolean \{[\s\S]*?if \(!view\) return false;[\s\S]*?view\.focus\(\);[\s\S]*?return true;/,
    );
  });
});
