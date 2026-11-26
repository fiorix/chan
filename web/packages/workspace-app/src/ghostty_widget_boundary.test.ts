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
// 1. deep: an import, export, dynamic import, `import()` type, module mock
//    or `import.meta.glob` pattern that reaches a path inside the package
//    other than its export map's entries;
// 2. cast: a cast of a widget value to a type it does not satisfy, `any`
//    and `unknown` included;
// 3. member: a read of a member the package does not make public, by a
//    dot, a bracket or a destructuring on a widget value or one cast from
//    it, `in`, `vi.spyOn`, `Reflect.get`, `Reflect.has`,
//    `getOwnPropertyDescriptor` or `Object.hasOwn`, a key under a cast
//    included;
// 4. patch: a write to a member of a widget object, `Object.assign` and its
//    kin on one, and any reach of a widget's prototype: a widget class's
//    `prototype`, or a widget value's `constructor`, `Object.getPrototypeOf`
//    or `Reflect.getPrototypeOf` (tests may reach one to read and spy on
//    its public members);
// 5. name: the name of one of the widget's implementation members, which
//    catches what has no widget type to check: a duck-typed parameter, a
//    Svelte template expression.
//
// Shipped modules are held to all five rules, tests to 1, 3 and 4. A dot
// read of a private member on a widget-typed value is a type error, but
// `@ts-expect-error` and `@ts-ignore` keep svelte-check from reporting it,
// so rule 3 reads dots as well. It is a property of every module,
// including ones not written yet, that no mounted test can observe, so it
// reads the source.

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

/// Who removes a pending reader: the app's terminal code, or the widget
/// package by taking over what the reader tests.
type Owner = "app terminal" | "widget package";

/// Readers that are there today and that the change named in `until`
/// removes. An entry covers the findings of `key` under `rule` in `file`,
/// and `count` is how many: the check fails when an entry covers more or
/// fewer, so a new reader in a listed file fails as it would anywhere
/// else, and each reader that goes takes its count down with it.
type Pending = { rule: Rule; file: string; key: string; count: number; owner: Owner; until: string };

/// The entries of one owner, change, rule and file, a count per key.
const pending = (owner: Owner, until: string, rule: Rule, file: string, counts: Record<string, number>): Pending[] =>
  Object.entries(counts).map(([key, count]) => ({ rule, file, key, count, owner, until }));

const TAB = "src/components/TerminalTab.svelte";
const ONE_TERMINAL = "the terminal tab and its helpers hold the widget's terminal alone";
const METRICS = "the terminal tab reads cell metrics through getMetrics()";
const REFRESH = "refreshTerminalRows needs refresh() and drops its renderer path";
const FIND = "the find bar runs on the widget's term.search";
const RENDERER_TESTS = "the renderer tests move into the package, over an opened terminal";
const THEME = "the theme test reads the core's colours off the canvas, or moves into the package";
const KIT = "the kit test tells two instances apart by what their terminals show";
const EMPTY_PASTE = "the empty paste emit, which no input event produces, goes";

const PENDING: readonly Pending[] = [
  ...pending("app terminal", ONE_TERMINAL, "cast", TAB, {
    GhosttyTerminal: 4,
    "GhosttyTerminal | null": 7,
    Terminal: 3,
    "Terminal | null": 1,
  }),
  ...pending("app terminal", ONE_TERMINAL, "name", TAB, { viewportY: 1 }),
  ...pending("app terminal", ONE_TERMINAL, "cast", "src/terminal/primarySelection.ts", {
    GhosttyTerminal: 1,
    XtermTerminal: 2,
  }),
  ...pending("app terminal", ONE_TERMINAL, "member", "src/terminal/primarySelection.ts", {
    "Terminal.onSelectionChange": 1,
  }),
  ...pending("app terminal", ONE_TERMINAL, "name", "src/terminal/secretMaskingXterm.ts", { viewportY: 2 }),
  ...pending("app terminal", METRICS, "name", TAB, { renderer: 4 }),
  ...pending("app terminal", REFRESH, "name", "src/terminal/renderer.ts", { renderer: 3, wasmTerm: 3 }),
  ...pending("app terminal", FIND, "name", "src/terminal/ghosttyFind.ts", { wasmTerm: 1 }),
  ...pending("app terminal", FIND, "member", "src/terminal/ghosttyFind.test.ts", {
    "VtTerminal.resizeListeners": 2,
    "VtTerminal.wasm": 3,
  }),
  ...pending("widget package", RENDERER_TESTS, "member", "src/terminal/ghosttyRenderer.test.ts", {
    "Terminal.buildWasmConfig": 3,
    "Terminal.selectionManager": 1,
  }),
  ...pending("widget package", RENDERER_TESTS, "patch", "src/terminal/ghosttyRenderer.test.ts", {
    "write Terminal.element": 1,
    "write Terminal.renderer": 4,
    "write Terminal.selectionManager": 1,
    "write Terminal.wasmTerm": 4,
  }),
  ...pending("widget package", RENDERER_TESTS, "member", "src/terminal/ghosttyRenderer.redraw.test.ts", {
    "CanvasRenderer.cursorVisible": 1,
    "CanvasRenderer.hoveredHyperlinkId": 1,
    "CanvasRenderer.hoveredLinkRange": 1,
    "CanvasRenderer.selectionManager": 1,
    "Terminal.selectionManager": 1,
  }),
  ...pending("widget package", RENDERER_TESTS, "patch", "src/terminal/ghosttyRenderer.redraw.test.ts", {
    "write CanvasRenderer.cursorVisible": 1,
    "write Terminal.renderer": 1,
    "write Terminal.selectionManager": 1,
    "write Terminal.viewportY": 3,
    "write Terminal.wasmTerm": 1,
  }),
  ...pending("app terminal", THEME, "member", "src/terminal/ghosttyTheme.test.ts", {
    "CanvasRenderer.ctx": 2,
    "VtTerminal.handle": 1,
    "VtTerminal.wasm": 4,
  }),
  ...pending("app terminal", KIT, "member", "src/terminal/backend.test.ts", { "GhosttyVt.wasm": 1 }),
  ...pending("app terminal", EMPTY_PASTE, "member", "src/terminal/ghosttyViewport.change.test.ts", {
    "Terminal.inputHandler": 1,
  }),
];

/// A module as the program reads it: a `.ts` file whole, or one script
/// block of a component (`line` is its first line in the component), or a
/// component's markup with its scripts, styles and comments blanked so
/// lines keep their numbers (`markup`).
type Source = { file: string; rel: string; kind: Kind; text: string; line: number; markup: boolean };

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
  if (!rel.endsWith(".svelte")) return [{ file, rel, kind, text, line: 1, markup: false }];
  const sources: Source[] = [];
  const script = /(<script\b[^>]*>)([\s\S]*?)<\/script>/g;
  for (let match: RegExpExecArray | null, i = 0; (match = script.exec(text)) !== null; i++) {
    const line = text.slice(0, match.index + match[1].length).split("\n").length;
    sources.push({ file: `${file}.${i}.ts`, rel, kind, text: match[2], line, markup: false });
  }
  const markup = text.replace(/<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>|<!--[\s\S]*?-->/g, blank);
  sources.push({ file, rel, kind, text: markup, line: 1, markup: true });
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
  /// Whether a Vite glob can match a file in the package: a package
  /// specifier past the export map, or a path whose part before the first
  /// wildcard is in the package or a directory above it.
  const globReaches = (pattern: string, from: string) => {
    if (pattern.startsWith("!")) return false;
    if (!pattern.startsWith(".") && !pattern.startsWith("/")) return isDeep(pattern, from);
    const wild = pattern.search(/[*?[{(]/);
    const fixed = wild === -1 ? pattern : pattern.slice(0, wild);
    const base = pattern.startsWith("/") ? APP : from.slice(0, from.lastIndexOf("/"));
    const target = normalize(`${base}/${fixed.slice(0, fixed.lastIndexOf("/") + 1)}`);
    return target === WIDGET || target.startsWith(`${WIDGET}/`) || WIDGET.startsWith(`${target}/`);
  };

  const MOCKS = new Set(["mock", "doMock", "unmock", "doUnmock", "importActual", "importMock"]);
  const DEFINERS: Record<string, ReadonlySet<string>> = {
    Object: new Set(["assign", "defineProperty", "defineProperties", "setPrototypeOf"]),
    Reflect: new Set(["set", "defineProperty", "deleteProperty", "setPrototypeOf"]),
  };
  const READERS = new Set([
    "vi.spyOn",
    "Reflect.get",
    "Reflect.has",
    "Reflect.getOwnPropertyDescriptor",
    "Object.getOwnPropertyDescriptor",
    "Object.hasOwn",
  ]);
  const PROTOTYPE_READERS = new Set(["Object.getPrototypeOf", "Reflect.getPrototypeOf"]);

  /// A string key as written, through parentheses and casts.
  function literalKey(e: ts.Expression): string | undefined {
    while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isTypeAssertionExpression(e) || ts.isSatisfiesExpression(e)) {
      e = e.expression;
    }
    return ts.isStringLiteralLike(e) ? e.text : undefined;
  }

  /// The member a dot or a string-keyed bracket reads, and its receiver.
  function access(node: ts.Node): { name: string; receiver: ts.Expression } | undefined {
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name)) return { name: node.name.text, receiver: node.expression };
    if (!ts.isElementAccessExpression(node)) return undefined;
    const key = literalKey(node.argumentExpression);
    return key === undefined ? undefined : { name: key, receiver: node.expression };
  }

  /// The member a node names, and the receiver it names it on, if any.
  function memberNamed(node: ts.Node): { name: string; receiver?: ts.Expression } | undefined {
    const reached = access(node);
    if (reached) return reached;
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
      if (source.kind !== "shipped") continue;
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

    const read = (receiver: ts.Expression, name: string, at: ts.Node) => {
      const widget = widgetOf(receiver);
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
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isMetaProperty(node.expression.expression) &&
        node.expression.name.text === "glob" &&
        node.arguments.length > 0
      ) {
        const [first] = node.arguments;
        for (const pattern of ts.isArrayLiteralExpression(first) ? first.elements : [first]) {
          if (ts.isStringLiteralLike(pattern) && globReaches(pattern.text, source.file)) report("deep", lineOf(pattern), pattern.text);
        }
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
      const reached = access(node);
      if (reached) read(reached.receiver, reached.name, node);
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.InKeyword) {
        const key = literalKey(node.left);
        if (key !== undefined) read(node.right, key, node);
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.arguments.length >= 2) {
        const key = literalKey(node.arguments[1]);
        if (key !== undefined && READERS.has(node.expression.getText(sf))) read(node.arguments[0], key, node);
      }
      if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer) {
        for (const element of node.name.elements) {
          const key = element.propertyName ?? element.name;
          if (!element.dotDotDotToken && (ts.isIdentifier(key) || ts.isStringLiteral(key))) read(node.initializer, key.text, element);
        }
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
      if (source.kind === "shipped" && reached?.name === "prototype") {
        let symbol = checker.getSymbolAtLocation(reached.receiver);
        if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
        if (symbol && widgetClass(symbol)) report("patch", lineOf(node), `prototype ${symbol.getName()}`);
      }
      if (source.kind === "shipped" && reached?.name === "constructor") {
        const widget = widgetOf(reached.receiver);
        if (widget) report("patch", lineOf(node), `constructor ${nameOf(widget)}`);
      }
      if (
        source.kind === "shipped" &&
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.arguments.length > 0 &&
        PROTOTYPE_READERS.has(node.expression.getText(sf))
      ) {
        const widget = widgetOf(node.arguments[0]);
        if (widget) report("patch", lineOf(node), `${node.expression.getText(sf)} ${nameOf(widget)}`);
      }

      // 5. Implementation names.
      if (source.kind === "shipped") {
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
      "export const dot = (term: Terminal) => {",
      "  // @ts-expect-error a private member",
      "  return term.isOpen;",
      "};",
      "export const reach = (term: Terminal) => [Object.getPrototypeOf(term), Reflect.getPrototypeOf(term)];",
      "export const maker = (term: Terminal) => (term.constructor as { prototype: object }).prototype;",
      'export const parent = (term: Terminal) => term["__proto__"];',
      'export const glob = import.meta.glob("../../../ghostty-web-ng/lib/*.ts");',
      "export const bound = (term: Terminal) => {",
      "  const { isOpen } = term as unknown as { isOpen: boolean };",
      "  return isOpen;",
      "};",
      'export const described = (term: Terminal) => Object.getOwnPropertyDescriptor(term, "isOpen");',
      'export const reflected = (term: Terminal) => Reflect.getOwnPropertyDescriptor(term, "isOpen");',
      'export const owned = (term: Terminal) => Object.hasOwn(term, "isOpen");',
    ].join("\n"),
  ],
  [
    "src/state/boundaryPlant.ts",
    [
      "export const duck = (t: { wasmTerm?: unknown; selectionManager?: unknown }) => [t.wasmTerm, t.selectionManager];",
      "export const own = { renderer: 1, textarea: 2 };",
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
      "export const dot = (term: Terminal) => {",
      "  // @ts-expect-error a private member",
      "  return term.selectionManager;",
      "};",
      "export const reach = (term: Terminal) => Object.getPrototypeOf(term);",
      "export const bound = (term: Terminal) => {",
      "  const { isOpen } = term as unknown as { isOpen: boolean };",
      "  return isOpen;",
      "};",
      'export const spied = () => vi.spyOn(Terminal.prototype as never, "assertOpen" as never);',
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
  { rule: "member", file: "src/terminal/boundaryPlant.ts", line: 11, key: "Terminal.isOpen" },
  { rule: "patch", file: "src/terminal/boundaryPlant.ts", line: 13, key: "Object.getPrototypeOf Terminal" },
  { rule: "patch", file: "src/terminal/boundaryPlant.ts", line: 13, key: "Reflect.getPrototypeOf Terminal" },
  { rule: "patch", file: "src/terminal/boundaryPlant.ts", line: 14, key: "constructor Terminal" },
  { rule: "member", file: "src/terminal/boundaryPlant.ts", line: 15, key: "Terminal.__proto__" },
  { rule: "deep", file: "src/terminal/boundaryPlant.ts", line: 16, key: "../../../ghostty-web-ng/lib/*.ts" },
  { rule: "cast", file: "src/terminal/boundaryPlant.ts", line: 18, key: "unknown" },
  { rule: "member", file: "src/terminal/boundaryPlant.ts", line: 18, key: "Terminal.isOpen" },
  { rule: "member", file: "src/terminal/boundaryPlant.ts", line: 21, key: "Terminal.isOpen" },
  { rule: "member", file: "src/terminal/boundaryPlant.ts", line: 22, key: "Terminal.isOpen" },
  { rule: "member", file: "src/terminal/boundaryPlant.ts", line: 23, key: "Terminal.isOpen" },
  { rule: "name", file: "src/state/boundaryPlant.ts", line: 1, key: "wasmTerm" },
  { rule: "name", file: "src/state/boundaryPlant.ts", line: 1, key: "selectionManager" },
  { rule: "cast", file: "src/terminal/BoundaryPlant.svelte", line: 4, key: "unknown" },
  { rule: "member", file: "src/terminal/BoundaryPlant.svelte", line: 4, key: "Terminal.linkDetector" },
  { rule: "name", file: "src/terminal/BoundaryPlant.svelte", line: 4, key: "linkDetector" },
  { rule: "name", file: "src/terminal/BoundaryPlant.svelte", line: 7, key: "renderer" },
  { rule: "deep", file: "src/terminal/boundaryPlant.test.ts", line: 2, key: "../../../ghostty-web-ng/lib/renderer" },
  { rule: "member", file: "src/terminal/boundaryPlant.test.ts", line: 3, key: "Terminal.isOpen" },
  { rule: "patch", file: "src/terminal/boundaryPlant.test.ts", line: 4, key: "write Terminal.cols" },
  { rule: "member", file: "src/terminal/boundaryPlant.test.ts", line: 10, key: "Terminal.selectionManager" },
  { rule: "member", file: "src/terminal/boundaryPlant.test.ts", line: 14, key: "Terminal.isOpen" },
  { rule: "member", file: "src/terminal/boundaryPlant.test.ts", line: 17, key: "Terminal.assertOpen" },
];

/// Entries over the planted reads whose counts are off, one each way, and
/// one that is right, so the count rule shows it fires on a reader more
/// and a reader fewer, and only there.
const PLANT_PENDING: readonly Pending[] = [
  ...pending("app terminal", "planted", "deep", "src/terminal/boundaryPlant.ts", {
    "@chan/ghostty-web-ng/lib/renderer": 0,
  }),
  ...pending("app terminal", "planted", "patch", "src/terminal/boundaryPlant.ts", { "Object.assign Terminal": 2 }),
  ...pending("app terminal", "planted", "name", "src/terminal/boundaryPlant.ts", { wasmTerm: 1 }),
];

function show(f: Finding): string {
  return `${f.rule} ${f.file}:${f.line} ${f.key}`;
}
const covers = (p: Pending, f: Finding) => p.rule === f.rule && p.file === f.file && p.key === f.key;
/// The entries whose count is not the number of findings they cover.
const miscounted = (entries: readonly Pending[], findings: readonly Finding[]) =>
  entries.flatMap((p) => {
    const found = findings.filter((f) => covers(p, f)).length;
    return found === p.count ? [] : [`${p.rule} ${p.file} ${p.key}: counts ${p.count}, covers ${found}`];
  });

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

  test("each pending entry covers exactly the readers it counts", () => {
    expect(miscounted(PENDING, real)).toEqual([]);
  });

  test("a pending entry fails on a reader more or fewer than it counts", () => {
    expect(miscounted(PLANT_PENDING, planted)).toEqual([
      "deep src/terminal/boundaryPlant.ts @chan/ghostty-web-ng/lib/renderer: counts 0, covers 1",
      "patch src/terminal/boundaryPlant.ts Object.assign Terminal: counts 2, covers 1",
    ]);
  });
});
