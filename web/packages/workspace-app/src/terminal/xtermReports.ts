import type { Terminal } from "@xterm/xterm";
import { writeClipboardText } from "../api/desktop";

type OscParserLike = {
  registerOscHandler?: (
    ident: number,
    callback: (data: string) => boolean | Promise<boolean>,
  ) => { dispose(): void };
};

export function installTerminalReportGuards(term: Terminal): void {
  const parser = (term as Terminal & { parser?: OscParserLike }).parser;
  if (!parser?.registerOscHandler) return;
  // Color probes are optional for chan's UI. If a foreground app
  // exits before reading the reply, the PTY can echo OSC bytes into
  // the next shell prompt and broadcast can copy them to other tabs.
  parser.registerOscHandler(4, suppressOscIndexedColorReport);
  parser.registerOscHandler(10, suppressOscSpecialColorReport);
  parser.registerOscHandler(11, suppressOscSpecialColorReport);
  parser.registerOscHandler(12, suppressOscSpecialColorReport);
  parser.registerOscHandler(52, handleOsc52Clipboard);
  parser.registerOscHandler(7501, () => true);
}

/// Honour an OSC 52 copy sequence: decode its base64 payload and write it to
/// the system clipboard. `@xterm/xterm` v6 has no built-in OSC 52 path, so
/// without this the embedded agent's copy sequences are silently dropped. The
/// read/query form (`?`) is consumed but never echoed -- replying would leak the
/// clipboard back into the PTY. Returns `true` synchronously to mark the
/// sequence handled; the actual write is fire-and-forget because returning the
/// Promise would stall xterm's parser until the clipboard settles.
export function handleOsc52Clipboard(data: string): boolean {
  const sep = data.indexOf(";");
  if (sep < 0) return false; // not an OSC 52 we understand
  const payload = data.slice(sep + 1); // selection param before ';' ignored
  if (payload === "?") return true; // read/query form: consume, never echo
  try {
    const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
    const text = new TextDecoder().decode(bytes);
    void writeClipboardText(text).catch((err) =>
      console.warn("OSC 52 clipboard write failed", err),
    );
  } catch (err) {
    console.warn("OSC 52 malformed base64", err);
  }
  return true;
}

export function suppressOscSpecialColorReport(data: string): boolean {
  return hasOscQueryToken(data);
}

export function suppressOscIndexedColorReport(data: string): boolean {
  const slots = data.split(";");
  for (let i = 1; i < slots.length; i += 2) {
    if (slots[i]?.trim() === "?") return true;
  }
  return false;
}

function hasOscQueryToken(data: string): boolean {
  return data.split(";").some((slot) => slot.trim() === "?");
}
