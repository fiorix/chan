export type TerminalByteWriter = {
  write(data: Uint8Array, callback?: () => void): void;
};

export type PtyWriteOrigin = "live" | "replay";

export class PtyWriteTracker {
  #pending: PtyWriteOrigin[] = [];

  get active(): boolean {
    return this.#pending.length > 0;
  }

  get currentOrigin(): PtyWriteOrigin | null {
    return this.#pending[0] ?? null;
  }

  reset(): void {
    this.#pending = [];
  }

  write(
    writer: TerminalByteWriter,
    bytes: Uint8Array,
    origin: PtyWriteOrigin = "live",
    onComplete?: (origin: PtyWriteOrigin) => void,
  ): void {
    this.#pending.push(origin);
    let pending = true;
    const done = () => {
      if (!pending) return;
      pending = false;
      this.#pending.shift();
      onComplete?.(origin);
    };
    try {
      writer.write(bytes, done);
    } catch (err) {
      done();
      throw err;
    }
  }
}

export async function terminalMessageBytes(data: unknown): Promise<Uint8Array | null> {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return new Uint8Array(await data.arrayBuffer());
  }
  return null;
}

/// PTY mouse reports are input bytes, but do not mean typed input awaits an answer.
/// The terminal sends these two complete report encodings.
export function terminalMouseReport(data: string): "x10" | "sgr" | null {
  if (data.startsWith("\x1b[M") && /^\x1b\[M[\x20-\xff]{3}$/.test(data)) return "x10";
  if (data.startsWith("\x1b[<") && /^\x1b\[<\d+;\d+;\d+[Mm]$/.test(data)) return "sgr";
  return null;
}

/// Route one chunk of the data the terminal hands the program, which carries
/// no mark of who made it. While a live write is being parsed it may be the
/// terminal's reply to that output, so it reaches only this PTY; during a
/// replay write an escape-prefixed chunk is dropped; a focus report reaches
/// only this PTY; anything else reaches the whole broadcast group.
export function routeTerminalData(
  data: string,
  writes: PtyWriteTracker,
  sendInput: (data: string) => void,
  sendUserInput: (data: string) => void,
): void {
  const origin = writes.currentOrigin;
  if (origin === "live") {
    // Terminal-generated replies belong only to the PTY that emitted the query.
    sendInput(data);
    return;
  }
  // Replay re-triggers the terminal's answers to old queries, which have no
  // reader any more: forwarded, raw CPR, DA or DCS bytes land in the shell's
  // prompt after a refresh or reattach. The write is synchronous, so what is
  // handed over inside it is the terminal's own output, never a key or a
  // paste, and an escape-prefixed chunk of an unknown shape goes too.
  if (origin === "replay" && data.startsWith("\x1b")) return;
  // A focus report is this terminal's answer to its own program.
  if (data === "\x1b[I" || data === "\x1b[O") {
    sendInput(data);
    return;
  }
  sendUserInput(data);
}

export function shouldForwardGeneratedTerminalInput(writes: PtyWriteTracker): boolean {
  return writes.currentOrigin !== "replay";
}
