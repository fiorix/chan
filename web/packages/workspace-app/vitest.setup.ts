// Environment shims for the vitest jsdom runs.
//
// A newer Node ships storage globals of its own, and they take precedence
// over the ones vitest's jsdom environment installs. Node 24+ has a built-in
// `localStorage`: an accessor on `globalThis` that yields `undefined` unless
// the process gets `--localstorage-file`, so every test that drives a
// persistence seam reads `undefined` and dies in its own `beforeEach`. Node
// 26 also has a built-in `sessionStorage` that works, but it is an instance
// of Node's own `Storage` class while the global `Storage` is still the
// page's: a spy on `Storage.prototype` then sees none of its writes, an
// assertion that something was written fails, and one that nothing was
// written passes without looking.
//
// CI runs the Node major the root `.nvmrc` declares; while that is below 24
// this only bites a local run on a newer Node, which is the worst shape for a
// gate: the pre-push run disagrees with the run that decides the merge. Put
// the page's own stores back wherever the environment has them, and install
// a Storage where it has none, so the suite reads the same under every Node
// the gate runs on.
//
// The second shim ends each file's timers with its page, and the guard at
// the end fails a test whose mounted terminal could not initialize.

import { afterAll, afterEach, expect } from "vitest";

import { takeUnroutedStandIns, XtermStandInRequested } from "./src/__tests__/xterm";
import { trackTimers } from "./src/demo/timers";

/// The Storage surface the SPA actually uses: `getItem`, `setItem`,
/// `removeItem`, `clear`, `length`, and `key`. Insertion order carries the
/// `key(index)` ordering, matching what browsers and jsdom do for a store that
/// was only ever written through `setItem`.
class MemoryStorage implements Storage {
  #entries = new Map<string, string>();

  get length(): number {
    return this.#entries.size;
  }

  key(index: number): string | null {
    if (!Number.isInteger(index) || index < 0) return null;
    return [...this.#entries.keys()][index] ?? null;
  }

  getItem(key: string): string | null {
    return this.#entries.get(String(key)) ?? null;
  }

  setItem(key: string, value: string): void {
    this.#entries.set(String(key), String(value));
  }

  removeItem(key: string): void {
    this.#entries.delete(String(key));
  }

  clear(): void {
    this.#entries.clear();
  }

  [name: string]: unknown;
}

function storageIsUsable(candidate: unknown): boolean {
  if (!candidate || typeof candidate !== "object") return false;
  const storage = candidate as Partial<Storage>;
  return typeof storage.getItem === "function" && typeof storage.setItem === "function";
}

type StorageName = "localStorage" | "sessionStorage";

/// The jsdom page's own store, when the test runs in a jsdom environment
/// whose origin has one.
function pageStorage(name: StorageName): Storage | undefined {
  try {
    const page = (globalThis as { jsdom?: { window: Window } }).jsdom?.window;
    const storage = page?.[name];
    return storageIsUsable(storage) ? storage : undefined;
  } catch {
    // An opaque origin has no storage, and jsdom throws on the read.
    return undefined;
  }
}

for (const name of ["localStorage", "sessionStorage"] as const) {
  const page = pageStorage(name);
  if (page ? globalThis[name] === page : storageIsUsable(globalThis[name])) {
    continue;
  }
  Object.defineProperty(globalThis, name, {
    value: page ?? new MemoryStorage(),
    configurable: true,
    enumerable: false,
    writable: true,
  });
}

// A page's timers end with the page, and the jsdom environment's do not: it
// leaves Node's timers in place, so a debounce, a retry or a poll a module
// armed for the file's page is still pending when the environment's teardown
// removes `window`, and the worker runs on until the pool stops it. One that
// comes due in that gap runs against no window and fails the run with every
// test passing. End what the file left armed once its last hook has run, as a
// browser does when the page goes. Under vitest's default `stack` hook order
// a setup file's `afterAll` runs after the file's own, so the file's
// teardowns still find their timers.
const fileTimers = trackTimers();
afterAll(() => {
  fileTimers.release();
  failOnTerminalInitFailures();
});

// TerminalTab reports a Ghostty load that failed on the console and shows the
// failure in the terminal's area, so a test that opens a terminal without the
// shared widget fixture would pass against a terminal that never opened.
// Three records catch it, and any of them fails the test it came from once
// the test's own teardown has run (a setup file's `afterEach` runs last); one
// that arrives after the last test fails the file, once its timers are
// released:
//
// - the report, matched by its prefix, while the test has not replaced
//   console.warn;
// - the load error a terminal shows in its own area (TerminalTab's
//   `.terminal-load-failure`), counted from the DOM, which no console
//   replacement hides. A file that makes a load fail on purpose takes the
//   count its case expects with `takeShownLoadFailures`;
// - a stand-in xterm constructed with no load paying for it, counted by the
//   stand-in itself (src/__tests__/xterm.ts).
//
// The one report let through is a load failed with XtermStandInRequested,
// matched by its class: a file on the transitional stand-in route in
// src/__tests__/xterm.ts asks for that failure. It is counted and not
// printed, as every such file gives one per terminal. The exception goes
// with the route.
const TERMINAL_INIT_FAILURE = "[chan] ghostty-web failed to load";
const terminalInitFailures: string[] = [];
let standInReports = 0;
const environmentWarn = console.warn;
console.warn = function (this: Console, ...args: unknown[]) {
  if (typeof args[0] === "string" && args[0].startsWith(TERMINAL_INIT_FAILURE)) {
    if (args[1] instanceof XtermStandInRequested) {
      standInReports += 1;
      return;
    }
    terminalInitFailures.push(args.map((arg) => String(arg)).join(" "));
  }
  return environmentWarn.apply(this, args);
};

/// The stand-in route's own load reports since the last call.
export function takeStandInReports(): number {
  const reports = standInReports;
  standInReports = 0;
  return reports;
}

const TERMINAL_LOAD_FAILURE = ".terminal-load-failure";
let shownLoadFailures = 0;

function countShownLoadFailures(records: MutationRecord[]): void {
  for (const record of records) {
    for (const node of record.addedNodes) {
      if (!(node instanceof Element)) continue;
      if (node.matches(TERMINAL_LOAD_FAILURE)) shownLoadFailures += 1;
      shownLoadFailures += node.querySelectorAll(TERMINAL_LOAD_FAILURE).length;
    }
  }
}

// A file in the node environment has no document to watch.
const loadFailureWatch =
  typeof MutationObserver === "undefined" || typeof document === "undefined"
    ? null
    : new MutationObserver(countShownLoadFailures);
loadFailureWatch?.observe(document.documentElement, { childList: true, subtree: true });

/// How many terminal load errors were shown since the last call.
export function takeShownLoadFailures(): number {
  countShownLoadFailures(loadFailureWatch?.takeRecords() ?? []);
  const shown = shownLoadFailures;
  shownLoadFailures = 0;
  return shown;
}

/// Throw for the terminal initialization failures recorded since the last
/// call, naming the test file and the fixture that opens a terminal in a
/// mounted test.
export function failOnTerminalInitFailures(): void {
  const failures = terminalInitFailures.splice(0);
  const unrouted = takeUnroutedStandIns();
  const shown = takeShownLoadFailures();
  if (failures.length === 0 && unrouted === 0 && shown === 0) return;
  const found = [
    ...(failures.length > 0 ? [`Reported: ${failures.join(" | ")}`] : []),
    ...(unrouted > 0 ? [`${unrouted} opened on the xterm stand-in with no route request`] : []),
    ...(shown > 0 ? [`${shown} showed the terminal load error`] : []),
  ];
  throw new Error(
    "a mounted terminal failed to initialize: open it on the real widget through the shared fixture in " +
      'src/__tests__/ghosttyTab.ts (vi.mock "../terminal/backend" with ghosttyBackendModule). ' +
      `In ${expect.getState().testPath ?? "this file"}. ` +
      found.join(". "),
  );
}

afterEach(failOnTerminalInitFailures);
