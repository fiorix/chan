const PREFIX = Uint8Array.of(0x1b, 0x5d, 0x37, 0x35, 0x30, 0x31, 0x3b);
const MAX_BODY = 4087;

/// Ghostty-web currently rings its bell for BEL-ended OSC 7501. Hold only a
/// possible introducer; after the full prefix, consume through its terminator,
/// including a body that exceeds the server's admission bound.
export class GhosttyStatusGuard {
  private prefix: number[] = [];
  private bodyLength = -1;

  push(bytes: Uint8Array): Uint8Array {
    const output: number[] = [];
    for (const byte of bytes) {
      if (this.bodyLength >= 0) {
        if (byte === 0x07) {
          this.bodyLength = -1;
        } else if (byte === 0x1b || byte === 0x18 || byte === 0x1a) {
          this.bodyLength = -1;
          this.matchPrefix(byte, output);
        } else if (this.bodyLength <= MAX_BODY) {
          this.bodyLength++;
        }
      } else {
        this.matchPrefix(byte, output);
      }
    }
    return Uint8Array.from(output);
  }

  private matchPrefix(byte: number, output: number[]): void {
    this.prefix.push(byte);
    while (this.prefix.length && this.prefix.some((part, index) => part !== PREFIX[index])) {
      output.push(this.prefix.shift()!);
    }
    if (this.prefix.length === PREFIX.length) {
      this.prefix = [];
      this.bodyLength = 0;
    }
  }
}
