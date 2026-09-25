// The stand-in for xterm and its addons: a terminal that opens, resizes and
// disposes without a canvas and records what a component configured, wrote
// and registered, the custom key handler included, so a test can read it and
// drive the handler the way xterm would. A test file mocks each xterm module
// with the factory below that answers for it, e.g.
//
//   vi.mock("@xterm/xterm", async () => (await import("../__tests__/xterm")).xtermModule());
//
// `./terminalTab` re-exports all of it beside its TerminalTab mounting
// harness. This module imports nothing from the app, so a mock factory can
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
  /// When set, constructing a WebglAddon throws, as it does without WebGL.
  webglThrows: false,
  /// The link handler each WebLinksAddon was given.
  linkHandlers: [] as Array<(event: MouseEvent, uri: string) => void>,
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
  resizeHandlers: Array<(size: { cols: number; rows: number }) => void> = [];
  written: string[] = [];
  /// What each write was handed, before decoding.
  writtenRaw: unknown[] = [];
  refreshCalls: Array<[number, number]> = [];
  pasted: string[] = [];
  selection = "";
  focusCount = 0;
  blurCount = 0;
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
  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
  }
  refresh(start: number, end: number): void {
    this.refreshCalls.push([start, end]);
  }
  getSelection(): string {
    return this.selection;
  }
  hasSelection(): boolean {
    return this.selection.length > 0;
  }
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
      fit() {
        xterm.fit.calls += 1;
        if (xterm.fit.failure) throw xterm.fit.failure;
        if (xterm.fit.size && this.terminal) {
          this.terminal.cols = xterm.fit.size.cols;
          this.terminal.rows = xterm.fit.size.rows;
        }
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

export function webLinksAddonModule() {
  return {
    WebLinksAddon: class {
      constructor(handler: (event: MouseEvent, uri: string) => void) {
        xterm.linkHandlers.push(handler);
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
