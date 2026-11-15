const PREFIX = Uint8Array.of(0x1b, 0x5d, 0x37, 0x35, 0x30, 0x31, 0x3b);
const MAX_BODY = 4087;

/// The server handles OSC 7501 status but retains its bytes in output and
/// replay. Keep that protocol out of Ghostty's parser, including bodies the
/// server rejects as overlong. Hold only a possible introducer; after the full
/// prefix, discard through BEL, passing ESC, CAN and SUB back to the parser.
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
