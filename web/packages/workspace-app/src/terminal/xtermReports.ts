import type { Terminal } from "@xterm/xterm";
import { handleOsc52Clipboard } from "./osc52Bridge";

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
