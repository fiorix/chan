import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { captureGhosttyTerminals } from "./ghostty-capture.mjs";

export class CaptureTestTerminal {
  open(...args) { this.openArgs = args; return "opened"; }
  write(...args) { this.writeArgs = args; return "written"; }
}

function fixture(t, { chunk = true, broken = false } = {}) {
  const module = `data:text/javascript,${encodeURIComponent(`export { CaptureTestTerminal as Terminal } from ${JSON.stringify(import.meta.url)};`)}`;
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "file:///capture/ghostty-web-test.js") {
        if (broken) throw new Error("chunk import failed");
        return { url: module, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
  });
  t.after(() => hooks.deregister());
  for (const [key, value] of Object.entries({
    window: {},
    document: { querySelectorAll: () => [{ src: "file:///capture/other.js" }, { src: "file:///capture/entry.js" }] },
  })) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    t.after(() => descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key]);
  }
  t.mock.method(globalThis, "fetch", async (url) => new Response(
    chunk && url.endsWith("entry.js") ? 'import("./ghostty-web-test.js")' : "// another module"));
  const open = CaptureTestTerminal.prototype.open, write = CaptureTestTerminal.prototype.write;
  t.after(() => Object.assign(CaptureTestTerminal.prototype, { open, write }));
  return { page: { evaluate: (fn, args) => fn(args) }, open, write };
}

test("capture delegates open with its receiver and arguments and restores the prototype", async (t) => {
  const { page, open, write } = fixture(t);
  assert.equal(await captureGhosttyTerminals(page, "capture"), "file:///capture/ghostty-web-test.js");
  const first = new CaptureTestTerminal(), second = new CaptureTestTerminal();
  const host = {};
  assert.equal(first.open(host, "extra"), "opened");
  second.open({});
  assert.deepEqual(first.openArgs, [host, "extra"]);
  assert.deepEqual(window.capture.terminals, [first, second]);
  assert.equal(CaptureTestTerminal.prototype.write, write);
  await assert.rejects(captureGhosttyTerminals(page, "capture"), /already installed/);
  const state = window.capture;
  state.restore();
  assert.equal(window.capture, undefined);
  assert.equal(CaptureTestTerminal.prototype.open, open);
  new CaptureTestTerminal().open({});
  assert.equal(state.terminals.length, 2, "restoration stops capture");
});

test("missing and broken chunks do not report a capture", async (t) => {
  for (const options of [{ chunk: false }, { broken: true }]) {
    await t.test(JSON.stringify(options), async (t) => {
      const { page, open } = fixture(t, options);
      if (options.broken) await assert.rejects(captureGhosttyTerminals(page, "capture"), /chunk import failed/);
      else assert.equal(await captureGhosttyTerminals(page, "capture"), null);
      assert.equal(window.capture, undefined);
      assert.equal(CaptureTestTerminal.prototype.open, open);
    });
  }
});

test("notice capture keeps transient text and short bytes while delegating every write", async (t) => {
  const { page, write } = fixture(t);
  await captureGhosttyTerminals(page, "capture", { notices: true });
  const term = new CaptureTestTerminal();
  const callback = () => {};
  for (const data of ["", new Uint8Array(), new Uint8Array(256), "ordinary output"]) {
    assert.equal(term.write(data, callback), "written");
    assert.deepEqual(term.writeArgs, [data, callback]);
  }
  assert.deepEqual(window.capture.notices, []);
  term.write("terminal replay missed 42 bytes\r\nterminal error: gone\r\n");
  term.write(new TextEncoder().encode("terminal error: short bytes\n"));
  term.write(new TextEncoder().encode("terminal error: " + "x".repeat(256)));
  assert.deepEqual(window.capture.notices, [
    "terminal replay missed 42 bytes", "terminal error: gone", "terminal error: short bytes",
  ]);
  window.capture.restore();
  assert.equal(CaptureTestTerminal.prototype.write, write);
});
