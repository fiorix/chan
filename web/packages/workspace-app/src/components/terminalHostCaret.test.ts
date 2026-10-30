// The terminal draws its own cursor, so the host element, contenteditable
// under ghostty-web, never shows the browser caret. vitest drops component
// CSS, so the rule is read as text.

import { expect, test } from "vitest";
import source from "./TerminalTab.svelte?raw";

test("the terminal host hides the browser caret", () => {
  const css = source
    .slice(source.indexOf("<style"), source.indexOf("</style>"))
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const host = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find((m) => m[1].trim() === ".terminal-host");
  expect(host?.[2]).toMatch(/caret-color:\s*transparent;/);
});
