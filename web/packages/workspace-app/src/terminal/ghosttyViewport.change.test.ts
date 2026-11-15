import { readFileSync } from "node:fs";
import { Terminal } from "@chan/ghostty-web-ng";
import { GhosttyVt } from "@chan/ghostty-web-ng/vt";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { SoftwareCanvasContext } from "../__tests__/softwareCanvas";
import { GhosttyViewportController } from "./ghosttyViewport";

let module: WebAssembly.Module;
const terminals: Terminal[] = [];
const frames = new Map<number, FrameRequestCallback>();

beforeAll(async () => {
  module = await WebAssembly.compile(readFileSync("../ghostty-web-ng/vendor/ghostty-vt/ghostty-vt.wasm"));
});

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
    return new SoftwareCanvasContext(this, 8) as unknown as CanvasRenderingContext2D;
  } as unknown as typeof HTMLCanvasElement.prototype.getContext);
  let next = 1;
  frames.clear();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = next++;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
});

afterEach(() => {
  for (const term of terminals.splice(0)) term.dispose();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function fixture() {
  const ghostty = new GhosttyVt(await WebAssembly.instantiate(module, {}));
  const term = new Terminal({ ghostty, cols: 40, rows: 6, smoothScrollDuration: 0 });
  const host = document.createElement("div");
  document.body.append(host);
  term.open(host);
  terminals.push(term);
  const controller = new GhosttyViewportController(term, {
    os: () => "mac", hasMouseTracking: () => false,
    isAlternateScreen: () => term.wasmTerm!.isAlternateScreen(), cellHeight: () => 20,
  });
  controller.write(Array.from({ length: 40 }, (_, n) => `history ${n}\r\n`).join(""));
  return { term, controller };
}

describe("the widget owns viewport changes", () => {
  test.each([
    { name: "user-marked input", send: (term: Terminal) => term.input("", true) },
    { name: "unbracketed paste", send: (term: Terminal) => term.paste("") },
    {
      name: "input-handler emission",
      send: (term: Terminal) => {
        // Exercise the handler's wired callback; native empty pastes stop
        // before this emitter and are not established by this seam.
        const handler = (term as unknown as { inputHandler: { emitPasteData(text: string): void } }).inputHandler;
        handler.emitPasteData("");
      },
    },
  ])("empty $name leaves output on its scheduled paint and preserves a pending real echo", async ({ send }) => {
    const { term } = await fixture();
    term.viewport.scrollTo(7.5);
    const top = term.getScrollbackLength() - Math.floor(term.viewport.offset);
    const row = term.buffer.active.getLine(top)?.translateToString(true);
    const sent: string[] = [];
    term.onData((data) => sent.push(data));
    const render = vi.spyOn(term.renderer!, "render");
    const painted = vi.spyOn(SoftwareCanvasContext.prototype, "fillRect");
    send(term);
    expect(sent.join("")).toBe("");
    expect(term.viewport.offset).toBe(7.5);
    term.write("background\r\n");
    expect(term.viewport.offset).toBe(8.5);
    expect(term.getScrollbackLength() - Math.floor(term.viewport.offset)).toBe(top);
    expect(term.buffer.active.getLine(top)?.translateToString(true)).toBe(row);
    expect(render.mock.calls.length, "empty input does not arm a synchronous echo paint").toBe(0);
    expect(painted).not.toHaveBeenCalled();
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(performance.now());
    expect(render.mock.calls.length).toBeGreaterThan(0);
    expect(render.mock.calls.every((args) => args[2] === 8.5)).toBe(true);
    expect(painted.mock.calls.length).toBeGreaterThan(0);
    render.mockClear();
    painted.mockClear();
    term.input("x", true);
    send(term);
    expect(sent.join("")).toBe("x");
    term.write("x");
    expect(render).toHaveBeenCalledOnce();
    expect(render.mock.calls[0][2]).toBe(0);
    expect(painted.mock.calls.length).toBeGreaterThan(0);
  });

  test("an empty bracketed paste sends its protocol frames and arms their echo", async () => {
    const { term } = await fixture();
    term.write("\x1b[?2004h");
    term.viewport.scrollTo(7.5);
    const sent: string[] = [];
    term.onData((data) => sent.push(data));
    term.paste("");
    expect(sent).toEqual(["\x1b[200~\x1b[201~"]);
    expect(term.viewport.offset).toBe(0);
    const render = vi.spyOn(term.renderer!, "render");
    const painted = vi.spyOn(SoftwareCanvasContext.prototype, "fillRect");
    term.write("ack");
    expect(render).toHaveBeenCalledOnce();
    expect(render.mock.calls[0][2]).toBe(0);
    expect(painted.mock.calls.length).toBeGreaterThan(0);
  });

  test("find observers hear direct writes as well as adapter writes, exactly once", async () => {
    const { term, controller } = await fixture();
    const seen: string[] = [];
    const stop = controller.observeChanges((kind) => seen.push(kind));
    term.write("direct\r\n");
    controller.write("adapter\r\n");
    term.resize(30, 8);
    stop();
    term.write("unobserved\r\n");
    expect(seen).toEqual(["write", "write", "resize"]);
  });

  test("a direct write keeps an anchored view and observers read that view before paint", async () => {
    const { term, controller } = await fixture();
    term.scrollLines(-7);
    const top = term.getScrollbackLength() - term.getViewportY();
    const seen: Array<[string, number]> = [];
    controller.observeChanges((kind) => seen.push([kind, term.getViewportY()]));
    const render = term.renderer!.render.bind(term.renderer);
    vi.spyOn(term.renderer!, "render").mockImplementation((...args) => {
      seen.push(["paint", term.getViewportY()]);
      return render(...args);
    });
    term.write("more\r\n");
    expect(term.getScrollbackLength() - term.getViewportY()).toBe(top);
    expect(seen[0]).toEqual(["write", 8]);
    expect(seen.every(([, offset]) => offset === 8)).toBe(true);
  });

  test("pixel gestures keep accumulating across direct streamed writes", async () => {
    const { term, controller } = await fixture();
    for (let n = 1; n <= 5; n++) {
      expect(controller.handleWheel({ deltaMode: 0, deltaY: -8 })).toBe(true);
      term.write("stream\r\n");
      if (n < 5) expect(term.getViewportY()).toBeCloseTo(n * 0.2);
    }
    expect(term.getViewportY()).toBe(2);
  });

  test.each(["scrollTo", "scrollBy"] as const)("%s cancels a pending native smooth gesture", async (method) => {
    const { term } = await fixture();
    term.options.smoothScrollDuration = 100;
    term.element!.querySelector("canvas")!.dispatchEvent(new WheelEvent("wheel", {
      bubbles: true, cancelable: true, deltaY: -3, deltaMode: 1,
    }));
    expect(term.viewport.offset).toBeGreaterThan(0);
    const expected = method === "scrollTo" ? 2.5 : term.viewport.offset + 2.5;
    term.viewport[method](2.5);
    expect(term.viewport.offset).toBe(expected);
    for (let n = 0; n < 3; n++) {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(performance.now());
      expect(term.viewport.offset).toBe(expected);
    }
  });

  test("output shifts an active gesture target with its anchored history", async () => {
    const { term } = await fixture();
    term.options.smoothScrollDuration = 100;
    term.element!.querySelector("canvas")!.dispatchEvent(new WheelEvent("wheel", {
      bubbles: true, cancelable: true, deltaY: -3, deltaMode: 1,
    }));
    const before = term.viewport.offset;
    expect(before).toBeGreaterThan(1);
    term.write("stream\r\n");
    expect(term.viewport.offset).toBe(before + 1);
    for (let n = 0; n < 4; n++) {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(performance.now());
    }
    expect(term.viewport.offset).toBe(4);
  });

});
