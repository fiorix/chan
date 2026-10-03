import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const shared = readFileSync("src/styles.css", "utf8");
const topBar = readFileSync("src/components/TopBar.svelte", "utf8");
const app = readFileSync("src/App.svelte", "utf8");
const confirm = readFileSync("src/components/ConfirmDialog.svelte", "utf8");

function rule(source: string, selector: string): string {
  const start = source.indexOf(`${selector} {`);
  expect(start, `${selector} rule exists`).toBeGreaterThanOrEqual(0);
  const body = source.slice(start + selector.length + 2);
  return body.slice(0, body.indexOf("}"));
}

describe("launcher button stylesheet ownership", () => {
  test("the top bar reads equal icon properties from the launcher primitive", () => {
    expect(topBar).toContain('class="icon-btn command"');
    expect(topBar).toContain('class="icon-btn select"');
    const base = rule(shared, ".icon-btn");
    const local = rule(topBar, "  .icon-btn");
    for (const property of ["display", "align-items", "justify-content", "width", "height", "border", "background", "cursor", "transition"]) {
      const declaration = new RegExp(`(^|\\n)\\s*${property}:`);
      expect(base).toMatch(declaration);
      expect(local).not.toMatch(declaration);
    }
    expect(rule(topBar, "  .icon-btn:hover")).not.toMatch(/border-color:/);
  });

  test("the update and confirm buttons wear the launcher's button rules", () => {
    expect(confirm).toContain('class="btn"');
    expect(confirm).toContain('class="btn primary"');
    expect(app).toContain('class="btn secondary"');
    expect(app).toContain('class="btn primary"');
    const button = rule(app, "  .update-actions button");
    for (const property of ["padding", "border-radius", "font", "cursor"]) {
      expect(button).not.toMatch(new RegExp(`(^|\\n)\\s*${property}:`));
    }
    expect(app).not.toContain(".update-actions .secondary {");
    expect(app).not.toContain(".update-actions .primary {");
    expect(rule(shared, ".btn")).toContain("border-radius: 7px;");
    expect(rule(shared, ".btn.primary")).toContain("background: var(--brand);");
  });
});
