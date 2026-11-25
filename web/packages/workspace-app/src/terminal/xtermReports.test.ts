import { describe, expect, test, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import {
  installTerminalReportGuards,
  suppressOscIndexedColorReport,
  suppressOscSpecialColorReport,
} from "./xtermReports";

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
