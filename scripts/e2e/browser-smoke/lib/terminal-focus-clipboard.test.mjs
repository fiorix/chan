import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { installHeldClipboard } from "./terminal-focus-clipboard.mjs";

function install(clipboard) {
  const context = { window: {}, navigator: { clipboard } };
  const result = vm.runInNewContext(`(${installHeldClipboard.toString()})()`, context);
  return { result, window: context.window };
}

test("native clipboard read runs once but its value waits for release", async () => {
  let calls = 0;
  const clipboard = { async readText() { assert.equal(this, clipboard); calls++; return "native answer"; } };
  const original = Object.getOwnPropertyDescriptor(clipboard, "readText");
  const { result, window } = install(clipboard);
  assert.equal(result.available, true);
  let delivered = false;
  const pending = clipboard.readText().then((value) => { delivered = true; return value; });
  // The instrument runs in another realm, whose promise adoption also
  // needs to finish before the native-read receipt is visible here.
  await new Promise(setImmediate);
  assert.equal(calls, 1);
  assert.equal(window.__heldClipboard.nativeStatus, "fulfilled");
  assert.equal(delivered, false);
  assert.equal(window.__heldClipboard.delivered, 0);
  window.__heldClipboard.release();
  assert.equal(await pending, "native answer");
  assert.equal(window.__heldClipboard.delivered, 1);
  window.__heldClipboard.restore();
  assert.deepEqual(Object.getOwnPropertyDescriptor(clipboard, "readText"), original);
  assert.equal(window.__heldClipboard, undefined);
});

test("native rejection is preserved and never becomes an empty successful read", async () => {
  const denied = new Error("denied");
  const clipboard = { readText() { throw denied; } };
  const { window } = install(clipboard);
  await assert.rejects(clipboard.readText(), (error) => error === denied);
  assert.equal(window.__heldClipboard.nativeStatus, "rejected");
  assert.equal(window.__heldClipboard.delivered, 0);
  window.__heldClipboard.restore();
});

test("cleanup releases a pending answer and restores an inherited native method", async () => {
  const prototype = { async readText() { return "cleanup"; } };
  const clipboard = Object.create(prototype);
  const { window } = install(clipboard);
  const pending = clipboard.readText();
  window.__heldClipboard.restore();
  assert.equal(await pending, "cleanup");
  assert.equal(Object.hasOwn(clipboard, "readText"), false);
  assert.equal(clipboard.readText, prototype.readText);
});

test("missing or nonreplaceable clipboard methods are unavailable", () => {
  assert.equal(install(null).result.available, false);
  const clipboard = {};
  Object.defineProperty(clipboard, "readText", { value() {}, configurable: false });
  const { result, window } = install(clipboard);
  assert.equal(result.available, false);
  assert.equal(window.__heldClipboard, undefined);
});
