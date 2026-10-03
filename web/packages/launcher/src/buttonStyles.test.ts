import { readFileSync } from "node:fs";
import { compile, parse, type AST } from "svelte/compiler";
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

// What a top bar button wears, resolved from its two sheets by specificity and
// source order. jsdom applies no stylesheet and has no pointer, so no mounted
// test can see which rule wins under `:hover`.

type Specificity = [number, number, number];

interface ButtonState {
  classes: string[];
  hover: boolean;
}

interface SheetRule {
  selector: AST.CSS.ComplexSelector;
  declarations: AST.CSS.Declaration[];
  /// Inside an at-rule, whose condition this cascade does not evaluate.
  conditional: boolean;
}

function sheetRules(css: string): SheetRule[] {
  const sheet = parse(`<style>${css}</style>`, { modern: true }).css;
  if (!sheet) throw new Error("the sheet did not parse");
  const rules: SheetRule[] = [];
  const collect = (nodes: AST.CSS.Block["children"], conditional: boolean): void => {
    for (const node of nodes) {
      if (node.type === "Declaration") continue;
      if (node.type === "Atrule") {
        // A keyframe block holds keyframe selectors, not style rules.
        if (node.name !== "keyframes" && node.block) collect(node.block.children, true);
        continue;
      }
      const declarations = node.block.children.filter(
        (child): child is AST.CSS.Declaration => child.type === "Declaration",
      );
      for (const selector of node.prelude.children) {
        rules.push({ selector, declarations, conditional });
      }
    }
  };
  collect(sheet.children, false);
  return rules;
}

// The order a browser reads them in: the entry imports the app before the
// launcher's sheet, so the sheet's rules come last and win a tie. The top
// bar's rules are the compiler's output, which carries its scoping class.
const topBarCss = compile(topBar, { filename: "TopBar.svelte", css: "external" }).css?.code;
if (!topBarCss) throw new Error("TopBar compiled to no stylesheet");
const cascade = [...sheetRules(topBarCss), ...sheetRules(shared)];

function matchesAny(list: AST.CSS.SelectorList, state: ButtonState): boolean {
  return list.children.some((selector) => matches(selector, state));
}

/// Whether a selector's subject is this button. A check it cannot make throws.
function matches(selector: AST.CSS.ComplexSelector, state: ButtonState): boolean {
  const subject = selector.children[selector.children.length - 1].selectors;
  const named = subject.every((simple) => {
    if (simple.type === "ClassSelector") {
      return state.classes.includes(simple.name) || simple.name.startsWith("svelte-");
    }
    if (simple.type === "TypeSelector") return simple.name === "*" || simple.name === "button";
    return simple.type === "PseudoClassSelector";
  });
  if (!named) return false;
  if (selector.children.length > 1) throw new Error("cannot evaluate a button's ancestors");
  return subject.every((simple) => {
    if (simple.type !== "PseudoClassSelector") return true;
    if (simple.name === "hover") return state.hover;
    if (simple.name === "disabled" || simple.name === "root") return false;
    if (simple.name === "not" && simple.args) return !matchesAny(simple.args, state);
    throw new Error(`cannot evaluate :${simple.name}`);
  });
}

function specificity(selector: AST.CSS.ComplexSelector): Specificity {
  const total: Specificity = [0, 0, 0];
  for (const relative of selector.children) {
    for (const simple of relative.selectors) {
      if (simple.type === "IdSelector") total[0] += 1;
      else if (simple.type === "ClassSelector" || simple.type === "AttributeSelector") total[1] += 1;
      else if (simple.type === "PseudoElementSelector") total[2] += 1;
      else if (simple.type === "TypeSelector") total[2] += simple.name === "*" ? 0 : 1;
      else if (simple.type === "PseudoClassSelector") {
        if (simple.name === "where") continue;
        if (!simple.args) {
          total[1] += 1;
          continue;
        }
        if (simple.name !== "not" && simple.name !== "is") {
          throw new Error(`cannot weigh :${simple.name}()`);
        }
        // :not() and :is() weigh as their heaviest argument.
        const heaviest = simple.args.children.map(specificity).sort(compare).pop() ?? [0, 0, 0];
        for (const index of [0, 1, 2] as const) total[index] += heaviest[index];
      }
    }
  }
  return total;
}

function compare(a: Specificity, b: Specificity): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/// The declared value that wins for `property` on a button in `state`.
function resolved(state: ButtonState, property: "color" | "border-color"): string {
  // A `border` shorthand sets the colour too.
  const names = property === "border-color" ? ["border-color", "border"] : [property];
  let winner: { value: string; rank: Specificity } | null = null;
  for (const rule of cascade) {
    const declaration = rule.declarations.filter((each) => names.includes(each.property)).pop();
    if (!declaration || !matches(rule.selector, state)) continue;
    if (rule.conditional) throw new Error(`a rule inside an at-rule sets ${property}`);
    if (declaration.value.includes("!important")) throw new Error(`${property} is !important`);
    const rank = specificity(rule.selector);
    if (!winner || compare(rank, winner.rank) >= 0) winner = { value: declaration.value, rank };
  }
  if (!winner) throw new Error(`no rule sets ${property}`);
  return winner.value;
}

describe("launcher button stylesheet ownership", () => {
  test("the top bar reads equal icon properties from the launcher primitive", () => {
    expect(topBar).toContain('class="icon-btn command"');
    expect(topBar).toContain('class="icon-btn select"');
    const base = rule(shared, ".icon-btn");
    for (const property of ["display", "align-items", "justify-content", "width", "height", "border", "background", "cursor", "transition"]) {
      const declaration = new RegExp(`(^|\\n)\\s*${property}:`);
      expect(base).toMatch(declaration);
    }
    expect(topBar).not.toContain("  .icon-btn {");
    expect(topBar).not.toContain("  .icon-btn:hover {");
    expect(base).toContain("border-radius: 7px;");
    expect(base).toContain("color: var(--text-secondary);");
    expect(rule(shared, ".icon-btn:hover:not(:disabled)")).toContain("color: var(--text);");
  });

  test("the Select active tint reads the identical shared on rule", () => {
    expect(topBar).toContain("class:on={selection.selectMode}");
    expect(topBar).not.toContain("  .icon-btn.select.active {");
    const on = rule(shared, ".icon-btn.on");
    expect(on).toContain("border-color: var(--accent);");
    expect(on).toContain("color: var(--accent);");
    expect(on).toContain("background: color-mix(in srgb, var(--accent) 14%, transparent);");
  });

  // The cascade: the sheet's hover rule outranks its `.on` tint.
  test("the Select toggle keeps its accent under the pointer while on", () => {
    const off: ButtonState = { classes: ["icon-btn", "select"], hover: true };
    const on: ButtonState = { classes: ["icon-btn", "select", "on"], hover: true };
    // The hover rule is in play: a toggle that is off takes its border and
    // colour.
    expect(resolved(off, "border-color")).toBe("var(--brand)");
    expect(resolved(off, "color")).toBe("var(--text)");
    expect(resolved(on, "border-color")).toBe("var(--accent)");
    expect(resolved(on, "color")).toBe("var(--accent)");
  });

  // The cascade: the Command toggle's own rule outranks the sheet's hover rule.
  test("the Command toggle keeps its tint under the pointer while active", () => {
    const active: ButtonState = { classes: ["icon-btn", "command", "active"], hover: true };
    // The hover rule's border is the brand colour too, so the colour is what
    // tells the two rules apart.
    expect(resolved(active, "color")).toBe("var(--brand)");
  });

  test("the update and confirm buttons wear the launcher's button rules", () => {
    expect(confirm).toContain('class="btn"');
    expect(confirm).toContain('class="btn primary"');
    expect(app).toContain('class="btn secondary"');
    expect(app).toContain('class="btn primary"');
    const button = rule(app, "  .update-actions button");
    expect(button).toContain("font-family: inherit;");
    for (const property of ["padding", "border-radius", "font", "cursor"]) {
      expect(button).not.toMatch(new RegExp(`(^|\\n)\\s*${property}:`));
    }
    expect(app).not.toContain(".update-actions .secondary {");
    expect(app).not.toContain(".update-actions .primary {");
    expect(app).not.toContain(".update-actions button:disabled {");
    expect(rule(shared, ".btn")).toContain("padding: 0.5rem 0.9rem;");
    expect(rule(shared, ".btn")).toContain("border-radius: 7px;");
    expect(rule(shared, ".btn:disabled")).toContain("opacity: 0.55;");
    expect(rule(shared, ".btn:disabled")).toContain("cursor: default;");
    expect(rule(shared, ".btn.primary")).toContain("background: var(--brand);");
  });
});
