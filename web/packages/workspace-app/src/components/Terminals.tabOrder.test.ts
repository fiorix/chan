// @vitest-environment jsdom
//
// A terminal in a pane that is not the active pane is out of the Tab order:
// its host element and its hidden input read tabindex -1 while their pane
// is not active and 0 once it is, so a Tab walk from the active pane never
// lands in another pane's terminal and types into it. The whole app is
// mounted over the demo workspace with two panes side by side, a terminal
// in each on the real widget (the shared fixture), and pane B active. jsdom
// runs no Tab default, so the Tab order is read from each element's
// tabindex, by the attribute and by `tabIndex`.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../terminal/backend", async (importOriginal) =>
  (await import("../__tests__/ghosttyTab")).ghosttyBackendModule(importOriginal));

import { demoData, mountApp, settle, stubAppEnvironment, unmountApp } from "../__tests__/app";
import { ghosttyHasFocus, seatedGhostty } from "../__tests__/ghosttyTab";
import { resetLayout, terminalTab } from "../__tests__/tabs";
import { layout, setActivePane } from "../state/tabs.svelte";

stubAppEnvironment();

const PANE_A = "pane-a";
const PANE_B = "pane-b";
const TERM_A = "term-a";
const TERM_B = "term-b";

type TabStop = { attribute: string | null; tabIndex: number };
type TerminalStops = { host: TabStop; input: TabStop };

const IN_ORDER: TerminalStops = {
  host: { attribute: "0", tabIndex: 0 },
  input: { attribute: "0", tabIndex: 0 },
};
const OUT_OF_ORDER: TerminalStops = {
  host: { attribute: "-1", tabIndex: -1 },
  input: { attribute: "-1", tabIndex: -1 },
};

beforeEach(async () => {
  await mountApp(demoData([]));
});

afterEach(async () => {
  await unmountApp();
  vi.restoreAllMocks();
});

async function settleLong(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await settle();
    await new Promise((r) => setTimeout(r, 0));
  }
}

function pane(id: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`.pane[data-pane-id="${id}"]`);
  if (!el) throw new Error(`no pane ${id}`);
  return el;
}

function terminalTabElement(id: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-terminal-tab-id="${id}"]`);
  if (!el) throw new Error(`no terminal tab ${id}`);
  return el;
}

/// The terminal's host, the element the widget opens in, and its one
/// hidden input, found in the tab's DOM.
function terminalElements(id: string): { host: HTMLElement; input: HTMLTextAreaElement } {
  const host = terminalTabElement(id).querySelector<HTMLElement>(".terminal-host");
  if (!host) throw new Error(`no terminal host in tab ${id}`);
  const inputs = host.querySelectorAll("textarea");
  expect(inputs, `the terminal of tab ${id} has one input textarea`).toHaveLength(1);
  return { host, input: inputs[0]! };
}

function tabStop(el: HTMLElement): TabStop {
  return { attribute: el.getAttribute("tabindex"), tabIndex: el.tabIndex };
}

function tabStops(id: string): TerminalStops {
  const { host, input } = terminalElements(id);
  return { host: tabStop(host), input: tabStop(input) };
}

/// Whether a browser's Tab walk reaches `el`: an explicit tabindex decides,
/// and without one a textarea and an editing host are tab stops. jsdom
/// reads an editing host's `tabIndex` as -1, where a browser puts it in the
/// Tab order, so the widget's `contenteditable` is named.
function inTabOrder(el: Element): boolean {
  const index = Number.parseInt(el.getAttribute("tabindex") ?? "", 10);
  if (!Number.isNaN(index)) return index >= 0;
  return (el as HTMLElement).tabIndex >= 0 || el.getAttribute("contenteditable") === "true";
}

function setTwoPanes(): void {
  layout.nodes = {
    root: { kind: "split", id: "root", direction: "row", a: PANE_A, b: PANE_B, ratio: 0.5 },
    [PANE_A]: { kind: "leaf", id: PANE_A, tabs: [terminalTab({ id: TERM_A })], activeTabId: TERM_A },
    [PANE_B]: { kind: "leaf", id: PANE_B, tabs: [terminalTab({ id: TERM_B })], activeTabId: TERM_B },
  };
  layout.rootId = "root";
  layout.activePaneId = PANE_B;
}

/// Two panes side by side with a terminal each, pane B active, both
/// terminals open on the widget.
async function twoPanes(): Promise<void> {
  setTwoPanes();
  await settleLong();
  await seatedGhostty(pane(PANE_A));
  await seatedGhostty(pane(PANE_B));
  await settleLong();
  expect(layout.activePaneId, "pane B is the active pane").toBe(PANE_B);
}

/// A primary press and release as a browser runs them for a trusted event:
/// each listener's microtasks run before the press's default action, which
/// focuses the pressed element's nearest focusable ancestor.
async function press(el: HTMLElement): Promise<void> {
  const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 });
  el.dispatchEvent(down);
  await settle();
  if (!down.defaultPrevented) el.closest<HTMLElement>("a[href], [tabindex], button")?.focus();
  el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
  await settleLong();
}

/// A press on the terminal's canvas, the surface a click in a terminal
/// lands on, which bubbles to its pane's own mousedown.
async function pressTerminal(id: string): Promise<void> {
  const canvas = terminalElements(id).host.querySelector<HTMLElement>("canvas");
  if (!canvas) throw new Error(`no canvas in the terminal of tab ${id}`);
  await press(canvas);
}

describe("a terminal in a pane that is not the active pane", () => {
  test("is out of the Tab order while the other pane is active", async () => {
    await twoPanes();
    expect(tabStops(TERM_A), "A's terminal, in the pane that is not active, has its host and input out of the Tab order")
      .toEqual(OUT_OF_ORDER);
    expect(tabStops(TERM_B), "B's terminal, in the active pane, has its host and input in the Tab order")
      .toEqual(IN_ORDER);
  });

  test("a press on it makes its pane active, gives it the keyboard and puts it in the Tab order", async () => {
    await twoPanes();
    const a = await seatedGhostty(pane(PANE_A));
    expect(pane(PANE_A).contains(terminalElements(TERM_A).host), "A's terminal is drawn in pane A").toBe(true);

    await pressTerminal(TERM_A);
    expect(layout.activePaneId, "the press on A's terminal makes pane A the active pane").toBe(PANE_A);
    expect(ghosttyHasFocus(a), "the press gives A's terminal the keyboard").toBe(true);
    expect(tabStops(TERM_A), "A's terminal, now in the active pane, is back in the Tab order").toEqual(IN_ORDER);
    expect(tabStops(TERM_B), "B's terminal, in the pane that is no longer active, leaves the Tab order")
      .toEqual(OUT_OF_ORDER);
  });

  test("a pane switch back to B takes A's terminal out of the Tab order again", async () => {
    await twoPanes();
    await pressTerminal(TERM_A);
    expect(layout.activePaneId, "the press on A's terminal makes pane A the active pane").toBe(PANE_A);

    // The path a keyboard pane switch takes: focusPane ends in it.
    setActivePane(PANE_B);
    await settleLong();
    expect(layout.activePaneId, "pane B is the active pane again").toBe(PANE_B);
    expect(tabStops(TERM_A), "A's terminal, in the pane that is no longer active, leaves the Tab order")
      .toEqual(OUT_OF_ORDER);
    expect(tabStops(TERM_B), "B's terminal, in the active pane again, is back in the Tab order").toEqual(IN_ORDER);
  });

  test("opened while the other pane is active, it is never in the Tab order", async () => {
    // Read at each microtask checkpoint after a change to the page's
    // elements or to a tabindex or contenteditable attribute: the earliest
    // point script sees the change, and before any later task (a key the
    // user presses) can.
    const landings = new Set<string>();
    let openReadings = 0;
    const read = (): void => {
      const host = document.querySelector<HTMLElement>(`[data-terminal-tab-id="${TERM_A}"] .terminal-host`);
      if (!host) return;
      const input = host.querySelector("textarea");
      if (input) openReadings += 1;
      if (inTabOrder(host)) landings.add(`host tabindex=${host.getAttribute("tabindex")}`);
      if (input && inTabOrder(input)) landings.add(`input tabindex=${input.getAttribute("tabindex")}`);
    };
    const observer = new MutationObserver(read);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["tabindex", "contenteditable"],
    });
    try {
      setTwoPanes();
      await settleLong();
      await seatedGhostty(pane(PANE_A));
      await seatedGhostty(pane(PANE_B));
      await settleLong();
    } finally {
      observer.disconnect();
    }
    expect(layout.activePaneId, "pane B stayed the active pane while A's terminal opened").toBe(PANE_B);
    expect(openReadings, "the observer saw A's terminal open").toBeGreaterThan(0);
    expect([...landings], "A's terminal, opened while pane B is active, never puts its host or input in the Tab order")
      .toEqual([]);
  });
});

describe("terminals that keep their Tab order", () => {
  test("a window with one pane has its terminal in the Tab order", async () => {
    resetLayout([terminalTab({ id: "term-solo" })]);
    await settleLong();
    await seatedGhostty(terminalTabElement("term-solo"));
    await settleLong();
    expect(tabStops("term-solo"), "the one pane's terminal has its host and input in the Tab order").toEqual(IN_ORDER);
  });

  test("the active pane's terminal is in the Tab order", async () => {
    await twoPanes();
    expect(tabStops(TERM_B), "B's terminal, in the active pane, has its host and input in the Tab order")
      .toEqual(IN_ORDER);
  });

  test("script focus still reaches a terminal whose host and input are out of the Tab order", async () => {
    // jsdom's focus rule is what this reads: an element with a tabindex
    // attribute of any value is focusable by script, as the HTML rule has
    // it for browsers. The values are set by hand so the mechanism holds
    // whatever writes them.
    await twoPanes();
    const a = await seatedGhostty(pane(PANE_A));
    const { host, input } = terminalElements(TERM_A);
    host.setAttribute("tabindex", "-1");
    input.setAttribute("tabindex", "-1");

    a.focus();
    expect(document.activeElement, "focus() gives the terminal's host the keyboard at tabindex -1").toBe(host);
    input.focus({ preventScroll: true });
    expect(document.activeElement, "the input a press on the canvas focuses takes the keyboard at tabindex -1")
      .toBe(input);
  });
});
