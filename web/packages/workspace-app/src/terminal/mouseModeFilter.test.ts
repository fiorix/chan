// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/terminalTab")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/terminalTab")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/terminalTab")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/terminalTab")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/terminalTab")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/terminalTab")).webglAddonModule());

import TerminalTab from "../components/TerminalTab.svelte";
import type { Preferences } from "../api/types";
import { __testSetStandalonePreferences } from "../state/store.svelte";
import { writeTerminalSnapshot } from "./snapshotCache";
import { MOUSE_MODE_PARAMS, MouseModeFilter } from "./mouseModeFilter";
import {
  attach,
  installTerminalDom,
  mountTerminal,
  output,
  receive,
  resetTerminals,
  seatTerminals,
  terminalTab,
  TerminalSocket,
} from "../__tests__/terminalTab";

installTerminalDom();

// Probe matrix ported from the Item B headless repro (44/44 green): the
// filter must strip DECSET mouse enables byte-exactly, rewrite mixed param
// lists preserving the ORIGINAL param text, hold partial tails across chunk
// boundaries, and pass everything else through verbatim.

const enc = new TextEncoder();
const dec = new TextDecoder();

function feed(filter: MouseModeFilter, s: string): string {
  return dec.decode(filter.push(enc.encode(s)));
}

function filterAll(s: string): string {
  return feed(new MouseModeFilter(), s);
}

describe("MouseModeFilter: whole-sequence drop", () => {
  test("each single mouse param as CSI ? Pm h is dropped", () => {
    for (const p of MOUSE_MODE_PARAMS) {
      expect(filterAll(`\x1b[?${p}h`)).toBe("");
    }
  });

  test("combined all-mouse list (ncurses XM shape) is dropped", () => {
    expect(filterAll("\x1b[?1006;1000h")).toBe("");
    expect(filterAll("\x1b[?1000;1002;1003;1006h")).toBe("");
  });

  test("text before and after a stripped enable is preserved", () => {
    expect(filterAll("before\x1b[?1000hafter")).toBe("beforeafter");
  });
});

describe("MouseModeFilter: mixed-list rewrite", () => {
  test("1049;1000 keeps 1049", () => {
    expect(filterAll("\x1b[?1049;1000h")).toBe("\x1b[?1049h");
  });

  test("multi-mixed keeps every non-mouse param in order", () => {
    expect(filterAll("\x1b[?1000;1049;1002;25h")).toBe("\x1b[?1049;25h");
  });

  test("leading-zero param re-emits its ORIGINAL text", () => {
    expect(filterAll("\x1b[?01049;1000h")).toBe("\x1b[?01049h");
    // A leading-zero MOUSE param still parses into the strip set.
    expect(filterAll("\x1b[?01000h")).toBe("");
  });

  test("oversized (80-digit) param re-emits losslessly", () => {
    const big = "1".repeat(80);
    expect(filterAll(`\x1b[?${big}h`)).toBe(`\x1b[?${big}h`);
    expect(filterAll(`\x1b[?${big};1000h`)).toBe(`\x1b[?${big}h`);
  });
});

describe("MouseModeFilter: pass-through", () => {
  const verbatim = [
    "\x1b[?1000l", // DECRST -- final is 'l', never filtered
    "\x1b[?25l", // cursor hide
    "\x1b[?2004h", // bracketed paste enable (non-mouse DECSET)
    "\x1b[?1049h", // alt screen enable (non-mouse DECSET)
    "\x1b[4h", // SM without '?' prefix
    "\x1b[?1000$p", // DECRQM query (intermediate byte)
    "\x1b[?1000:1h", // colon sub-param breaks the grammar
    "\x1b[?h", // empty DECSET
    "\x1b[31mred\x1b[0m", // SGR + text
    "plain text, no escapes",
  ];
  for (const s of verbatim) {
    test(`${JSON.stringify(s)} passes verbatim`, () => {
      expect(filterAll(s)).toBe(s);
    });
  }

  test("empty push yields empty", () => {
    expect(filterAll("")).toBe("");
  });
});

describe("MouseModeFilter: chunk boundaries (stateful hold)", () => {
  const enable = "\x1b[?1000h";

  test("every split offset of a mouse enable across two feeds strips it", () => {
    for (let split = 1; split < enable.length; split++) {
      const f = new MouseModeFilter();
      const out = feed(f, enable.slice(0, split)) + feed(f, enable.slice(split));
      expect(out, `split at ${split}`).toBe("");
    }
  });

  test("every split offset of a mixed list still rewrites it", () => {
    const mixed = "\x1b[?1049;1000h";
    for (let split = 1; split < mixed.length; split++) {
      const f = new MouseModeFilter();
      const out = feed(f, mixed.slice(0, split)) + feed(f, mixed.slice(split));
      expect(out, `split at ${split}`).toBe("\x1b[?1049h");
    }
  });

  test("three-way split strips the enable", () => {
    const f = new MouseModeFilter();
    const out = feed(f, "\x1b") + feed(f, "[?10") + feed(f, "00h");
    expect(out).toBe("");
  });

  test("text before a held tail flushes immediately", () => {
    const f = new MouseModeFilter();
    expect(feed(f, "hello\x1b[?10")).toBe("hello");
    expect(feed(f, "00h world")).toBe(" world");
  });

  test("held bare ESC resolving to a non-candidate passes through", () => {
    const f = new MouseModeFilter();
    expect(feed(f, "\x1b")).toBe("");
    expect(feed(f, "Xabc")).toBe("\x1bXabc");
  });

  test("reset() drops the held tail", () => {
    const f = new MouseModeFilter();
    expect(feed(f, "\x1b[?10")).toBe("");
    f.reset();
    // Without the held prefix this is plain text, not a sequence tail.
    expect(feed(f, "00h")).toBe("00h");
  });

  test("over-cap partial flushes verbatim (fail-open)", () => {
    const f = new MouseModeFilter();
    // A partial candidate longer than the hold cap (~256): digits with no
    // final byte. Fail-OPEN: the bytes flush untouched, so the worst case
    // is mouse mode enabling -- never corrupted output.
    const oversized = "\x1b[?" + "9".repeat(300);
    expect(feed(f, oversized)).toBe(oversized);
    // The continuation is now plain bytes; nothing was held.
    expect(feed(f, "h")).toBe("h");
  });

  test("under-cap partial is held, not flushed", () => {
    const f = new MouseModeFilter();
    const partial = "\x1b[?" + "9".repeat(100);
    expect(feed(f, partial)).toBe("");
    expect(feed(f, ";1000h")).toBe(`\x1b[?${"9".repeat(100)}h`);
  });
});

describe("MouseModeFilter: throughput sanity", () => {
  test("a 1 MiB plain-text chunk passes through unchanged", () => {
    const big = "a".repeat(1 << 20);
    const f = new MouseModeFilter();
    const input = enc.encode(big);
    const out = f.push(input);
    // Fast path: no ESC and no held state returns the input as-is.
    expect(out).toBe(input);
  });

  test("a 1 MiB chunk with enables at start/middle/end strips exactly those", () => {
    const chunk = "x".repeat(1 << 19);
    const input = `\x1b[?1000h${chunk}\x1b[?1049;1002h${chunk}\x1b[?1006h`;
    expect(filterAll(input)).toBe(`${chunk}\x1b[?1049h${chunk}`);
  });

  test("idempotent on an already-filtered stream", () => {
    const once = filterAll("a\x1b[?1000hb\x1b[?1049;1000hc\x1b[?2004hd");
    expect(filterAll(once)).toBe(once);
  });
});

// A mounted TerminalTab: with mouse capture on (the default, or no setting)
// no filter runs and output reaches xterm byte for byte; with it off, mouse
// enables are stripped from live output and from a restored snapshot, while
// the resume cursor still counts the bytes the server sent.
describe("a mounted terminal's mouse capture setting", () => {
  const ENABLE = "\x1b[?1000h";

  afterEach(() => {
    resetTerminals();
    __testSetStandalonePreferences(null);
    localStorage.clear();
  });

  function serveMouseCapture(on: boolean): void {
    __testSetStandalonePreferences({ terminal: { mouse_capture: on } } as unknown as Preferences);
  }

  async function live() {
    const [tab] = seatTerminals([terminalTab()]);
    const { term } = await mountTerminal(TerminalTab, tab!);
    const socket = TerminalSocket.all.at(-1)!;
    await attach(socket, { id: "sess-1", generation: 2, seq: 10 });
    await receive(socket, { type: "ready", cols: 80, rows: 24 });
    return { term, socket };
  }

  test("on by default: mouse enables reach xterm untouched", async () => {
    const { term, socket } = await live();
    await output(socket, `a${ENABLE}b`);
    expect(term.written.join("")).toContain(`a${ENABLE}b`);
  });

  test("off: mouse enables are stripped from what xterm gets", async () => {
    serveMouseCapture(false);
    const { term, socket } = await live();
    await output(socket, `a${ENABLE}b`);
    expect(term.written.join("")).toContain("ab");
    expect(term.written.join("")).not.toContain(ENABLE);
  });

  test("off: the resume cursor still counts every byte the server sent", async () => {
    serveMouseCapture(false);
    const { socket } = await live();
    await output(socket, `a${ENABLE}b`);
    socket.close();
    await vi.waitFor(() => expect(TerminalSocket.all.length).toBe(2), { timeout: 3000 });
    const query = new URL(TerminalSocket.all[1]!.url, "http://chan.test").searchParams;
    expect(query.get("since")).toBe(String(10 + 2 + ENABLE.length));
  });

  test("off: a restored snapshot is filtered the same way", async () => {
    serveMouseCapture(false);
    writeTerminalSnapshot("sess-1", {
      ansi: `before${ENABLE}after`,
      generation: 2,
      lastSeq: 5,
      cols: 80,
      rows: 24,
      updatedAt: 1,
    });
    const [tab] = seatTerminals([terminalTab({ terminalSessionId: "sess-1" })]);
    const { term } = await mountTerminal(TerminalTab, tab!);
    await attach(TerminalSocket.all.at(-1)!, { id: "sess-1", generation: 2, seq: 5 });
    expect(term.written.join("")).toContain("beforeafter");
    expect(term.written.join("")).not.toContain(ENABLE);
  });
});
