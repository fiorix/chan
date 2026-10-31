// @vitest-environment jsdom
import { expect, test } from "vitest";
import { browserKeyCommand } from "./browserKeymap";

const key = (key: string, init: KeyboardEventInit = {}) => new KeyboardEvent("keydown", { key, ...init });

test("standard and Vim bindings resolve to the same commands", () => {
  expect(browserKeyCommand(key("ArrowDown"), false, "")).toBe("next");
  expect(browserKeyCommand(key("j"), true, "")).toBe("next");
  expect(browserKeyCommand(key("j"), false, "")).toBeNull();
  expect(browserKeyCommand(key("g"), true, "g")).toBe("first");
  expect(browserKeyCommand(key("g"), true, "")).toBeNull();
  expect(browserKeyCommand(key("F10", { shiftKey: true }), false, "")).toBe("menu");
});

test("leaves composing input and reserved modifier combinations alone", () => {
  expect(browserKeyCommand(key("j", { isComposing: true }), true, "")).toBeNull();
  expect(browserKeyCommand(key("l", { metaKey: true }), true, "")).toBeNull();
  expect(browserKeyCommand(key("j", { altKey: true }), true, "")).toBeNull();
  expect(browserKeyCommand(key("ArrowDown", { ctrlKey: true }), false, "")).toBe("next");
});
