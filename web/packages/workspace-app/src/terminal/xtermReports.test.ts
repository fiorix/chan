import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import {
  handleOsc52Clipboard,
  installTerminalReportGuards,
  suppressOscIndexedColorReport,
  suppressOscSpecialColorReport,
} from "./xtermReports";
import { writeClipboardText } from "../api/desktop";

vi.mock("../api/desktop", () => ({
  writeClipboardText: vi.fn(() => Promise.resolve()),
}));

describe("xterm report guards", () => {
  test("registers OSC color report and clipboard guards", () => {
    const registered: number[] = [];
    const term = {
      parser: {
        registerOscHandler(ident: number) {
          registered.push(ident);
          return { dispose() {} };
        },
      },
    } as unknown as Terminal;

    installTerminalReportGuards(term);

    expect(registered).toEqual([4, 10, 11, 12, 52, 7501]);
  });

  test("an answering OSC 7501 handler answers before the guard and stays silent after it", () => {
    const callbacks = new Map<number, (body: string) => boolean | Promise<boolean>>();
    const observer: string[] = [];
    const term = { parser: { registerOscHandler(ident: number, callback: (body: string) => boolean | Promise<boolean>) {
      callbacks.set(ident, callback);
      return { dispose() { callbacks.delete(ident); } };
    } } } as unknown as Terminal;
    callbacks.set(7501, (body) => { observer.push(`answer:${body}`); return true; });
    callbacks.get(7501)?.("?");
    expect(observer).toEqual(["answer:?"]);
    installTerminalReportGuards(term);
    callbacks.get(7501)?.("?");
    callbacks.get(7501)?.("state=working");
    expect(observer).toEqual(["answer:?"]);
  });

  test("suppresses special color queries but lets color sets fall through", () => {
    expect(suppressOscSpecialColorReport("?")).toBe(true);
    expect(suppressOscSpecialColorReport("?;?")).toBe(true);
    expect(suppressOscSpecialColorReport("#ffffff;?")).toBe(true);
    expect(suppressOscSpecialColorReport("#ffffff")).toBe(false);
    expect(suppressOscSpecialColorReport("rgb:eeee/eeee/f0f0")).toBe(false);
  });

  test("suppresses indexed color query pairs", () => {
    expect(suppressOscIndexedColorReport("1;?")).toBe(true);
    expect(suppressOscIndexedColorReport("1;#ffffff;2;?")).toBe(true);
    expect(suppressOscIndexedColorReport("1;#ffffff")).toBe(false);
    expect(suppressOscIndexedColorReport("1;rgb:eeee/eeee/f0f0")).toBe(false);
  });
});

describe("OSC 52 clipboard", () => {
  const writeMock = vi.mocked(writeClipboardText);

  beforeEach(() => {
    writeMock.mockClear();
  });

  test("decodes a base64 copy payload and writes it to the clipboard", () => {
    expect(handleOsc52Clipboard("c;" + btoa("hello"))).toBe(true);
    expect(writeMock).toHaveBeenCalledWith("hello");
  });

  test("decodes multibyte UTF-8 via TextDecoder, not raw atob", () => {
    const text = "héllo ☃";
    const payload = btoa(String.fromCharCode(...new TextEncoder().encode(text)));
    expect(handleOsc52Clipboard("c;" + payload)).toBe(true);
    expect(writeMock).toHaveBeenCalledWith(text);
  });

  test("consumes the read/query form without writing", () => {
    expect(handleOsc52Clipboard("c;?")).toBe(true);
    expect(writeMock).not.toHaveBeenCalled();
  });

  test("consumes malformed base64 without throwing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(handleOsc52Clipboard("c;@@@")).toBe(true);
    expect(writeMock).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
