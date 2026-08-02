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

export function routeXtermData(
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
  if (origin === "replay" && isReplayGeneratedTerminalInput(data)) return;
  sendUserInput(data);
}

export function shouldForwardGeneratedTerminalInput(writes: PtyWriteTracker): boolean {
  return writes.currentOrigin !== "replay";
}

export function isReplayGeneratedTerminalInput(data: string): boolean {
  if (!data) return false;
  // Historical replay can re-trigger xterm answers to old PTY queries. Those
  // replies have no live reader anymore; forwarding them leaks raw CPR/DA/DCS
  // bytes into the shell prompt after refresh or reattach.
  if (isTerminalGeneratedReply(data)) return true;
  // xterm emits a native paste as one bracketed-paste payload. It can race an
  // asynchronous replay write, but it is user input, not a terminal answer.
  // Let it reach the PTY while retaining the fail-closed rule for unknown
  // escape-prefixed replies replay may generate.
  if (data.startsWith("\x1b[200~") && data.endsWith("\x1b[201~")) return false;
  return data.startsWith("\x1b");
}

export function isTerminalGeneratedReply(data: string): boolean {
  let i = 0;
  while (i < data.length) {
    const next = scanTerminalReply(data, i);
    if (next === i) return false;
    i = next;
  }
  return i === data.length;
}

function scanTerminalReply(data: string, start: number): number {
  if (data[start] !== "\x1b") return start;
  const introducer = data[start + 1];
  if (introducer === "[") return scanCsiReply(data, start + 2);
  if (introducer === "P") return scanStringTerminatedReply(data, start + 2);
  if (introducer === "]") return scanOscReply(data, start + 2);
  return start;
}

function scanCsiReply(data: string, start: number): number {
  let i = start;
  while (i < data.length) {
    const code = data.charCodeAt(i);
    if (code >= 0x40 && code <= 0x7e) {
      return isGeneratedCsiFinal(data[i] ?? "") ? i + 1 : start - 2;
    }
    i += 1;
  }
  return start - 2;
}

function isGeneratedCsiFinal(final: string): boolean {
  return final === "R" || final === "c" || final === "n" || final === "u" || final === "m" || final === "y";
}

function scanStringTerminatedReply(data: string, start: number): number {
  const end = data.indexOf("\x1b\\", start);
  return end < 0 ? start - 2 : end + 2;
}

function scanOscReply(data: string, start: number): number {
  const bel = data.indexOf("\x07", start);
  const st = data.indexOf("\x1b\\", start);
  if (bel < 0) return st < 0 ? start - 2 : st + 2;
  if (st < 0) return bel + 1;
  return Math.min(bel + 1, st + 2);
}
