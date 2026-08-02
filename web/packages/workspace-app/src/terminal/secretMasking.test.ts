import type {
  IBufferCell,
  IBufferLine,
  IDecoration,
  IDecorationOptions,
  IDisposable,
  IMarker,
  Terminal,
} from "@xterm/xterm";
import { describe, expect, test } from "vitest";
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

  constructor(readonly cols: number, lines: FakeLine[]) {
    this.lines = lines;
    this.buffer = {
      active: {
        type: "normal",
        baseY: 0,
        cursorY: 0,
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

  registerDecoration(options: IDecorationOptions): IDecoration {
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
});
