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
  const unopened = new CaptureTestTerminal();
  unopened.write("terminal error: outside capture\n");
  assert.deepEqual(window.capture.notices, [], "only captured instances are observed");
  assert.equal(CaptureTestTerminal.prototype.write, write, "the public write prototype stays intact");
  const term = new CaptureTestTerminal();
  term.open({});
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
  assert.equal(Object.hasOwn(term, "write"), false, "restoration removes the instance wrapper");
  term.write("terminal error: after restore\n");
});

test("notice capture restores an instance's own write method", async (t) => {
  const { page } = fixture(t);
  await captureGhosttyTerminals(page, "capture", { notices: true });
  const term = new CaptureTestTerminal();
  const write = function (data) { assert.equal(this, term); return data; };
  Object.defineProperty(term, "write", { value: write, writable: true, configurable: true });
  const descriptor = Object.getOwnPropertyDescriptor(term, "write");
  term.open({});
  term.open({});
  assert.equal(term.write("terminal error: once"), "terminal error: once");
  assert.deepEqual(window.capture.notices, ["terminal error: once"]);
  window.capture.restore();
  assert.deepEqual(Object.getOwnPropertyDescriptor(term, "write"), descriptor);
});


for (const order of [["first", "second"], ["second", "first"]]) {
  test(`nested captures restore in ${order.join(" then ")} order`, async (t) => {
    const { page, open, write } = fixture(t);
    for (const key of ["first", "second"]) await captureGhosttyTerminals(page, key, { notices: true });
    const states = { first: window.first, second: window.second };
    const term = new CaptureTestTerminal();
    term.open({});
    term.write("terminal error: both");
    states[order[0]].restore();
    const other = new CaptureTestTerminal();
    other.open({});
    term.write("terminal error: remaining");
    other.write("terminal error: new");
    assert.deepEqual(states[order[0]].terminals, [term]);
    assert.deepEqual(states[order[0]].notices, ["terminal error: both"]);
    assert.deepEqual(states[order[1]].terminals, [term, other]);
    assert.deepEqual(states[order[1]].notices, ["terminal error: both", "terminal error: remaining", "terminal error: new"]);
    states[order[1]].restore();
    assert.equal(CaptureTestTerminal.prototype.open, open);
    assert.equal(term.write, write);
    assert.equal(other.write, write);
    assert.equal(Object.hasOwn(term, "write"), false);
    assert.equal(Object.hasOwn(other, "write"), false);
  });
}
