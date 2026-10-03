import { expect, test } from "vitest";

// Build-time contract: the JSON view's value colours are tokens both of App.svelte's theme blocks define, and JsonNode names no theme, so the nearest themed surface decides; jsdom applies no stylesheet.
import app from "../App.svelte?raw";
import node from "./JsonNode.svelte?raw";

const VALUE_TOKENS: Array<[string, string]> = [
  ["string", "--json-string"],
  ["number", "--json-number"],
  ["boolean", "--json-boolean"],
];

test("each theme block defines the JSON value colours", () => {
  const [dark, light] = app.split(':global([data-theme="light"])');
  for (const [theme, block] of [["dark", dark], ["light", light]] as const) {
    for (const [, token] of VALUE_TOKENS) {
      expect(block, `${token} in the ${theme} block`).toMatch(new RegExp(`${token}: #[0-9a-f]{6};`));
    }
  }
});

test("a JSON value takes its colour from the theme's token, and the node names no theme", () => {
  for (const [value, token] of VALUE_TOKENS) {
    expect(node, value).toMatch(new RegExp(`\\.${value} \\{\\s*color: var\\(${token}\\);`));
  }
  expect(node).not.toContain("[data-theme");
});
