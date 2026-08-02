import type {
  IBufferCell,
  IBufferLine,
  IDecoration,
  IDecorationOptions,
  IDisposable,
  IMarker,
  Terminal,
} from "@xterm/xterm";
import { describe, expect, test, vi } from "vitest";
import {
  DEFAULT_SECRET_MASK_SUFFIXES,
  SecretAssignmentMatcher,
  TerminalSecretMasker,
  findSecretMaskSpans,
} from "./secretMasking";

const CORPUS = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "CACHIX_AUTH_TOKEN",
  "DOCKERHUB_TOKEN",
  "APPLE_PASSWORD",
  "APPLE_CERTIFICATE_PASSWORD",
  "ES_PASSWORD",
  "ES_TOTP_SECRET",
  "TAURI_SIGNING_PRIVATE_KEY",
  "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
  "LAUNCHPAD_GPG_PRIVATE_KEY",
  "LAUNCHPAD_SSH_PRIVATE_KEY",
  "AUR_SSH_PRIVATE_KEY",
  "HOMEBREW_TAP_DEPLOY_KEY_BASE64",
  "POSTGRES_PASSWORD",
];

function values(text: string, matcher = new SecretAssignmentMatcher(DEFAULT_SECRET_MASK_SUFFIXES)) {
  return matcher.find(text).map((range) => text.slice(range.start, range.end));
}

class FakeCell {
  constructor(readonly char: string) {}
  getWidth() {
    return 1;
  }
  getChars() {
    return this.char === " " ? "" : this.char;
  }
}

class FakeLine {
  constructor(
    public text: string,
    readonly cols: number,
    public isWrapped = false,
  ) {}

  get length() {
    return this.cols;
  }

  getCell(x: number): IBufferCell | undefined {
    if (x < 0 || x >= this.cols) return undefined;
    return new FakeCell(this.padded()[x] ?? " ") as unknown as IBufferCell;
  }

  translateToString(trimRight = false, start = 0, end = this.cols): string {
    const value = this.padded().slice(start, end);
    return trimRight ? value.trimEnd() : value;
  }

  padded(): string {
    return this.text.padEnd(this.cols, " ").slice(0, this.cols);
  }
}

type Listener<T> = (event: T) => void;

class FakeMarker {
  isDisposed = false;
  readonly listeners: Listener<void>[] = [];

  constructor(public line: number) {}

  onDispose(listener: Listener<void>): IDisposable {
    this.listeners.push(listener);
    return { dispose() {} };
  }

  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    this.line = -1;
    for (const listener of this.listeners) listener();
  }
}

class FakeDecoration {
  isDisposed = false;
  element = undefined;
  readonly disposeListeners: Listener<void>[] = [];
  readonly renderListeners: Listener<HTMLElement>[] = [];
  options = {};

  constructor(
    readonly marker: IMarker,
    readonly registered: IDecorationOptions,
  ) {}

  onDispose(listener: Listener<void>): IDisposable {
    this.disposeListeners.push(listener);
    return { dispose() {} };
  }

  onRender(listener: Listener<HTMLElement>): IDisposable {
    this.renderListeners.push(listener);
    return { dispose() {} };
  }

  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    for (const listener of this.disposeListeners) listener();
  }
}

class FakeTerminal {
  readonly rows = 2;
  readonly decorations: FakeDecoration[] = [];
  readonly lines: FakeLine[];
  readonly buffer: any;

  constructor(
    readonly cols: number,
    lines: FakeLine[],
    baseY = 0,
    cursorY = 0,
  ) {
    this.lines = lines;
    this.buffer = {
      active: {
        type: "normal",
        baseY,
        cursorY,
        get length() {
          return lines.length;
        },
        getLine(row: number) {
          return lines[row] as unknown as IBufferLine | undefined;
        },
      },
    };
  }

  registerMarker(offset = 0): IMarker {
    return new FakeMarker(
      this.buffer.active.baseY + this.buffer.active.cursorY + offset,
    ) as unknown as IMarker;
  }

  failDecorations = false;
  throwDecorations = false;

  registerDecoration(options: IDecorationOptions): IDecoration {
    if (this.throwDecorations) throw new Error("injected renderer failure");
    if (this.failDecorations) return undefined as unknown as IDecoration;
    const decoration = new FakeDecoration(options.marker, options);
    this.decorations.push(decoration);
    return decoration as unknown as IDecoration;
  }

  liveDecorations(): FakeDecoration[] {
    return this.decorations.filter((decoration) => !decoration.isDisposed);
  }
}

describe("terminal secret assignment matcher", () => {
  test("masks every workflow-derived stock fixture", () => {
    const matcher = new SecretAssignmentMatcher(DEFAULT_SECRET_MASK_SUFFIXES);
    for (const name of CORPUS) {
      expect(values(`${name}=live-credential`, matcher), name).toEqual([
        "live-credential",
      ]);
    }
  });

  test("is case-insensitive and suffix-anchored without noisy bare-key matches", () => {
    expect(values("api_token=one TOKENIZE=1 MONKEY=2 AUTHOR=alex TLS_CERT=public")).toEqual([
      "one",
    ]);
  });

  test("includes quotes and their spaces while unquoted values stop at whitespace", () => {
    const text = `TOKEN="a b c" NEXT_SECRET=plain trailing`;
    expect(values(text)).toEqual([`"a b c"`, "plain"]);
  });

  test("matches an exact suffix name and adjacent quoted assignments", () => {
    expect(values(`TOKEN=one PASSWORD="two"API_KEY=three`)).toEqual([
      "one",
      `"two"`,
      "three",
    ]);
    expect(values("1TOKEN=not-a-name")).toEqual([]);
  });

  test("rejects regex-shaped client suffixes defensively", () => {
    const matcher = new SecretAssignmentMatcher(["SECRET.*"]);
    expect(matcher.find("MY_SECRET=safe")).toEqual([]);
  });

  test("a rejected digit-led name does not swallow assignments inside its value", () => {
    // The word-boundary rejection applies to the candidate NAME only; it
    // must not consume the quoted text after it, which can itself hold
    // secret-looking assignments.
    expect(values(`1TOKEN="API_KEY=x y"`)).toEqual(["x"]);
    expect(values("1TOKEN=not-a-name")).toEqual([]);
  });

  test("long word runs without assignments scan without pathological backtracking", () => {
    // The matcher is a linear scan: candidate names come from a name-run
    // pass and suffixes are checked in code, so a megabyte-class run of
    // word characters cannot blow up quadratically.
    expect(values("a".repeat(10_000))).toEqual([]);
    expect(values(`${"a".repeat(10_000)} TOKEN=x`)).toEqual(["x"]);
  });

  test("splits a wrapped value across exact row cells", () => {
    const matcher = new SecretAssignmentMatcher(["TOKEN"]);
    const first = new FakeLine("NAME_TOKEN=a", 12);
    const second = new FakeLine("bcdef", 12, true);
    expect(
      findSecretMaskSpans(
        [
          { row: 7, line: first as unknown as IBufferLine },
          { row: 8, line: second as unknown as IBufferLine },
        ],
        12,
        matcher,
      ),
    ).toEqual([
      { row: 7, x: 11, width: 1 },
      { row: 8, x: 0, width: 5 },
    ]);
  });
});

describe("terminal secret decoration lifecycle", () => {
  test("masks only after a changed write, stays idempotent on replay, and never edits text", () => {
    const line = new FakeLine("", 20);
    const terminal = new FakeTerminal(20, [line]);
    const masker = new TerminalSecretMasker(
      terminal as unknown as Terminal,
      ["TOKEN"],
      "#6c6c70",
      true,
    );

    const write = masker.captureWrite();
    line.text = "TOKEN=cleartext";
    masker.scanWrite(write);
    expect(terminal.liveDecorations()).toHaveLength(1);
    expect(terminal.liveDecorations()[0].registered).toMatchObject({
      x: 6,
      width: 9,
      backgroundColor: "#6c6c70",
      foregroundColor: "#6c6c70",
      layer: "top",
    });
    expect(line.text).toBe("TOKEN=cleartext");

    const replay = masker.captureWrite();
    masker.scanWrite(replay);
    expect(terminal.liveDecorations()).toHaveLength(1);

    masker.setEnabled(false);
    expect(terminal.liveDecorations()).toHaveLength(0);
    masker.setEnabled(true);
    expect(terminal.liveDecorations()).toHaveLength(1);
    expect(line.text).toBe("TOKEN=cleartext");
  });

  test("a decoration registration failure disables masking, notifies, and recovers via the toggle", () => {
    const line = new FakeLine("TOKEN=cleartext", 20);
    const terminal = new FakeTerminal(20, [line]);
    let notified = 0;
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const masker = new TerminalSecretMasker(
      terminal as unknown as Terminal,
      ["TOKEN"],
      "#6c6c70",
      true,
      () => {
        notified += 1;
      },
    );

    terminal.failDecorations = true;
    masker.scanAll();
    expect(terminal.liveDecorations()).toHaveLength(0);
    expect(masker.enabled).toBe(false);
    expect(notified).toBe(1);
    expect(consoleError).toHaveBeenCalledOnce();

    // Re-enabling retries from a clean scan once the renderer cooperates.
    terminal.failDecorations = false;
    masker.setEnabled(true);
    expect(terminal.liveDecorations()).toHaveLength(1);
    expect(notified).toBe(1);
    consoleError.mockRestore();
  });

  test("a scrollback trim re-bases the diff instead of rescanning every row", () => {
    // At the scrollback cap every appending write trims rows off the top.
    // The write marker tracks that shift, so only genuinely new or changed
    // rows rescan; a row whose content merely moved keeps its decoration.
    const lines = [
      new FakeLine("s0", 20),
      new FakeLine("TOKEN=one", 20),
      new FakeLine("s2", 20),
      new FakeLine("s3", 20),
    ];
    const terminal = new FakeTerminal(20, lines, 1, 2);
    const masker = new TerminalSecretMasker(
      terminal as unknown as Terminal,
      ["TOKEN"],
      "#6c6c70",
      true,
    );
    masker.scanAll();
    expect(terminal.liveDecorations()).toHaveLength(1);
    const before = terminal.liveDecorations()[0];

    const snapshot = masker.captureWrite();
    // Simulate xterm parsing a batch that appends one row and trims one
    // off the top: buffer rows shift up by one, and markers shift with
    // their content.
    lines.shift();
    lines.push(new FakeLine("new row", 20));
    (snapshot?.marker as unknown as FakeMarker).line -= 1;
    (before.marker as unknown as FakeMarker).line -= 1;
    masker.scanWrite(snapshot);

    const after = terminal.liveDecorations();
    expect(after).toHaveLength(1);
    expect(after[0]).toBe(before);
    expect((after[0].marker as unknown as FakeMarker).line).toBe(0);
  });

  test("a write that scrolls the marker away rebuilds from the current buffer", () => {
    const lines = [new FakeLine("TOKEN=one", 20), new FakeLine("s1", 20)];
    const terminal = new FakeTerminal(20, lines, 0, 0);
    const masker = new TerminalSecretMasker(
      terminal as unknown as Terminal,
      ["TOKEN"],
      "#6c6c70",
      true,
    );
    const snapshot = masker.captureWrite();
    lines[0] = new FakeLine("NEXT_TOKEN=two", 20);
    (snapshot?.marker as unknown as FakeMarker).dispose();
    masker.scanWrite(snapshot);
    expect(terminal.liveDecorations()).toHaveLength(1);
    expect(terminal.liveDecorations()[0].registered).toMatchObject({
      x: 11,
      width: 3,
    });
  });

  test("a throwing renderer on scanAll fails loud instead of escaping the caller", () => {
    const line = new FakeLine("TOKEN=cleartext", 20);
    const terminal = new FakeTerminal(20, [line]);
    terminal.throwDecorations = true;
    let notified = 0;
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const masker = new TerminalSecretMasker(
      terminal as unknown as Terminal,
      ["TOKEN"],
      "#6c6c70",
      true,
      () => {
        notified += 1;
      },
    );

    expect(() => masker.scanAll()).not.toThrow();
    expect(masker.enabled).toBe(false);
    expect(notified).toBe(1);
    consoleError.mockRestore();
  });

  test("a throwing renderer on scanWrite fails loud instead of escaping the write callback", () => {
    const line = new FakeLine("TOKEN=cleartext", 20);
    const terminal = new FakeTerminal(20, [line]);
    let notified = 0;
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const masker = new TerminalSecretMasker(
      terminal as unknown as Terminal,
      ["TOKEN"],
      "#6c6c70",
      true,
      () => {
        notified += 1;
      },
    );

    const snapshot = masker.captureWrite();
    terminal.throwDecorations = true;
    line.text = "NEXT_TOKEN=changed";
    expect(() => masker.scanWrite(snapshot)).not.toThrow();
    expect(masker.enabled).toBe(false);
    expect(notified).toBe(1);
    consoleError.mockRestore();
  });

  test("the decoration element paints opaque with the mask color on render", () => {
    // The cell fg/bg recolor is one layer of the mask; the decoration
    // element itself must also be opaque, or a renderer that drops
    // decoration cell colors would show the value through a styled but
    // transparent chip.
    const line = new FakeLine("TOKEN=cleartext", 20);
    const terminal = new FakeTerminal(20, [line]);
    const masker = new TerminalSecretMasker(
      terminal as unknown as Terminal,
      ["TOKEN"],
      "#6c6c70",
      true,
    );
    masker.scanAll();
    const decoration = terminal.liveDecorations()[0];
    const element = {
      classList: { add: vi.fn() },
      style: {} as Record<string, string>,
    };
    for (const listener of decoration.renderListeners) {
      listener(element as unknown as HTMLElement);
    }
    expect(element.classList.add).toHaveBeenCalledWith("terminal-secret-mask");
    expect(element.style.backgroundColor).toBe("#6c6c70");
  });
});
