// The pane's drag-and-drop highlights and the resize bars of the floating
// cards and of the docked handle wear the window's focus colour: the colour
// the person chose, else the window's preset, which a pane carries and the
// app root carries for what no pane encloses. The rules are read as text; the
// browser check `176-drag-focus-colour` reads the colours they paint.

import { describe, expect, test } from "vitest";

// Build-time contract: the drag, drop and resize rules read the focus colour expression, never the theme's fixed accent, the link colour or a literal, the app root carries the window's preset, and its presets equal the pane's; vitest drops component CSS.
import app from "../App.svelte?raw";
import pane from "./Pane.svelte?raw";
import inspector from "./Inspector.svelte?raw";
import resizeHandle from "./ResizeHandle.svelte?raw";

const FOCUS = "var(--pane-highlight-color, var(--pane-active-focus))";

type Rule = { selector: string; body: string };

function rules(source: string): Rule[] {
  const open = source.indexOf("<style");
  const close = source.indexOf("</style>");
  expect(open).toBeGreaterThanOrEqual(0);
  expect(close).toBeGreaterThan(open);
  const css = source.slice(source.indexOf(">", open) + 1, close).replace(/\/\*[\s\S]*?\*\//g, "");
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selector: m[1].replace(/\s+/g, " ").trim(),
    body: m[2],
  }));
}

/// Every rule that names `selector` in its selector list: a selector can sit
/// in a group rule and in a rule of its own.
function rulesFor(source: string, selector: string): Rule[] {
  const found = rules(source).filter((r) => r.selector.split(",").map((s) => s.trim()).includes(selector));
  expect(found.length, selector).toBeGreaterThan(0);
  return found;
}

/// The one declaration of `property` among the rules that name `selector`.
function declaration(source: string, selector: string, property: string): string {
  const values = rulesFor(source, selector).flatMap((r) =>
    [...r.body.matchAll(new RegExp(`(?:^|;)\\s*${property}\\s*:([^;]*)`, "g"))].map((m) => m[1].trim()),
  );
  expect(values, `${selector} ${property}`).toHaveLength(1);
  return values[0];
}

/// What a rule paints once the expression is taken out: a fixed colour left
/// beside it is the theme's accent, the link colour or a literal hex.
function fixedColours(body: string): string[] {
  const rest = body.split(FOCUS).join("");
  return rest.match(/var\(--pane-focus\)|var\(--link\)|#[0-9a-fA-F]{3,8}\b/g) ?? [];
}

const PANE_RULES: Array<[string, string[]]> = [
  [".tabs.drop-active", ["box-shadow"]],
  [".drop-bar", ["background"]],
  [".pane.transaction-grab", ["outline"]],
  [".pane.transaction-drop-target::after", ["border", "background"]],
  [".pane.transaction-split-left::before", ["border", "background"]],
  [".editor-wrap.body-drop-left::after", ["border-left", "background"]],
  [".editor-wrap.body-drop-right::after", ["border-right", "background"]],
  [".editor-wrap.body-drop-top::after", ["border-top", "background"]],
  [".editor-wrap.body-drop-bottom::after", ["border-bottom", "background"]],
];

describe("the pane's drag and drop highlights", () => {
  test.each(PANE_RULES)("%s paints the focus colour", (selector, properties) => {
    for (const property of properties) expect(declaration(pane, selector, property)).toContain(FOCUS);
    for (const r of rulesFor(pane, selector)) expect(fixedColours(r.body), r.selector).toEqual([]);
  });

  test("no drag, drop or move rule of the pane names a fixed colour", () => {
    const dragRules = rules(pane).filter((r) =>
      /drop-active|drop-bar|body-drop-|transaction-(grab|drop-target|split-)/.test(r.selector),
    );
    expect(dragRules.length).toBeGreaterThanOrEqual(PANE_RULES.length);
    for (const r of dragRules) expect(fixedColours(r.body), r.selector).toEqual([]);
  });
});

describe("the resize bars", () => {
  test("a floating card's bar paints the focus colour on hover and on keyboard focus", () => {
    for (const selector of [".floating-resize:hover", ".floating-resize:focus-visible"]) {
      expect(declaration(inspector, selector, "background")).toBe(FOCUS);
    }
  });

  test("the docked handle paints the focus colour on hover and stays neutral at rest", () => {
    expect(declaration(resizeHandle, ".handle:hover", "background")).toBe(FOCUS);
    expect(declaration(resizeHandle, ".handle", "background")).toBe("var(--separator)");
    expect(declaration(resizeHandle, ".handle.invisible-idle", "background")).toBe("transparent");
  });

  test("the hover rule follows the idle-invisible rule, so an idle-invisible handle paints on hover", () => {
    const order = rules(resizeHandle).map((r) => r.selector);
    expect(order.indexOf(".handle:hover")).toBeGreaterThan(order.indexOf(".handle.invisible-idle"));
  });
});

describe("the window's preset", () => {
  test("the app root carries the window's preset", () => {
    const tag = app.match(/<div class="app"[^>]*>/)?.[0];
    expect(tag, "the app root's tag").toBeDefined();
    expect(tag).toContain("data-focus-color={focusColorForWindow()}");
  });

  test.each(["blue", "orange", "green", "pink"])("the app root's %s preset is the pane's", (color) => {
    const fromApp = declaration(app, `.app[data-focus-color="${color}"]`, "--pane-active-focus");
    expect(fromApp).toBe(declaration(pane, `.pane[data-focus-color="${color}"]`, "--pane-active-focus"));
  });
});
