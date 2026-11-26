// @vitest-environment node
//
// The terminal widget's boundary: no app module reaches the widget package
// (`@chan/ghostty-web-ng`) past its public API. The package's TypeScript
// `private` members are private to the compiler only, so a cast reaches
// them at run time, and a member reached that way reads `undefined` once
// the package spells it `#private`: the reader does not fail, it takes
// whatever fallback it has. This check reads every app module through the
// TypeScript checker and reports, with file and line:
//
// 1. deep: an import, export, dynamic import, `import()` type or module
//    mock of a path inside the package other than its export map's entries;
// 2. cast: a cast of a widget value to a type it does not satisfy, `any`
//    and `unknown` included;
// 3. member: a read of a member the package does not make public, through
//    a bracket, a cast, `in`, `vi.spyOn` or `Reflect.get`;
// 4. patch: a write to a member of a widget object, `Object.assign` and its
//    kin on one, and any reach of a widget class's `prototype` (tests may
//    read and spy on its public members);
// 5. name: the name of one of the widget's implementation members, which
//    catches what has no widget type to check: a duck-typed parameter, a
//    Svelte template expression.
//
// Shipped modules are held to all five rules, tests to 1, 3 and 4. A dot
// read of a private member on a widget-typed value is a type error, which
// svelte-check reports, so rule 3 looks only where the type system does
// not. It is a property of every module, including ones not written yet,
// that no mounted test can observe, so it reads the source.

import ts from "typescript";
import { beforeAll, describe, expect, test } from "vitest";

/// A path with `.` and `..` resolved, in the forward slashes the
/// TypeScript API uses on every platform.
function normalize(path: string): string {
  const parts: string[] = [];
  for (const part of path.replace(/\\/g, "/").split("/")) {
    if (part === "..") parts.pop();
    else if (part !== "." && part !== "") parts.push(part);
  }
  return (path.startsWith("/") ? "/" : "") + parts.join("/");
}
const readText = (path: string) => {
  const text = ts.sys.readFile(path);
  if (text === undefined) throw new Error(`cannot read ${path}`);
  return text;
};

/// The app package: vitest runs in it, as the tests that read the vendored
/// core by a relative path also assume.
const APP = normalize(ts.sys.getCurrentDirectory());
const WIDGET = normalize(`${APP}/../ghostty-web-ng`);
const PACKAGE_NAME = "@chan/ghostty-web-ng";

/// The specifiers the package's export map serves.
const ENTRIES = new Set(
  Object.keys(JSON.parse(readText(`${WIDGET}/package.json`)).exports as Record<string, string>).map(
    (key) => (key === "." ? PACKAGE_NAME : `${PACKAGE_NAME}/${key.replace(/^\.\//, "")}`),
  ),
);

/// Implementation members of the widget an app module has no reason to name:
/// Terminal's core, which TypeScript still lists as public, and the parts
/// the widget holds privately.
const IMPLEMENTATION = new Set([
  "wasmTerm",
  "selectionManager",
  "inputHandler",
  "highlightsManager",
  "linkDetector",
  "buildWasmConfig",
  "hoveredHyperlinkId",
]);
/// Terminal's renderer, textarea and scroll offset, also listed as public:
/// other modules name objects of their own the same, so these count in the
/// terminal's own modules and elsewhere only on a receiver named like one.
const GENERIC = new Set(["renderer", "textarea", "viewportY"]);
const TERMINAL_MODULE = /^src\/(terminal\/|components\/TerminalTab\.svelte$)/;
const TERMINAL_RECEIVER = /term|ghostty|widget/i;

type Rule = "deep" | "cast" | "member" | "patch" | "name";
type Kind = "shipped" | "test";
const TEST_RULES: ReadonlySet<Rule> = new Set(["deep", "member", "patch"]);

type Finding = { rule: Rule; file: string; line: number; key: string };

/// A reader that is there today and that the change named in `until`
/// removes. An entry covers every occurrence of `key` (or of any key, with
/// none) under `rule` in `file`; one that matches nothing fails, so the
/// list only shrinks.
type Pending = { rule: Rule; file: string; key?: string; until: string };

const METRICS = "the terminal tab reads cell metrics through getMetrics()";
const REFRESH = "refreshTerminalRows needs refresh() and drops its renderer path";
const RENDERER_TESTS = "the renderer tests move into the package, over an opened terminal";

const PENDING: readonly Pending[] = [
  { rule: "name", file: "src/components/TerminalTab.svelte", key: "renderer", until: METRICS },
  { rule: "name", file: "src/terminal/renderer.ts", key: "renderer", until: REFRESH },
  { rule: "name", file: "src/terminal/renderer.ts", key: "wasmTerm", until: REFRESH },
  { rule: "member", file: "src/terminal/ghosttyRenderer.test.ts", until: RENDERER_TESTS },
  { rule: "patch", file: "src/terminal/ghosttyRenderer.test.ts", until: RENDERER_TESTS },
  { rule: "member", file: "src/terminal/ghosttyRenderer.redraw.test.ts", until: RENDERER_TESTS },
  { rule: "patch", file: "src/terminal/ghosttyRenderer.redraw.test.ts", until: RENDERER_TESTS },
  {
    rule: "member",
    file: "src/terminal/ghosttyTheme.test.ts",
    until: "the theme test reads the core's colours off the canvas, or moves into the package",
  },
  {
    rule: "member",
    file: "src/terminal/backend.test.ts",
    key: "GhosttyVt.wasm",
    until: "the kit test tells two instances apart by what their terminals show",
  },
  {
    rule: "member",
    file: "src/terminal/ghosttyViewport.change.test.ts",
    key: "Terminal.inputHandler",
    until: "the empty paste emit, which no input event produces, goes",
  },
];

/// A module as the program reads it: a `.ts` file whole, or one script
/// block of a component (`line` is its first line in the component), or a
/// component's markup with its scripts, styles and comments blanked so
/// lines keep their numbers (`markup`). `names` is whether rule 5 applies.
type Source = { file: string; rel: string; kind: Kind; text: string; line: number; markup: boolean; names: boolean };

function kindOf(rel: string): Kind | null {
  if (rel.endsWith(".d.ts") || !/\.(ts|svelte)$/.test(rel)) return null;
  if (rel.startsWith("src/")) {
    return rel.includes("/__tests__/") || /\.(test|e2e|measure)\.ts$/.test(rel) ? "test" : "shipped";
  }
  return /^(vitest\.setup|[^/]+\.test)\.ts$/.test(rel) ? "test" : null;
}

const blank = (text: string) => text.replace(/[^\n]/g, " ");

function sourcesOf(rel: string, text: string): Source[] {
  const kind = kindOf(rel);
  if (!kind) return [];
  const file = `${APP}/${rel}`;
  const names = kind === "shipped" && (TERMINAL_MODULE.test(rel) || text.includes(PACKAGE_NAME));
  if (!rel.endsWith(".svelte")) return [{ file, rel, kind, text, line: 1, markup: false, names }];
  const sources: Source[] = [];
  const script = /(<script\b[^>]*>)([\s\S]*?)<\/script>/g;
  for (let match: RegExpExecArray | null, i = 0; (match = script.exec(text)) !== null; i++) {
    const line = text.slice(0, match.index + match[1].length).split("\n").length;
    sources.push({ file: `${file}.${i}.ts`, rel, kind, text: match[2], line, markup: false, names });
  }
  const markup = text.replace(/<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>|<!--[\s\S]*?-->/g, blank);
  sources.push({ file, rel, kind, text: markup, line: 1, markup: true, names });
  return sources;
}

/// Every app module, with `plants` read in place of the disk.
function loadSources(plants: ReadonlyMap<string, string>): Source[] {
  const sources: Source[] = [];
  const files = [
    ...ts.sys.readDirectory(`${APP}/src`, [".ts", ".svelte"], undefined, ["**/*"]),
    ...ts.sys.readDirectory(APP, [".ts"], undefined, ["*"]),
  ];
  for (const path of files) {
    const rel = normalize(path).slice(APP.length + 1);
    if (kindOf(rel) && !plants.has(rel)) sources.push(...sourcesOf(rel, readText(path)));
  }
  for (const [rel, text] of plants) sources.push(...sourcesOf(rel, text));
  return sources;
}

function scan(plants: ReadonlyMap<string, string>): Finding[] {
  const sources = loadSources(plants);
  const modules = sources.filter((s) => !s.markup);
  const virtual = new Map(modules.filter((s) => s.rel.endsWith(".svelte") || plants.has(s.rel)).map((s) => [s.file, s.text]));
  const config = ts.readConfigFile(`${APP}/tsconfig.json`, ts.sys.readFile);
  const options = { ...ts.parseJsonConfigFileContent(config.config, ts.sys, APP).options, noEmit: true };
  const host = ts.createCompilerHost(options, true);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const getSourceFile = host.getSourceFile.bind(host);
  host.readFile = (f) => virtual.get(f) ?? readFile(f);
  host.fileExists = (f) => virtual.has(f) || fileExists(f);
  host.getSourceFile = (f, language, onError, create) => {
    const text = virtual.get(f);
    return text === undefined ? getSourceFile(f, language, onError, create) : ts.createSourceFile(f, text, language, true);
  };
  const program = ts.createProgram({ rootNames: modules.map((s) => s.file), options, host });
  const checker = program.getTypeChecker();
  const findings = new Map<string, Finding>();

  const inWidget = (fileName: string) =>
    (fileName.startsWith(`${WIDGET}/lib/`) || fileName.startsWith(`${WIDGET}/vt/`)) &&
    !fileName.endsWith(".test.ts") &&
    !fileName.includes("/__tests__/");
  const declaredInWidget = (symbol: ts.Symbol | undefined) =>
    !!symbol?.declarations?.some((d) => inWidget(d.getSourceFile().fileName));
  const widgetClass = (symbol: ts.Symbol | undefined) =>
    !!symbol && (symbol.flags & ts.SymbolFlags.Class) !== 0 && declaredInWidget(symbol);

  function isWidget(type: ts.Type, depth = 0): boolean {
    if (depth > 4) return false;
    if (type.isUnionOrIntersection()) return type.types.some((t) => isWidget(t, depth + 1));
    if (declaredInWidget(type.aliasSymbol) || declaredInWidget(type.getSymbol())) return true;
    const reference = (type as ts.TypeReference).target ? checker.getTypeArguments(type as ts.TypeReference) : [];
    return [...(type.aliasTypeArguments ?? []), ...reference].some((t) => isWidget(t, depth + 1));
  }
  const parts = (type: ts.Type) => {
    const t = checker.getNonNullableType(type);
    return t.isUnion() ? t.types : [t];
  };
  const isClassInstance = (type: ts.Type) => parts(type).some((t) => widgetClass(t.getSymbol()));
  const nameOf = (type: ts.Type) =>
    parts(type)
      .map((t) => t.getSymbol()?.getName())
      .find((name) => name !== undefined && !name.startsWith("__")) ?? checker.typeToString(type);

  const outer = (e: ts.Expression): ts.Expression => {
    while (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
    return e;
  };
  const isCast = (e: ts.Node): e is ts.AsExpression | ts.TypeAssertion =>
    (ts.isAsExpression(e) || ts.isTypeAssertionExpression(e)) &&
    !(ts.isTypeReferenceNode(e.type) && e.type.typeName.getText() === "const");

  /// The widget type a receiver was cast from: the receiver is a cast of a
  /// widget value, or a variable a cast or a type annotation widened one into.
  function castFrom(receiver: ts.Expression): ts.Type | undefined {
    let e = outer(receiver);
    if (ts.isIdentifier(e)) {
      const declaration = checker.getSymbolAtLocation(e)?.valueDeclaration;
      if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer) return undefined;
      e = outer(declaration.initializer);
      if (!declaration.type && !isCast(e)) return undefined;
    } else if (!isCast(e)) {
      return undefined;
    }
    while (isCast(e)) e = outer(e.expression);
    const origin = checker.getTypeAtLocation(e);
    return isWidget(origin) ? origin : undefined;
  }
  const widgetOf = (receiver: ts.Expression): ts.Type | undefined => {
    const own = checker.getTypeAtLocation(receiver);
    return isWidget(own) ? own : castFrom(receiver);
  };

  /// Whether some widget part of `type` lacks `name` or keeps it private.
  function hidden(type: ts.Type, name: string): boolean {
    return parts(type).some((part) => {
      if (!isWidget(part)) return false;
      const member = checker.getApparentType(part).getProperty(name);
      if (!member) return true;
      return (member.declarations ?? []).some((d) => {
        if (!inWidget(d.getSourceFile().fileName)) return false;
        const id = (d as ts.NamedDeclaration).name;
        if (id && ts.isPrivateIdentifier(id)) return true;
        return (ts.getCombinedModifierFlags(d as ts.Declaration) & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) !== 0;
      });
    });
  }

  const isDeep = (specifier: string, from: string) => {
    const bare = specifier.replace(/\?.*$/, "");
    if (bare === PACKAGE_NAME || bare.startsWith(`${PACKAGE_NAME}/`)) return !ENTRIES.has(bare);
    if (!bare.startsWith(".")) return false;
    const target = normalize(`${from.slice(0, from.lastIndexOf("/"))}/${bare}`);
    return target === WIDGET || target.startsWith(`${WIDGET}/`);
  };

  const MOCKS = new Set(["mock", "doMock", "unmock", "doUnmock", "importActual", "importMock"]);
  const DEFINERS: Record<string, ReadonlySet<string>> = {
    Object: new Set(["assign", "defineProperty", "defineProperties", "setPrototypeOf"]),
    Reflect: new Set(["set", "defineProperty", "deleteProperty", "setPrototypeOf"]),
  };
  const READERS = new Set(["vi.spyOn", "Reflect.get", "Reflect.has"]);

  /// The member a node names, and the receiver it names it on, if any.
  function memberNamed(node: ts.Node): { name: string; receiver?: ts.Expression } | undefined {
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name)) return { name: node.name.text, receiver: node.expression };
    if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
      return { name: node.argumentExpression.text, receiver: node.expression };
    }
    if (
      (ts.isPropertySignature(node) ||
        ts.isPropertyDeclaration(node) ||
        ts.isMethodSignature(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isPropertyAssignment(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node)) &&
      (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))
    ) {
      return { name: node.name.text };
    }
    if (ts.isShorthandPropertyAssignment(node)) return { name: node.name.text };
    if (ts.isBindingElement(node)) {
      const key = node.propertyName ?? node.name;
      if (ts.isIdentifier(key)) return { name: key.text };
    }
    return undefined;
  }
  const isImplementationName = (rel: string, name: string, receiver: string | undefined) =>
    IMPLEMENTATION.has(name) ||
    (GENERIC.has(name) && (TERMINAL_MODULE.test(rel) || (receiver !== undefined && TERMINAL_RECEIVER.test(receiver))));

  for (const source of sources) {
    const report = (rule: Rule, line: number, key: string) => {
      if (source.kind === "test" && !TEST_RULES.has(rule)) return;
      const finding = { rule, file: source.rel, line: line + source.line - 1, key };
      findings.set(show(finding), finding);
    };
    if (source.markup) {
      if (!source.names) continue;
      // The receiver is read back from the dot: a pattern that may start in
      // whitespace backtracks over the blanked scripts quadratically.
      const member = /\??\.\s*([\w$]+)/g;
      for (let match: RegExpExecArray | null; (match = member.exec(source.text)) !== null; ) {
        const receiver = /([\w$]+)\s*$/.exec(source.text.slice(Math.max(0, match.index - 80), match.index))?.[1];
        if (isImplementationName(source.rel, match[1], receiver)) {
          report("name", source.text.slice(0, match.index).split("\n").length, match[1]);
        }
      }
      continue;
    }
    const sf = program.getSourceFile(source.file);
    if (!sf) throw new Error(`the program did not read ${source.rel}`);
    const lineOf = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

    const read = (receiver: ts.Expression, name: string, at: ts.Node, typed: boolean) => {
      const widget = typed ? widgetOf(receiver) : castFrom(receiver);
      if (widget && hidden(widget, name)) report("member", lineOf(at), `${nameOf(widget)}.${name}`);
    };
    const written = (target: ts.Expression) => {
      const access = outer(target);
      if (!ts.isPropertyAccessExpression(access) && !ts.isElementAccessExpression(access)) return;
      const widget = widgetOf(access.expression);
      if (!widget || !isClassInstance(widget)) return;
      const name = ts.isPropertyAccessExpression(access) ? access.name.getText(sf) : access.argumentExpression.getText(sf);
      report("patch", lineOf(access), `write ${nameOf(widget)}.${name}`);
    };

    const visit = (node: ts.Node): void => {
      // 1. Imports past the export map.
      let specifier: ts.Node | undefined;
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) specifier = node.moduleSpecifier;
      if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
        specifier = node.moduleReference.expression;
      }
      if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) specifier = node.argument.literal;
      if (ts.isCallExpression(node) && node.arguments.length > 0) {
        const callee = node.expression;
        const dynamic = callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === "require");
        const mock =
          ts.isPropertyAccessExpression(callee) &&
          ts.isIdentifier(callee.expression) &&
          callee.expression.text === "vi" &&
          MOCKS.has(callee.name.text);
        if (dynamic || mock) specifier = node.arguments[0];
      }
      if (specifier && ts.isStringLiteralLike(specifier) && isDeep(specifier.text, source.file)) {
        report("deep", lineOf(specifier), specifier.text);
      }

      // 2. Casts of a widget value to a type it does not satisfy.
      if (isCast(node) && source.kind === "shipped") {
        const from = checker.getTypeAtLocation(node.expression);
        const to = checker.getTypeFromTypeNode(node.type);
        const wide = (to.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
        if (isWidget(from) && (wide || !checker.isTypeAssignableTo(checker.getNonNullableType(from), to))) {
          report("cast", lineOf(node), node.type.getText(sf));
        }
      }

      // 3. Reads of members the package keeps to itself.
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name)) read(node.expression, node.name.text, node, false);
      if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
        read(node.expression, node.argumentExpression.text, node, true);
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.InKeyword && ts.isStringLiteralLike(node.left)) {
        read(node.right, node.left.text, node, true);
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.arguments.length >= 2) {
        const [target, key] = node.arguments;
        if (READERS.has(node.expression.getText(sf)) && ts.isStringLiteralLike(key)) read(target, key.text, node, true);
      }

      // 4. Patches of widget objects.
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      ) {
        written(node.left);
      }
      if (
        (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
      ) {
        written(node.operand);
      }
      if (ts.isDeleteExpression(node)) written(node.expression);
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        DEFINERS[node.expression.expression.text]?.has(node.expression.name.text) &&
        node.arguments.length > 0
      ) {
        const widget = widgetOf(node.arguments[0]);
        if (widget && isClassInstance(widget)) report("patch", lineOf(node), `${node.expression.getText(sf)} ${nameOf(widget)}`);
      }
      if (ts.isPropertyAccessExpression(node) && node.name.text === "prototype" && source.kind === "shipped") {
        let symbol = checker.getSymbolAtLocation(node.expression);
        if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
        if (symbol && widgetClass(symbol)) report("patch", lineOf(node), `prototype ${symbol.getName()}`);
      }

      // 5. Implementation names.
      if (source.names) {
        const member = memberNamed(node);
        if (member && isImplementationName(source.rel, member.name, member.receiver?.getText(sf))) {
          report("name", lineOf(node), member.name);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return [...findings.values()];
}

/// Planted reads, scanned with the tree on every run so the check shows
/// each rule still fires where it should and nowhere else; they exist only
/// here.
const PLANTS = new Map<string, string>([
  [
    "src/terminal/boundaryPlant.ts",
    [
      'import { Terminal } from "@chan/ghostty-web-ng";',
      'import { CanvasRenderer } from "@chan/ghostty-web-ng/lib/renderer";',
      "export const cast = (term: Terminal) => term as unknown;",
      'export const read = (term: Terminal) => term["isOpen"];',
      "export const patch = (term: Terminal) => Object.assign(term, { cols: 1 });",
      "export const proto = () => [Terminal.prototype, CanvasRenderer];",
      "export const duck: { wasmTerm?: unknown } = {};",
      "export const narrow = (term: Terminal | null) => term as Terminal;",
    ].join("\n"),
  ],
  [
    "src/terminal/BoundaryPlant.svelte",
    [
      '<script lang="ts">',
      '  import type { Terminal } from "@chan/ghostty-web-ng";',
      "  let { term }: { term: Terminal } = $props();",
      "  const links = (term as unknown as { linkDetector: unknown }).linkDetector;",
      "</script>",
      "",
      "<p>{links}{term.renderer?.getMetrics()}</p>",
    ].join("\n"),
  ],
  [
    "src/terminal/boundaryPlant.test.ts",
    [
      'import { Terminal } from "@chan/ghostty-web-ng";',
      'import "../../../ghostty-web-ng/lib/renderer";',
      "export const read = (term: Terminal) => (term as unknown as { isOpen: boolean }).isOpen;",
      "export const write = (term: Terminal) => { (term as any).cols = 3; };",
      "export const duck = (t: { wasmTerm?: unknown }) => t.wasmTerm;",
      "export const cast = (term: Terminal) => term as unknown;",
      'export const spy = (term: Terminal) => [vi.spyOn(term, "write"), vi.spyOn(Terminal.prototype, "open")];',
    ].join("\n"),
  ],
]);

const PLANTED: readonly Finding[] = [
  { rule: "deep", file: "src/terminal/boundaryPlant.ts", line: 2, key: "@chan/ghostty-web-ng/lib/renderer" },
  { rule: "cast", file: "src/terminal/boundaryPlant.ts", line: 3, key: "unknown" },
  { rule: "member", file: "src/terminal/boundaryPlant.ts", line: 4, key: "Terminal.isOpen" },
  { rule: "patch", file: "src/terminal/boundaryPlant.ts", line: 5, key: "Object.assign Terminal" },
  { rule: "patch", file: "src/terminal/boundaryPlant.ts", line: 6, key: "prototype Terminal" },
  { rule: "name", file: "src/terminal/boundaryPlant.ts", line: 7, key: "wasmTerm" },
  { rule: "cast", file: "src/terminal/BoundaryPlant.svelte", line: 4, key: "unknown" },
  { rule: "member", file: "src/terminal/BoundaryPlant.svelte", line: 4, key: "Terminal.linkDetector" },
  { rule: "name", file: "src/terminal/BoundaryPlant.svelte", line: 4, key: "linkDetector" },
  { rule: "name", file: "src/terminal/BoundaryPlant.svelte", line: 7, key: "renderer" },
  { rule: "deep", file: "src/terminal/boundaryPlant.test.ts", line: 2, key: "../../../ghostty-web-ng/lib/renderer" },
  { rule: "member", file: "src/terminal/boundaryPlant.test.ts", line: 3, key: "Terminal.isOpen" },
  { rule: "patch", file: "src/terminal/boundaryPlant.test.ts", line: 4, key: "write Terminal.cols" },
];

function show(f: Finding): string {
  return `${f.rule} ${f.file}:${f.line} ${f.key}`;
}
const covers = (p: Pending, f: Finding) =>
  p.rule === f.rule && p.file === f.file && (p.key === undefined || p.key === f.key);

// Source-text contract: no app module reaches the terminal widget past its public API, in modules written later too.
describe("the terminal widget's boundary", () => {
  let real: Finding[] = [];
  let planted: Finding[] = [];
  beforeAll(() => {
    if (JSON.parse(readText(`${APP}/package.json`)).name !== "@chan/workspace-app") {
      throw new Error(`vitest runs in ${APP}, not in the workspace app`);
    }
    for (const rel of PLANTS.keys()) {
      if (ts.sys.fileExists(`${APP}/${rel}`)) throw new Error(`a planted module's path is taken: ${rel}`);
    }
    const findings = scan(PLANTS);
    real = findings.filter((f) => !PLANTS.has(f.file));
    planted = findings.filter((f) => PLANTS.has(f.file));
  }, 180_000);

  test("every rule fires on its planted reads, and only there", () => {
    expect(planted.map(show).sort()).toEqual(PLANTED.map(show).sort());
  });

  test("no app module reaches the widget past its public API, beyond the pending readers", () => {
    expect(real.filter((f) => !PENDING.some((p) => covers(p, f))).map(show)).toEqual([]);
  });

  test("every pending reader is still there", () => {
    expect(PENDING.filter((p) => !real.some((f) => covers(p, f)))).toEqual([]);
  });
});
