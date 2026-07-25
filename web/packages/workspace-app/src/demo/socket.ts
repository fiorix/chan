// Mock WebSockets for the frontend-only demo. Three channels flow through the
// app's socket factory: the watcher (/ws), the local-color watch, and the
// terminal PTY (/api/terminal/ws). None have a server here.
//
// The watcher and local-color sockets are idle: they open, satisfy the
// handshake, and never push (there are no external filesystem events in the
// demo). The terminal socket is a fake PTY that streams a canned session and
// echoes input locally. Same-window broadcast still works because it is
// fanned out in the frontend (state/tabs.svelte.ts), independent of any
// socket.

const encoder = new TextEncoder();

type MessageHandler = ((ev: { data: unknown }) => void) | null;
type EventHandler = ((ev?: unknown) => void) | null;

// Structural stand-in for WebSocket: only the members the app touches on these
// sockets. Cast to WebSocket at the factory boundary so call sites are typed
// against the real class.
class MockSocket {
  url: string;
  binaryType: BinaryType = "blob";
  readyState = 0; // CONNECTING
  onopen: EventHandler = null;
  onmessage: MessageHandler = null;
  onclose: EventHandler = null;
  onerror: EventHandler = null;

  constructor(url: string) {
    this.url = url;
    // Open on the next tick so the caller has assigned its handlers first
    // (the app sets ws.onopen/onmessage synchronously after construction).
    setTimeout(() => {
      if (this.readyState !== 0) return;
      this.readyState = 1; // OPEN
      this.onopen?.({});
      this.opened();
    }, 0);
  }

  send(data: unknown): void {
    this.received(data);
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3; // CLOSED
    this.onclose?.({});
  }

  protected emitText(s: string): void {
    this.onmessage?.({ data: s });
  }

  protected emitBinary(s: string): void {
    // ArrayBuffer so terminalMessageBytes() recognizes it as PTY output.
    this.onmessage?.({ data: encoder.encode(s).buffer });
  }

  // Overridable hooks.
  protected opened(): void {}
  protected received(_data: unknown): void {}
}

// Idle watcher / local-color socket: opens and stays quiet.
class IdleSocket extends MockSocket {}

// Fake PTY. Streams a short canned session on open and echoes typed input so
// the terminal feels live.
class TerminalSocket extends MockSocket {
  #cols = 80;
  #rows = 24;
  #name = "Terminal";
  #id: string;

  constructor(url: string) {
    super(url);
    try {
      const q = new URL(url).searchParams;
      this.#cols = Number(q.get("cols")) || 80;
      this.#rows = Number(q.get("rows")) || 24;
      this.#name = q.get("tab_name") || "Terminal";
      this.#id = q.get("session") || `demo-${q.get("tab_id") ?? "t"}`;
    } catch {
      this.#id = "demo-terminal";
    }
  }

  protected opened(): void {
    this.emitText(JSON.stringify({ type: "ready", cols: this.#cols, rows: this.#rows }));
    this.emitText(
      JSON.stringify({ type: "session", id: this.#id, seq: 0, generation: 1 }),
    );
    this.emitBinary(welcomeBanner(this.#name));
  }

  protected received(data: unknown): void {
    if (typeof data !== "string") return;
    let frame: { type?: string; data?: string };
    try {
      frame = JSON.parse(data);
    } catch {
      return;
    }
    if (frame.type === "input" && typeof frame.data === "string") {
      // Local echo: a real PTY echoes typed characters; the demo has no PTY,
      // so echo here. Enter becomes CRLF and reprints the prompt.
      if (frame.data === "\r") {
        this.emitBinary("\r\n" + PROMPT);
      } else {
        this.emitBinary(frame.data);
      }
    }
  }
}

const PROMPT = "\x1b[38;5;175mchan\x1b[0m \x1b[38;5;108m~\x1b[0m $ ";

function welcomeBanner(name: string): string {
  return (
    "\x1b[38;5;175m" +
    `  This is a demo terminal (${name}).\r\n` +
    "\x1b[0m" +
    "  It is not a real shell: input is echoed, nothing runs.\r\n\r\n" +
    PROMPT
  );
}

/// The socket factory installed on the transport. Routes by URL to the right
/// mock. Cast to WebSocket for the typed call sites.
export function demoSocketFactory(url: string): WebSocket {
  if (url.includes("/api/terminal/ws")) {
    return new TerminalSocket(url) as unknown as WebSocket;
  }
  return new IdleSocket(url) as unknown as WebSocket;
}
