import { describe, expect, test } from "vitest";
import { MOUSE_MODE_PARAMS, MouseModeFilter } from "./mouseModeFilter";
import tab from "../components/TerminalTab.svelte?raw";

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

// Integration pins against the TerminalTab source (?raw, in the style of
// TerminalTab.scrollback.test.ts): with the setting ON (default / absent
// field) NO filter instance exists on the write path, keeping today's
// byte-for-byte behavior; with it off the filter runs INSIDE writePtyOutput
// (never at the ws.onmessage callsite, so receivedSeq counts original
// bytes) and on the snapshot-restore write.
describe("TerminalTab mouse-capture wiring", () => {
  test("setting read is spawn-time with the ?? true fallback; on means no filter", () => {
    expect(tab).toMatch(
      /mouseFilter = \(workspace\.info\?\.preferences\?\.terminal\?\.mouse_capture \?\? true\)\s*\? null\s*: new MouseModeFilter\(\)/,
    );
  });

  test("filter applies inside writePtyOutput, before ptyWrites.write", () => {
    expect(tab).toMatch(
      /if \(mouseFilter\) \{\s*bytes = mouseFilter\.push\(bytes\);\s*if \(bytes\.length === 0\) return;\s*\}[\s\S]*?osc52Bridge\?\.push\(bytes\);\s*ptyWrites\.write\(termWriter, bytes, origin\);/,
    );
  });

  test("receivedSeq counts ORIGINAL frame bytes at the callsite", () => {
    expect(tab).toMatch(
      /writePtyOutput\(bytes, attachPtyWriteOrigin\(\)\);[\s\S]{0,600}?receivedSeq \+= bytes\.length;/,
    );
  });

  test("snapshot restore routes through the same filter", () => {
    expect(tab).toMatch(
      /mouseFilter\.push\(\s*new TextEncoder\(\)\.encode\(pendingSnapshot\.ansi\),?\s*\)/,
    );
  });
});
