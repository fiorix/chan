// The stand-in for xterm and its addons: a terminal that opens, resizes and
// disposes without a canvas and records what a component configured, wrote
// and registered, the custom key handler included, so a test can read it and
// drive the handler the way xterm would. A test file mocks each xterm module
// with the factory below that answers for it, e.g.
//
//   vi.mock("@xterm/xterm", async () => (await import("../__tests__/xterm")).xtermModule());
//
// `./terminalTab` re-exports the stand-in beside its TerminalTab mounting
// harness; the stand-in route at the end is imported from here. This module imports nothing from the app, so a mock factory can
// load it while the app's own imports are still resolving.

/// What the stand-in xterm recorded.
export const xterm = {
  terminals: [] as FakeTerminal[],
  /// The options each SerializeAddon.serialize call was given.
  serializeCalls: [] as unknown[],
  /// What SerializeAddon.serialize returns.
  serialized: "",
  fit: { calls: 0, failure: null as Error | null, size: null as { cols: number; rows: number } | null },
  /// Every WebglAddon made, with the context-loss handler it was given.
  webgl: [] as Array<{ loadedInto: FakeTerminal | null; onContextLoss: (() => void) | null; disposed: boolean }>,
  /// The handler and options each WebLinksAddon was given.
  webLinks: [] as Array<{ handler: (event: MouseEvent, uri: string) => void; options: any }>,
  /// When set, constructing a WebglAddon throws, as it does without WebGL.
  webglThrows: false,
  /// When set, each terminal opens a textarea in its host and focus() and
  /// blur() move DOM focus to and from it, as xterm's own textarea does.
  textareaFocus: false,
};

type CsiId = { prefix?: string; intermediates?: string; final: string };

export class FakeTerminal {
  cols = 80;
  rows = 24;
  options: Record<string, unknown>;
  element: HTMLElement | null = null;
  keyHandler: ((e: KeyboardEvent) => boolean) | null = null;
  dataHandlers: Array<(data: string) => void> = [];
  binaryHandlers: Array<(data: string) => void> = [];
  resizeHandlers: Array<(size: { cols: number; rows: number }) => void> = [];
  written: string[] = [];
  /// What each write was handed, before decoding.
  writtenRaw: unknown[] = [];
  refreshCalls: Array<[number, number]> = [];
  pasted: string[] = [];
  selection = "";
  selectionHandlers: Array<() => void> = [];
  focusCount = 0;
  blurCount = 0;
  scrollToBottomCount = 0;
  disposed = false;
  /// The textarea open() made when `xterm.textareaFocus` is set.
  textarea: HTMLTextAreaElement | null = null;
  /// When set, the next writes answer with this reply the way xterm answers
  /// a query in the output it parses: during the write.
  replyDuringWrite: string | null = null;
  /// The escape-sequence handlers the component registered with xterm's parser.
  parser = {
    osc: new Map<number, (data: string) => boolean>(),
    csi: [] as Array<{ id: CsiId; handler: (params: Array<number | number[]>) => boolean }>,
    registerOscHandler: (ident: number, handler: (data: string) => boolean) => {
      this.parser.osc.set(ident, handler);
      return { dispose() {} };
    },
    registerCsiHandler: (id: CsiId, handler: (params: Array<number | number[]>) => boolean) => {
      this.parser.csi.push({ id, handler });
      return { dispose() {} };
    },
    registerEscHandler: () => ({ dispose() {} }),
  };

  constructor(options: Record<string, unknown> = {}) {
    this.options = { ...options };
    xterm.terminals.push(this);
    // A file's own Ghostty double built on the stand-in is constructed by its
    // kit, with the core it instantiated; only the xterm.js fallback is paid
    // for by a load (see the route below).
    if (!("ghostty" in options)) {
      if (route.paid > 0) route.paid -= 1;
      else route.unpaid += 1;
    }
  }

  loadAddon(addon: { activate?: (terminal: FakeTerminal) => void }): void {
    addon.activate?.(this);
  }
  open(element: HTMLElement): void {
    this.element = element;
    if (xterm.textareaFocus) {
      this.textarea = document.createElement("textarea");
      element.append(this.textarea);
    }
  }
  attachCustomKeyEventHandler(handler: (e: KeyboardEvent) => boolean): void {
    this.keyHandler = handler;
  }
  attachCustomWheelEventHandler(): void {}
  onData(handler: (data: string) => void): { dispose(): void } {
    this.dataHandlers.push(handler);
    return { dispose() {} };
  }
  onBinary(handler: (data: string) => void): { dispose(): void } {
    this.binaryHandlers.push(handler);
    return { dispose() {} };
  }
  onResize(handler: (size: { cols: number; rows: number }) => void): { dispose(): void } {
    this.resizeHandlers.push(handler);
    return { dispose() {} };
  }
  write(data: string | Uint8Array, done?: () => void): void {
    this.writtenRaw.push(data);
    this.written.push(typeof data === "string" ? data : new TextDecoder().decode(data));
    if (this.replyDuringWrite !== null) this.type(this.replyDuringWrite);
    done?.();
  }
  /// Emit data from xterm, as typing or a generated reply does.
  type(data: string): void {
    for (const handler of this.dataHandlers) handler(data);
  }
  /// Emit binary data from xterm, as an X10 mouse report does: one byte per
  /// character.
  binary(data: string): void {
    for (const handler of this.binaryHandlers) handler(data);
  }
  /// Run the CSI handler registered for this prefix and final, as xterm's
  /// parser does when the program writes the sequence.
  csi(prefix: string, final: string, params: Array<number | number[]>): boolean {
    const entry = this.parser.csi.find((c) => c.id.prefix === prefix && c.id.final === final);
    if (!entry) throw new Error(`no CSI handler for ${prefix}${final}`);
    return entry.handler(params);
  }
  writeln(data: string): void {
    this.written.push(`${data}\r\n`);
  }
  paste(data: string): void {
    this.pasted.push(data);
  }
  /// Resize the grid; a change reaches every onResize handler, as in xterm.
  resize(cols: number, rows: number): void {
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols;
    this.rows = rows;
    for (const handler of this.resizeHandlers) handler({ cols, rows });
  }
  refresh(start: number, end: number): void {
    this.refreshCalls.push([start, end]);
  }
  scrollToBottom(): void {
    this.scrollToBottomCount += 1;
  }
  onSelectionChange(handler: () => void): { dispose(): void } {
    this.selectionHandlers.push(handler);
    return { dispose: () => { this.selectionHandlers = this.selectionHandlers.filter((h) => h !== handler); } };
  }
  changeSelection(text: string): void {
    this.selection = text;
    for (const handler of this.selectionHandlers) handler();
  }
  getSelection(): string {
    return this.selection;
  }
  hasSelection(): boolean {
    return this.selection.length > 0;
  }
  /// The mouse tracking a program asked for; none until a test sets it.
  modes = { mouseTrackingMode: "none" as "none" | "x10" | "vt200" | "drag" | "any" };
  focus(): void {
    this.focusCount += 1;
    this.textarea?.focus();
  }
  blur(): void {
    this.blurCount += 1;
    this.textarea?.blur();
  }
  dispose(): void {
    this.disposed = true;
    this.textarea?.remove();
    this.textarea = null;
  }
}

export function xtermModule() {
  return { Terminal: FakeTerminal };
}

export function fitAddonModule() {
  return {
    FitAddon: class {
      terminal: FakeTerminal | null = null;
      activate(terminal: FakeTerminal) {
        this.terminal = terminal;
      }
      /// Fit to `xterm.fit.size`, the grid a measured host holds; with no
      /// size set the host cannot be measured and the fit declines, as
      /// xterm's does.
      fit() {
        xterm.fit.calls += 1;
        if (xterm.fit.failure) throw xterm.fit.failure;
        if (xterm.fit.size && this.terminal) {
          this.terminal.resize(xterm.fit.size.cols, xterm.fit.size.rows);
        }
      }
      proposeDimensions() {
        if (xterm.fit.failure) throw xterm.fit.failure;
        return xterm.fit.size ?? undefined;
      }
    },
  };
}

export function searchAddonModule() {
  return {
    SearchAddon: class {
      findNext() {}
      findPrevious() {}
    },
  };
}

export function serializeAddonModule() {
  return {
    SerializeAddon: class {
      serialize(options?: unknown) {
        xterm.serializeCalls.push(options);
        return xterm.serialized;
      }
    },
  };
}

// A buffer with no rows at the bottom of an empty history, on the prototype
// so a suite that reads a buffer of its own redefines it there.
Object.defineProperty(FakeTerminal.prototype, "buffer", {
  configurable: true,
  get: () => ({ active: { viewportY: 0, getLine: () => undefined } }),
});

export function webLinksAddonModule() {
  return {
    WebLinksAddon: class {
      constructor(handler: (event: MouseEvent, uri: string) => void, options: unknown) {
        xterm.webLinks.push({ handler, options });
      }
    },
  };
}

export function webglAddonModule() {
  return {
    WebglAddon: class {
      record = { loadedInto: null as FakeTerminal | null, onContextLoss: null as (() => void) | null, disposed: false };
      constructor() {
        if (xterm.webglThrows) throw new Error("WebGL2 not supported");
        xterm.webgl.push(this.record);
      }
      activate(terminal: FakeTerminal) {
        this.record.loadedInto = terminal;
      }
      onContextLoss(handler: () => void) {
        this.record.onContextLoss = handler;
        return { dispose() {} };
      }
      dispose() {
        this.record.disposed = true;
      }
    },
  };
}

// The stand-in route. A file that still asserts on the stand-in opens its
// terminals on it through TerminalTab's own fallback: the file's Ghostty load
// fails with `XtermStandInRequested`, TerminalTab falls back to xterm.js, and
// the file's `@xterm/xterm` mock serves the stand-in. The setup file's
// terminal initialization guard lets that one failure through, by its class.
// The route is transitional: a file leaves it when its assertions move to the
// widget fixture (`./ghosttyTab`), and the route goes with the last file.
//
// Each load that asks for the fallback pays for one stand-in: the route's
// own failure, or a file's own kit failing under the switch, which is that
// file's choice. A stand-in nothing paid for fell back on its own, with
// neither fixture nor route, and the setup file's guard fails its test from
// this count, whatever the test did with the console. The count is per file:
// a load whose component was torn down before it built a terminal leaves its
// payment for the next.

/// The load failure a file on the stand-in route asks for.
export class XtermStandInRequested extends Error {
  constructor() {
    super("this terminal runs on the xterm stand-in");
    this.name = "XtermStandInRequested";
  }
}

const route = { paid: 0, unpaid: 0 };

/// A Ghostty load that asks for the stand-in: it fails with the route's
/// error, and pays for the fallback terminal it leads to.
export function requestXtermStandIn(): Promise<never> {
  route.paid += 1;
  return Promise.reject(new XtermStandInRequested());
}

/// How many stand-ins were constructed with no load paying for them since
/// the last call.
export function takeUnroutedStandIns(): number {
  const unpaid = route.unpaid;
  route.unpaid = 0;
  return unpaid;
}

/// The `vi.mock("../terminal/backend", ...)` factory of a file whose every
/// terminal runs on the stand-in.
export async function xtermStandInBackendModule(importOriginal: <T>() => Promise<T>) {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, loadGhosttyKit: requestXtermStandIn };
}

const standIn = { on: false };

/// For a file whose own backend mock serves a Ghostty kit, per case: the
/// terminals opened after `useXtermStandIn()` run on the stand-in, and after
/// `useXtermStandIn(false)` on the file's kit. `resetTerminals` turns it off.
export function useXtermStandIn(on = true): void {
  standIn.on = on;
}

/// Wraps the module a file's own backend mock returns, so `useXtermStandIn`
/// decides each load. The file's own load is returned as it is, so a kit's
/// timing is the file's; when it fails, the fallback it leads to is paid.
export function xtermStandInSwitch<T extends { loadGhosttyKit: () => Promise<unknown> }>(module: T): T {
  const load = module.loadGhosttyKit;
  return {
    ...module,
    loadGhosttyKit: (() => {
      if (standIn.on) return requestXtermStandIn();
      const loading = load();
      loading.catch(() => {
        route.paid += 1;
      });
      return loading;
    }) as T["loadGhosttyKit"],
  };
}
