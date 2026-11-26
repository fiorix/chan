// @vitest-environment node
//
// The terminal widget's boundary: no app module reaches the widget package
// (`@chan/ghostty-web-ng`) past its public API. The package's TypeScript
// `private` members are private to the compiler only, so a cast reaches
// them at run time, and a member reached that way reads `undefined` once
// the package spells it `#private`: the reader does not fail, it takes
// whatever fallback it has. This check reads every app module through the
// TypeScript checker, a component as its scripts and the expressions of
// its markup, and reports, with file and line:
//
// 1. deep: an import, export, dynamic import, `import()` type, module mock,
//    `import.meta.glob` pattern or `new URL(..., import.meta.url)` that
//    reaches a path inside the package other than its export map's entries;
// 2. cast: a cast of a widget value to a type it does not satisfy or to
//    one that names none of its members (`any`, `unknown`, `object`,
//    `{}`), and a cast of a value typed by a type parameter to such a
//    type, which launders whatever a caller passes;
// 3. member: a read of a member the package does not make public, by a
//    dot, a bracket or a variable declaration's destructuring on a widget
//    value or one cast from it (through variables a cast or an annotation
//    widened, up to the first that is a widget), `in`, `vi.spyOn`,
//    `Reflect.get`, `Reflect.has`, `getOwnPropertyDescriptor`,
//    `Object.hasOwn` or `hasOwnProperty`, with the key a literal, one under
//    parentheses or a cast, or a value whose type is a string literal;
// 4. patch: a write to a member of a widget object, `Object.assign` and its
//    kin on one, and any reach of a widget's prototype: a widget class's
//    `prototype`, or a widget value's `constructor`, `Object.getPrototypeOf`
//    or `Reflect.getPrototypeOf` (tests may reach one to read and spy on
//    its public members);
// 5. name: the name of one of the widget's implementation members, which
//    catches what has no widget type to check, such as a duck-typed
//    parameter;
// 6. escape: a widget class instance where the program expects a type that
//    names none of its members (`any`, `unknown`, `object`, `{}`, with or
//    without `null`): an argument, an initializer, a property value, a
//    return, an assigned value, an array element, or a callback's
//    parameter so declared that its caller hands a widget; past it no
//    other rule can follow the value. An Error subclass is exempt, since
//    errors travel as `unknown` by design and are read after `instanceof`;
// 7. duck: a widget class instance flowing into a type of the app's that
//    names a member the class keeps private, lacks, or holds as one of its
//    implementation members, which reads `undefined` once that member is
//    `#private`; a type with a widget part (a union with another type) is
//    read through the widget's own declarations, which rules 3 and 5 see.
//
// Shipped modules are held to all seven rules, tests to 1, 3 and 4. A dot
// read of a private member on a widget-typed value is a type error, but
// `@ts-expect-error` and `@ts-ignore` keep svelte-check from reporting it,
// so rule 3 reads dots as well. Markup is read as the body of a function
// in the instance script's scope, so a script variable has its declared
// type there, as markup sees it after the script assigns it.
//
// It does not see:
// - in tests, a widget value laundered through `any` or `unknown`, which
//   is how the package's white-box tests read, or a spy on a private
//   member of the prototype `Object.getPrototypeOf` returns;
// - a key held in a variable typed `string`, one whose literal type a cast
//   hides (`KEY as never`), or one computed from parts (`"is" + "Open"`);
// - a destructuring other than at the top of a variable declaration: a
//   parameter's, a `for`-`of`'s, a nested one, an assignment's (a computed
//   literal key in a declaration is seen by rule 7 alone, so only in a
//   shipped module);
// - a spread copy of a widget (`{ ...term }`) read through a cast;
// - a duck type reached through a type parameter's constraint, and the
//   other parts of a type with a widget part (a union with a duck type, a
//   generic holder with the widget as its type argument);
// - a duck type the widget satisfies once a member is `#private`, which is
//   no property of its type, declared by a callback's parameter or by a
//   function assigned to a function type that takes a widget
//   (`[term].map((t: { cols: number; isOpen?: boolean }) => t.isOpen)`):
//   rule 7 reads the values that flow, not the parameters that take them;
// - a value of a type parameter's type widened into `unknown`, `object` or
//   `{}` with no cast (`<T>(o: T): unknown => o`), since at the call the
//   widget meets a parameter of type `T`, not an opaque one;
// - a widget widened with its container (`[term]` held as `readonly
//   unknown[]`, `{ v: vt }` as `{ readonly v: unknown }`,
//   `Promise.resolve(term)` as `Promise<unknown>`, or a container cast so),
//   a widget joined with an `unknown` by `??` or `? :`, whose type is then
//   `unknown`, and a widget thrown and caught;
// - `Reflect` and `Object` functions called other than as a property
//   access (`const { get } = Reflect`, `(Reflect.get)(...)`,
//   `Reflect["get"](...)`, `const { assign, defineProperty } = Object`),
//   whose target the checker types as the widget itself;
// - a write through an assignment's destructuring (`[term.cols] = [1]`,
//   `({ rows: term.rows } = rows)`) or a Svelte `bind:` directive
//   (`bind:this={live.element}`, `bind:value={live.cols}`), which rule 4
//   does not read as a write;
// - a dynamic import whose specifier is a string literal under
//   parentheses (`import(("@chan/ghostty-web-ng/lib/internal"))`);
// - in tests, a `satisfies` inside a cast chain (`(term as unknown)
//   satisfies unknown as { selectionManager: unknown }`), where rule 3
//   stops following the casts;
// - in markup, a name declared in a component's `<script module>` beside
//   an instance script, or a `$store` read, which has no type there, and a
//   value markup passes to a component's props, which has no contextual
//   type.
// Rule 6 also reports a widget kept in a `WeakMap<object>` or a
// `Set<object>` and never read back as anything else; the app has none.
// The `scripts/e2e` instruments (the browser checks, the pixel harness)
// are not app modules: they are read by grep only.
//
// Readers that other changes remove are listed as pending, each pinned by
// the text of the node it reports: a reader more or fewer in a listed
// file fails, and so does one replaced by a reader of another text, while
// a reader moved with its text unchanged does not, nor one replaced by
// another of that text in the same file.
//
// The package keeps four members TypeScript private on purpose, as its
// search measurement's seam: `SearchOwner`'s `pump` and `readResults` and
// `CanvasRenderer`'s `highlightAt` and `cacheHighlights`, which that
// package test wraps on their prototypes, where an ES private method is
// not. No app module has a reason to read them, and rule 3 reports a read
// of one as it does any private member.
//
// It is a property of every module, including ones not written yet, that
// no mounted test can observe, so it reads the source.

import { parse } from "svelte/compiler";
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

type Rule = "deep" | "cast" | "member" | "patch" | "name" | "escape" | "duck";
type Kind = "shipped" | "test";
const TEST_RULES: ReadonlySet<Rule> = new Set(["deep", "member", "patch"]);

/// Where a finding is and what it names.
type Site = { rule: Rule; file: string; line: number; key: string };
/// A finding keeps the text of the node it reports, whitespace collapsed,
/// which a pending entry pins.
type Finding = Site & { text: string };

/// Who removes a pending reader: the app's terminal code, or the widget
/// package by taking over what the reader tests.
type Owner = "app terminal" | "widget package";

/// Readers that are there today and that the change named in `until`
/// removes. An entry covers the findings of `key` under `rule` in `file`,
/// and `readers` is the text of each node it covers, as a multiset: the
/// check fails when the covered findings' texts differ from it, so a
/// reader more, on a line of its own or beside another, a reader fewer,
/// and a reader replaced by one of another text all fail, and each reader
/// that goes takes its text off the list. A reader moved with its text
/// unchanged passes, and so does a reader replaced by another of the same
/// text in the same file.
type Pending = { rule: Rule; file: string; key: string; readers: readonly string[]; owner: Owner; until: string };

/// The entries of one owner, change, rule and file, the readers' texts per
/// key.
const pending = (
  owner: Owner,
  until: string,
  rule: Rule,
  file: string,
  readers: Record<string, readonly string[]>,
): Pending[] => Object.entries(readers).map(([key, texts]) => ({ rule, file, key, readers: texts, owner, until }));

const RENDERER_TESTS = "the renderer tests move into the package, over an opened terminal";

const PENDING: readonly Pending[] = [
  ...pending("widget package", RENDERER_TESTS, "member", "src/terminal/ghosttyRenderer.test.ts", {
    "Terminal.buildWasmConfig": [
      "(term as unknown as { buildWasmConfig(): Parameters<GhosttyVt[\"createTerminal\"]>[2] }).buildWasmConfig",
      "(term as unknown as { buildWasmConfig(): Parameters<GhosttyVt[\"createTerminal\"]>[2] }).buildWasmConfig",
      "(term as unknown as { buildWasmConfig(): Parameters<GhosttyVt[\"createTerminal\"]>[2] }).buildWasmConfig",
    ],
    "Terminal.selectionManager": ["(term as unknown as { selectionManager: SelectionManager }).selectionManager"],
  }),
  ...pending("widget package", RENDERER_TESTS, "patch", "src/terminal/ghosttyRenderer.test.ts", {
    "write Terminal.element": ["(term as unknown as { element: HTMLElement }).element"],
    "write Terminal.renderer": ["term.renderer", "term.renderer", "term.renderer", "term.renderer"],
    "write Terminal.selectionManager": ["(term as unknown as { selectionManager: SelectionManager }).selectionManager"],
    "write Terminal.wasmTerm": ["term.wasmTerm", "term.wasmTerm", "term.wasmTerm", "term.wasmTerm"],
  }),
  ...pending("widget package", RENDERER_TESTS, "member", "src/terminal/ghosttyRenderer.redraw.test.ts", {
    "CanvasRenderer.cursorVisible": [
      "(whole.renderer as unknown as { cursorVisible: boolean }).cursorVisible",
      "hover.cursorVisible",
    ],
    "CanvasRenderer.hoveredHyperlinkId": ["hover.hoveredHyperlinkId"],
    "CanvasRenderer.hoveredLinkRange": ["hover.hoveredLinkRange"],
    "CanvasRenderer.selectionManager": [
      "(painter.renderer as unknown as { selectionManager: { getSelectionCoords(): Coords | null } }).selectionManager",
    ],
    "Terminal.selectionManager": [
      "(r.painter.term as unknown as { selectionManager: SelectionManager }).selectionManager",
    ],
  }),
  ...pending("widget package", RENDERER_TESTS, "patch", "src/terminal/ghosttyRenderer.redraw.test.ts", {
    "write CanvasRenderer.cursorVisible": ["(whole.renderer as unknown as { cursorVisible: boolean }).cursorVisible"],
    "write Terminal.renderer": ["term.renderer"],
    "write Terminal.selectionManager": [
      "(r.painter.term as unknown as { selectionManager: SelectionManager }).selectionManager",
    ],
    "write Terminal.viewportY": [
      "(fresh.term as unknown as { viewportY: number }).viewportY",
      "(r.painter.term as unknown as { viewportY: number }).viewportY",
      "(whole.term as unknown as { viewportY: number }).viewportY",
    ],
    "write Terminal.wasmTerm": ["term.wasmTerm"],
  }),
];

/// A run of a module's text copied from its file: `at` in the module,
/// `from` in the file.
type Span = { at: number; from: number; length: number };
type Range = { start: number; end: number };

/// A module as the program reads it: a `.ts` file whole, or a component's
/// `<script module>`, or its instance script followed by its markup's
/// expressions. `spans` lead a module position back to the file's text.
type Source = { file: string; rel: string; kind: Kind; text: string; spans: Span[]; original: string };

function kindOf(rel: string): Kind | null {
  if (rel.endsWith(".d.ts") || !/\.(ts|svelte)$/.test(rel)) return null;
  if (rel.startsWith("src/")) {
    return rel.includes("/__tests__/") || /\.(test|e2e|measure)\.ts$/.test(rel) ? "test" : "shipped";
  }
  return /^(vitest\.setup|[^/]+\.test)\.ts$/.test(rel) ? "test" : null;
}

/// Svelte's template node types; any other node in a template is an ESTree
/// expression or pattern.
const TEMPLATE_NODES = new Set([
  "Fragment",
  "Text",
  "Comment",
  "ExpressionTag",
  "HtmlTag",
  "ConstTag",
  "DebugTag",
  "RenderTag",
  "AttachTag",
  "Attribute",
  "SpreadAttribute",
  "AnimateDirective",
  "BindDirective",
  "ClassDirective",
  "LetDirective",
  "OnDirective",
  "StyleDirective",
  "TransitionDirective",
  "UseDirective",
  "Component",
  "TitleElement",
  "SlotElement",
  "RegularElement",
  "SvelteBody",
  "SvelteBoundary",
  "SvelteComponent",
  "SvelteDocument",
  "SvelteElement",
  "SvelteFragment",
  "SvelteHead",
  "SvelteOptions",
  "SvelteSelf",
  "SvelteWindow",
  "EachBlock",
  "IfBlock",
  "AwaitBlock",
  "KeyBlock",
  "SnippetBlock",
]);
type TemplateNode = Range & { type: string; [key: string]: unknown };
const isTemplateNode = (value: unknown): value is TemplateNode =>
  typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";

/// What the markup's statements call to type an each block's item and an
/// await block's value; declared, never run.
const TEMPLATE_HELPERS = [
  "declare function __boundaryEach<T>(items: Iterable<T> | ArrayLike<T> | null | undefined): T[];",
  "declare function __boundaryAwait<T>(value: T): Awaited<T>;",
].join("\n");

/// A component as modules, from Svelte's own parser: its `<script module>`
/// when it also has an instance script, then the instance script (or the
/// module script, or nothing) followed by its markup as the statements of
/// a function there. Inside a function a script variable has its declared
/// type, as markup sees it after any assignment, where at the script's top
/// level the checker would narrow `let term: Terminal | null = null` to
/// `null`. Each expression is copied as written into the scope the markup
/// gives it: an each block's item and index, a snippet's parameters, an
/// await block's value and error, a `{@const}`. A `let:` binding is the
/// slot's and left out, so a name it binds has no type.
function componentSources(file: string, rel: string, kind: Kind, text: string): Source[] {
  const root = parse(text, { modern: true }) as unknown as {
    module: { content: Range } | null;
    instance: { content: Range } | null;
    fragment: TemplateNode;
  };
  let code = "";
  let spans: Span[] = [];
  const put = (s: string) => {
    code += s;
  };
  const copy = (range: Range) => {
    spans.push({ at: code.length, from: range.start, length: range.end - range.start });
    code += text.slice(range.start, range.end);
  };
  const take = (part: string): Source => {
    const source = { file: `${file}.${part}.ts`, rel, kind, text: code, spans, original: text };
    code = "";
    spans = [];
    return source;
  };
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (!isTemplateNode(value)) return;
    const node = value;
    if (!TEMPLATE_NODES.has(node.type)) {
      put("(");
      copy(node);
      put(");\n");
      return;
    }
    switch (node.type) {
      case "Text":
      case "Comment":
      case "LetDirective":
        return;
      case "Fragment":
        put("{\n");
        walk(node.nodes);
        put("}\n");
        return;
      case "ConstTag":
        copy(node.declaration as Range);
        put(";\n");
        return;
      case "SnippetBlock": {
        const parameters = node.parameters as Range[];
        put("function ");
        copy(node.expression as Range);
        if (typeof node.typeParams === "string") put(`<${node.typeParams}>`);
        put("(");
        if (parameters.length > 0) copy({ start: parameters[0].start, end: parameters[parameters.length - 1].end });
        put(") ");
        walk(node.body);
        return;
      }
      case "EachBlock":
        put("for (const ");
        if (isTemplateNode(node.context)) copy(node.context);
        else put("__boundaryItem");
        put(" of __boundaryEach(");
        copy(node.expression as Range);
        put(")) {\n");
        if (typeof node.index === "string") put(`const ${node.index} = 0;\n`);
        walk(node.key);
        walk(node.body);
        put("}\n");
        walk(node.fallback);
        return;
      case "AwaitBlock":
        put("{\nconst __boundaryAwaited = __boundaryAwait(");
        copy(node.expression as Range);
        put(");\n");
        walk(node.pending);
        put("{\n");
        if (isTemplateNode(node.value)) {
          put("const ");
          copy(node.value);
          put(" = __boundaryAwaited;\n");
        }
        walk(node.then);
        put("}\n{\n");
        if (isTemplateNode(node.error)) {
          put("const ");
          copy(node.error);
          put(": any = undefined;\n");
        }
        walk(node.catch);
        put("}\n}\n");
        return;
    }
    for (const child of Object.values(node)) walk(child);
  };

  const sources: Source[] = [];
  if (root.module && root.instance) {
    copy(root.module.content);
    sources.push(take("module"));
  }
  const host = root.instance ?? root.module;
  if (host) copy(host.content);
  put("\nfunction __boundaryMarkup() {\n");
  walk(root.fragment);
  put("}\n");
  put(TEMPLATE_HELPERS);
  sources.push(take(root.instance || !root.module ? "instance" : "module"));
  return sources;
}

function sourcesOf(rel: string, text: string): Source[] {
  const kind = kindOf(rel);
  if (!kind) return [];
  const file = `${APP}/${rel}`;
  if (rel.endsWith(".svelte")) return componentSources(file, rel, kind, text);
  return [{ file, rel, kind, text, spans: [{ at: 0, from: 0, length: text.length }], original: text }];
}

/// The file's line a module position came from: a copied position maps
/// into its span, a written one to the end of the span before it.
function lineIn(source: Source, at: number): number {
  let from = 0;
  for (const span of source.spans) {
    if (span.at > at) break;
    from = span.from + Math.min(at - span.at, span.length);
  }
  return source.original.slice(0, from).split("\n").length;
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
  const virtual = new Map(sources.filter((s) => s.rel.endsWith(".svelte") || plants.has(s.rel)).map((s) => [s.file, s.text]));
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
  const program = ts.createProgram({ rootNames: sources.map((s) => s.file), options, host });
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
  /// widget value, or a variable a cast or a type annotation widened one
  /// into, followed through a few such steps (`(t as Raw)` over
  /// `const t: unknown = term`). The walk stops at the first step that is
  /// already a widget, so a widget-typed variable is not followed into an
  /// initializer that is not one (`let term: Terminal | null = null`).
  function castFrom(receiver: ts.Expression): ts.Type | undefined {
    let e = outer(receiver);
    let widened = false;
    for (let step = 0; step < 4; step++) {
      if (widened) {
        const here = checker.getTypeAtLocation(e);
        if (isWidget(here)) return here;
      }
      if (isCast(e)) {
        while (isCast(e)) e = outer(e.expression);
        widened = true;
        continue;
      }
      if (!ts.isIdentifier(e)) break;
      const declaration = checker.getSymbolAtLocation(e)?.valueDeclaration;
      if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer) break;
      const initializer = outer(declaration.initializer);
      if (!declaration.type && !isCast(initializer)) break;
      e = initializer;
      widened = true;
    }
    if (!widened) return undefined;
    const origin = checker.getTypeAtLocation(e);
    return isWidget(origin) ? origin : undefined;
  }
  /// Whether an expression stands where the program gives it a type to
  /// take: an argument, an initializer, a property value, a return, an
  /// assigned value or an array element. A cast's operand is rule 2's, and
  /// a receiver is read, not passed.
  const flows = (node: ts.Expression): boolean => {
    const at = node.parent;
    if ((ts.isCallExpression(at) || ts.isNewExpression(at)) && at.arguments?.includes(node)) return true;
    if ((ts.isVariableDeclaration(at) || ts.isPropertyDeclaration(at) || ts.isParameter(at)) && at.initializer === node) return true;
    if (ts.isPropertyAssignment(at) && at.initializer === node) return true;
    if (ts.isShorthandPropertyAssignment(at) && at.name === node) return true;
    if (ts.isReturnStatement(at) || ts.isArrayLiteralExpression(at)) return true;
    if (ts.isArrowFunction(at) && at.body === node) return true;
    return ts.isBinaryExpression(at) && at.operatorToken.kind === ts.SyntaxKind.EqualsToken && at.right === node;
  };
  /// The type the program gives a flowing expression. A shorthand
  /// property's is its property's in the object's type, which the
  /// checker's contextual type for the name is not.
  const targetOf = (node: ts.Expression): ts.Type | undefined => {
    const at = node.parent;
    if (!ts.isShorthandPropertyAssignment(at)) return checker.getContextualType(node);
    const object = checker.getContextualType(at.parent);
    const property = object && checker.getPropertyOfType(object, at.name.text);
    return property && checker.getTypeOfSymbolAtLocation(property, at);
  };
  /// Whether a class instance type is an Error's, which travels as
  /// `unknown` through every catch.
  const isError = (type: ts.Type): boolean =>
    type.isClassOrInterface() &&
    (checker.getBaseTypes(type) ?? []).some((base) => base.getSymbol()?.getName() === "Error" || isError(base));
  /// Whether a type says nothing of the members of what it holds, so a
  /// widget that flows into it is out of sight of the member, cast and duck
  /// rules: `any`, `unknown`, `object`, or an object type with no member,
  /// signature or index (`{}`), with or without `null` and `undefined`.
  const opaque = (type: ts.Type): boolean => {
    const t = checker.getNonNullableType(type);
    return (
      (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.NonPrimitive)) !== 0 ||
      ((t.flags & ts.TypeFlags.Object) !== 0 &&
        checker.getPropertiesOfType(t).length === 0 &&
        checker.getSignaturesOfType(t, ts.SignatureKind.Call).length === 0 &&
        checker.getSignaturesOfType(t, ts.SignatureKind.Construct).length === 0 &&
        checker.getIndexInfosOfType(t).length === 0)
    );
  };
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
    "Object.prototype.hasOwnProperty.call",
  ]);
  const PROTOTYPE_READERS = new Set(["Object.getPrototypeOf", "Reflect.getPrototypeOf"]);

  /// A string key as written, through parentheses and casts.
  function literalKey(e: ts.Expression): string | undefined {
    while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isTypeAssertionExpression(e) || ts.isSatisfiesExpression(e)) {
      e = e.expression;
    }
    return ts.isStringLiteralLike(e) ? e.text : undefined;
  }
  /// The string keys a key expression names: the literal as written, or
  /// else each string literal its type is (`const k = "isOpen" as const`).
  function keysOf(e: ts.Expression): string[] {
    const written = literalKey(e);
    if (written !== undefined) return [written];
    const type = checker.getTypeAtLocation(e);
    return (type.isUnion() ? type.types : [type]).flatMap((t) => (t.isStringLiteral() ? [t.value] : []));
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
    const sf = program.getSourceFile(source.file);
    if (!sf) throw new Error(`the program did not read ${source.rel}`);
    // A markup shape componentSources renders wrongly fails here, rather
    // than reading as a module with nothing to report.
    const [broken] = source.rel.endsWith(".svelte") ? program.getSyntacticDiagnostics(sf) : [];
    if (broken) throw new Error(`${source.rel} reads as broken TypeScript: ${ts.flattenDiagnosticMessageText(broken.messageText, " ")}`);
    const report = (rule: Rule, at: ts.Node, key: string) => {
      if (source.kind === "test" && !TEST_RULES.has(rule)) return;
      const start = at.getStart(sf);
      const finding = { rule, file: source.rel, line: lineIn(source, start), key, text: at.getText(sf).replace(/\s+/g, " ") };
      // One finding per node: two reads on one line are two findings.
      findings.set(`${show(finding)} @${start}`, finding);
    };

    const read = (receiver: ts.Expression, name: string, at: ts.Node) => {
      const widget = widgetOf(receiver);
      if (widget && hidden(widget, name)) report("member", at, `${nameOf(widget)}.${name}`);
    };
    const written = (target: ts.Expression) => {
      const access = outer(target);
      if (!ts.isPropertyAccessExpression(access) && !ts.isElementAccessExpression(access)) return;
      const widget = widgetOf(access.expression);
      if (!widget || !isClassInstance(widget)) return;
      const name = ts.isPropertyAccessExpression(access) ? access.name.getText(sf) : access.argumentExpression.getText(sf);
      report("patch", access, `write ${nameOf(widget)}.${name}`);
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
        report("deep", specifier, specifier.text);
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
          if (ts.isStringLiteralLike(pattern) && globReaches(pattern.text, source.file)) report("deep", pattern, pattern.text);
        }
      }
      if (
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "URL" &&
        node.arguments?.length === 2 &&
        node.arguments[1].getText(sf) === "import.meta.url"
      ) {
        const [path] = node.arguments;
        if (ts.isStringLiteralLike(path) && isDeep(path.text, source.file)) report("deep", path, path.text);
      }

      // 2. Casts of a widget value to a type it does not satisfy, and casts
      // of a type parameter's value to a type that names nothing of it,
      // which launder whatever a caller passes, a widget included.
      if (isCast(node) && source.kind === "shipped") {
        const from = checker.getTypeAtLocation(node.expression);
        const to = checker.getTypeFromTypeNode(node.type);
        if (isWidget(from) && (opaque(to) || !checker.isTypeAssignableTo(checker.getNonNullableType(from), to))) {
          report("cast", node, node.type.getText(sf));
        } else if ((from.isUnion() ? from.types : [from]).some((t) => t.flags & ts.TypeFlags.TypeParameter) && opaque(to)) {
          report("cast", node, `type parameter ${checker.typeToString(from)} to ${node.type.getText(sf)}`);
        }
      }

      // 3. Reads of members the package keeps to itself.
      const reached = access(node);
      if (reached) read(reached.receiver, reached.name, node);
      if (ts.isElementAccessExpression(node) && !reached) {
        for (const key of keysOf(node.argumentExpression)) read(node.expression, key, node);
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.InKeyword) {
        for (const key of keysOf(node.left)) read(node.right, key, node);
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.arguments.length >= 2) {
        if (READERS.has(node.expression.getText(sf))) for (const key of keysOf(node.arguments[1])) read(node.arguments[0], key, node);
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "hasOwnProperty") {
        if (node.arguments.length === 1) for (const key of keysOf(node.arguments[0])) read(node.expression.expression, key, node);
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
        if (widget && isClassInstance(widget)) report("patch", node, `${node.expression.getText(sf)} ${nameOf(widget)}`);
      }
      if (source.kind === "shipped" && reached?.name === "prototype") {
        let symbol = checker.getSymbolAtLocation(reached.receiver);
        if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
        if (symbol && widgetClass(symbol)) report("patch", node, `prototype ${symbol.getName()}`);
      }
      if (source.kind === "shipped" && reached?.name === "constructor") {
        const widget = widgetOf(reached.receiver);
        if (widget) report("patch", node, `constructor ${nameOf(widget)}`);
      }
      if (
        source.kind === "shipped" &&
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.arguments.length > 0 &&
        PROTOTYPE_READERS.has(node.expression.getText(sf))
      ) {
        const widget = widgetOf(node.arguments[0]);
        if (widget) report("patch", node, `${node.expression.getText(sf)} ${nameOf(widget)}`);
      }

      // 6 and 7. A widget instance that escapes into a type that says
      // nothing of its members, or flows into a duck type of the app's.
      if (source.kind === "shipped" && ts.isExpression(node) && flows(node)) {
        const type = checker.getTypeAtLocation(node);
        const classes = parts(type).filter((t) => widgetClass(t.getSymbol()));
        const target = classes.length > 0 ? targetOf(node) : undefined;
        if (target && opaque(target)) {
          if (!classes.every(isError)) report("escape", node, `${nameOf(type)} into ${checker.typeToString(target)}`);
        } else if (target && !isWidget(target)) {
          for (const shape of parts(target)) {
            if (shape.flags & ts.TypeFlags.TypeParameter) continue;
            for (const property of checker.getPropertiesOfType(checker.getApparentType(shape))) {
              const name = property.getName();
              if (IMPLEMENTATION.has(name) || GENERIC.has(name) || hidden(type, name)) report("duck", node, `${nameOf(type)}.${name}`);
            }
          }
        }
      }

      // 6, at a callback: a widget the caller hands to a parameter the
      // callback declares as a type that names nothing of it. The
      // callback's contextual type may admit null or undefined, as a
      // promise's `then` does.
      if (source.kind === "shipped" && (ts.isArrowFunction(node) || ts.isFunctionExpression(node))) {
        const context = checker.getContextualType(node);
        const signature = context && checker.getSignaturesOfType(checker.getNonNullableType(context), ts.SignatureKind.Call)[0];
        node.parameters.forEach((parameter, i) => {
          if (!signature || !parameter.type || i >= signature.parameters.length) return;
          const declared = checker.getTypeFromTypeNode(parameter.type);
          if (!opaque(declared)) return;
          const given = checker.getTypeOfSymbolAtLocation(signature.parameters[i], node);
          const classes = parts(given).filter((t) => widgetClass(t.getSymbol()));
          if (classes.length > 0 && !classes.every(isError)) {
            report("escape", parameter, `${nameOf(given)} into a parameter ${checker.typeToString(declared)}`);
          }
        });
      }

      // 5. Implementation names.
      if (source.kind === "shipped") {
        const member = memberNamed(node);
        if (member && isImplementationName(source.rel, member.name, member.receiver?.getText(sf))) {
          report("name", node, member.name);
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
      "type Raw = { isOpen: boolean; handle: number };",
      "const raw = (o: unknown): Raw => o as Raw;",
      "export const laundered = (term: Terminal) => raw(term).isOpen;",
      'import type { VtTerminal } from "@chan/ghostty-web-ng/vt";',
      "export const core = (vt: VtTerminal) => raw(vt).handle;",
      "export const widened = (term: Terminal) => {",
      "  const t: unknown = term;",
      "  return (t as Raw).isOpen;",
      "};",
      "export const held = (term: Terminal) => {",
      '  const k = "isOpen" as const;',
      "  return term[k];",
      "};",
      "export const boxed = (term: Terminal) => {",
      "  const box: { t: any } = { t: term };",
      "  return box.t.isOpen;",
      "};",
      'export const parenthesized = (term: Terminal) => term[("isOpen")];',
      'export const ownProperty = (term: Terminal) => term.hasOwnProperty("isOpen");',
      'export const ownCall = (term: Terminal) => Object.prototype.hasOwnProperty.call(term, "isOpen");',
      'export const asset = new URL("../../../ghostty-web-ng/lib/renderer.ts", import.meta.url);',
      'import { flagged, heldText } from "../state/boundaryPlant";',
      "export const ducked = (term: Terminal) => heldText(term);",
      "export const lacking = (term: Terminal) => flagged(term);",
      'import { GhosttyVtRefusal } from "@chan/ghostty-web-ng/vt";',
      'export const refused = (report: (error: unknown) => void) => report(new GhosttyVtRefusal("refused"));',
      "export const sized = (term: Terminal) => ((t: { cols: number; rows: number }) => t.cols * t.rows)(term);",
      "export const shorthand = (t: Terminal): { t: unknown } => ({ t });",
      "export const nulled = (make: () => Terminal) => {",
      "  let term: Terminal | null = null;",
      "  term = make();",
      "  return (term as unknown as Raw).isOpen;",
      "};",
      "export const recast = (box: { t: any }) => {",
      "  const term = box.t as Terminal;",
      "  return (term as unknown as { canvas: HTMLCanvasElement }).canvas;",
      "};",
      "const rawObject = (o: object): Raw => o as Raw;",
      "export const viaObject = (term: Terminal) => rawObject(term).isOpen;",
      "const rawEmpty = (o: {}): Raw => o as Raw;",
      "export const viaEmpty = (term: Terminal) => rawEmpty(term).isOpen;",
      "export const walked = (term: Terminal) => Object.entries(term).length;",
      "export const kept = (term: Terminal) => new Set<object>([term]);",
      "const rawT = <T>(o: T): Raw => o as unknown as Raw;",
      "export const viaT = (term: Terminal) => rawT(term).isOpen;",
      "export const mapped = (term: Terminal) => [term].map((t: any) => t.isOpen as boolean);",
      "export const mappedUnknown = (term: Terminal) => [term].map((t: unknown) => (t as Raw).isOpen);",
      "export const promised = (term: Terminal) => Promise.resolve(term).then((t: any) => t.isOpen as boolean);",
      'const OPEN = "isOpen" as const;',
      "export const reflectedKey = (term: Terminal) => Reflect.get(term, OPEN);",
      "export const inKey = (term: Terminal) => OPEN in term;",
      "export const ownKey = (term: Terminal) => Object.hasOwn(term, OPEN);",
      "export const ownPropertyKey = (term: Terminal) => term.hasOwnProperty(OPEN);",
      'export const twice = (term: Terminal) => [term["canvas"], term["canvas"]];',
      "export const walkedObject = (term: Terminal) => Object.entries(term as object).length;",
      "export const walkedEmpty = (term: Terminal) => Object.entries(term as {}).length;",
    ].join("\n"),
  ],
  [
    "src/state/boundaryPlant.ts",
    [
      "export const duck = (t: { wasmTerm?: unknown; selectionManager?: unknown }) => [t.wasmTerm, t.selectionManager];",
      "export const own = { renderer: 1, textarea: 2 };",
      "export type Holder = { wasmTerm?: { plainText(): string | null } };",
      'export const heldText = (holder: Holder) => holder.wasmTerm?.plainText() ?? "";',
      "export const flagged = (holder: { sealedSoon?: boolean }) => holder.sealedSoon;",
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
      "<p>{(term as any)?.isOpen}</p>",
      "{#each [term] as one}<i>{(one as unknown as { canvas: HTMLCanvasElement }).canvas}</i>{/each}",
      '{#snippet row(t: Terminal)}<b title={t["isOpen"]}></b>{/snippet}',
      "{#snippet gen<T>(t: T)}<b>{(t as unknown as { isOpen: boolean }).isOpen}</b>{/snippet}",
      "{#each [term] as one}<i>{[one].map((x: any) => x.isOpen)}</i>{/each}",
    ].join("\n"),
  ],
  [
    "src/terminal/BoundaryHolder.svelte",
    [
      '<script lang="ts">',
      '  import type { Terminal } from "@chan/ghostty-web-ng";',
      "  let { make }: { make: () => Terminal } = $props();",
      "  let term: Terminal | null = null;",
      "  let held: Terminal | null = $state(null);",
      "  $effect(() => {",
      "    term = make();",
      "    held = make();",
      "  });",
      "</script>",
      "",
      "<p>{(term as any)?.isOpen}</p>",
      "<p>{(held as unknown as { isOpen: boolean } | null)?.isOpen}</p>",
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
      "export const laundered = (term: Terminal) => ((o: unknown) => o as { isOpen: boolean })(term).isOpen;",
      "export const keyed = (term: Terminal) => {",
      '  const k = "isOpen" as const;',
      "  return term[k];",
      "};",
      "type Raw = { isOpen: boolean };",
      "export const nulled = (make: () => Terminal) => {",
      "  let term: Terminal | null = null;",
      "  term = make();",
      "  return (term as unknown as Raw).isOpen;",
      "};",
      "export const recast = (box: { t: any }) => {",
      "  const term = box.t as Terminal;",
      "  return (term as unknown as Raw).isOpen;",
      "};",
      'const KEY = "assertOpen" as const;',
      "export const reflectedKey = (term: Terminal) => Reflect.get(term, KEY);",
    ].join("\n"),
  ],
]);

const PLANTED: readonly Site[] = [
  { rule: "deep", file: "src/terminal/boundaryPlant.ts", line: 2, key: "@chan/ghostty-web-ng/lib/renderer" },
  { rule: "cast", file: "src/terminal/boundaryPlant.ts", line: 3, key: "unknown" },
  { rule: "member", file: "src/terminal/boundaryPlant.ts", line: 4, key: "Terminal.isOpen" },
  { rule: "patch", file: "src/terminal/boundaryPlant.ts", line: 5, key: "Object.assign Terminal" },
  { rule: "patch", file: "src/terminal/boundaryPlant.ts", line: 6, key: "prototype Terminal" },
  { rule: "name", file: "src/terminal/boundaryPlant.ts", line: 7, key: "wasmTerm" },
  { rule: "member", file: "src/terminal/boundaryPlant.ts", line: 11, key: "Terminal.isOpen" },
  { rule: "patch", file: "src/terminal/boundaryPlant.ts", line: 13, key: "Object.getPrototypeOf Terminal" },
  { rule: "patch", file: "src/terminal/boundaryPlant.ts", line: 13, key: "Reflect.getPrototypeOf Terminal" },
  { rule: "escape", file: "src/terminal/boundaryPlant.ts", line: 13, key: "Terminal into any" },
  { rule: "escape", file: "src/terminal/boundaryPlant.ts", line: 13, key: "Terminal into object" },
  { rule: "patch", file: "src/terminal/boundaryPlant.ts", line: 14, key: "constructor Terminal" },
  { rule: "member", file: "src/terminal/boundaryPlant.ts", line: 15, key: "Terminal.__proto__" },
  { rule: "deep", file: "src/terminal/boundaryPlant.ts", line: 16, key: "../../../ghostty-web-ng/lib/*.ts" },
  { rule: "cast", file: "src/terminal/boundaryPlant.ts", line: 18, key: "unknown" },
  { rule: "member", file: "src/terminal/boundaryPlant.ts", line: 18, key: "Terminal.isOpen" },
  { rule: "member", file: "src/terminal/boundaryPlant.ts", line: 21, key: "Terminal.isOpen" },
  { rule: "escape", file: "src/terminal/boundaryPlant.ts", line: 21, key: "Terminal into any" },
  { rule: "member", file: "src/terminal/boundaryPlant.ts", line: 22, key: "Terminal.isOpen" },
  { rule: "member", file: "src/terminal/boundaryPlant.ts", line: 23, key: "Terminal.isOpen" },
  { rule: "escape", file: "src/terminal/boundaryPlant.ts", line: 23, key: "Terminal into object" },
  { rule: "escape", file: "src/terminal/boundaryPlant.ts", line: 26, key: "Terminal into unknown" },
  { rule: "escape", file: "src/terminal/boundaryPlant.ts", line: 28, key: "VtTerminal into unknown" },
  { rule: "escape", file: "src/terminal/boundaryPlant.ts", line: 30, key: "Terminal into unknown" },
  { rule: "member", file: "src/terminal/boundaryPlant.ts", line: 31, key: "Terminal.isOpen" },
  { rule: "member", file: "src/terminal/boundaryPlant.ts", line: 35, key: "Terminal.isOpen" },
  { rule: "escape", file: "src/terminal/boundaryPlant.ts", line: 38, key: "Terminal into any" },
  { rule: "member", file: "src/terminal/boundaryPlant.ts", line: 41, key: "Terminal.isOpen" },
  { rule: "member", file: "src/terminal/boundaryPlant.ts", line: 42, key: "Terminal.isOpen" },
  { rule: "member", file: "src/terminal/boundaryPlant.ts", line: 43, key: "Terminal.isOpen" },
  { rule: "deep", file: "src/terminal/boundaryPlant.ts", line: 44, key: "../../../ghostty-web-ng/lib/renderer.ts" },
  { rule: "duck", file: "src/terminal/boundaryPlant.ts", line: 46, key: "Terminal.wasmTerm" },
  { rule: "duck", file: "src/terminal/boundaryPlant.ts", line: 47, key: "Terminal.sealedSoon" },
  { rule: "escape", file: "src/terminal/boundaryPlant.ts", line: 51, key: "Terminal into unknown" },
  { rule: "cast", file: "src/terminal/boundaryPlant.ts", line: 55, key: "unknown" },
  { rule: "member", file: "src/terminal/boundaryPlant.ts", line: 55, key: "Terminal.isOpen" },
  { rule: "cast", file: "src/terminal/boundaryPlant.ts", line: 59, key: "unknown" },
  { rule: "member", file: "src/terminal/boundaryPlant.ts", line: 59, key: "Terminal.canvas" },
  { rule: "escape", file: "src/terminal/boundaryPlant.ts", line: 62, key: "Terminal into object" },
  { rule: "escape", file: "src/terminal/boundaryPlant.ts", line: 64, key: "Terminal into {}" },
  { rule: "escape", file: "src/terminal/boundaryPlant.ts", line: 65, key: "Terminal into {}" },
  { rule: "escape", file: "src/terminal/boundaryPlant.ts", line: 66, key: "Terminal into object" },
  { rule: "cast", file: "src/terminal/boundaryPlant.ts", line: 67, key: "type parameter T to unknown" },
  { rule: "escape", file: "src/terminal/boundaryPlant.ts", line: 69, key: "Terminal into a parameter any" },
  { rule: "escape", file: "src/terminal/boundaryPlant.ts", line: 70, key: "Terminal into a parameter unknown" },
  { rule: "escape", file: "src/terminal/boundaryPlant.ts", line: 71, key: "Terminal into a parameter any" },
  { rule: "member", file: "src/terminal/boundaryPlant.ts", line: 73, key: "Terminal.isOpen" },
  { rule: "member", file: "src/terminal/boundaryPlant.ts", line: 74, key: "Terminal.isOpen" },
  { rule: "member", file: "src/terminal/boundaryPlant.ts", line: 75, key: "Terminal.isOpen" },
  { rule: "escape", file: "src/terminal/boundaryPlant.ts", line: 75, key: "Terminal into object" },
  { rule: "member", file: "src/terminal/boundaryPlant.ts", line: 76, key: "Terminal.isOpen" },
  { rule: "member", file: "src/terminal/boundaryPlant.ts", line: 77, key: "Terminal.canvas" },
  { rule: "member", file: "src/terminal/boundaryPlant.ts", line: 77, key: "Terminal.canvas" },
  { rule: "cast", file: "src/terminal/boundaryPlant.ts", line: 78, key: "object" },
  { rule: "cast", file: "src/terminal/boundaryPlant.ts", line: 79, key: "{}" },
  { rule: "name", file: "src/state/boundaryPlant.ts", line: 1, key: "wasmTerm" },
  { rule: "name", file: "src/state/boundaryPlant.ts", line: 1, key: "wasmTerm" },
  { rule: "name", file: "src/state/boundaryPlant.ts", line: 1, key: "selectionManager" },
  { rule: "name", file: "src/state/boundaryPlant.ts", line: 1, key: "selectionManager" },
  { rule: "name", file: "src/state/boundaryPlant.ts", line: 3, key: "wasmTerm" },
  { rule: "name", file: "src/state/boundaryPlant.ts", line: 4, key: "wasmTerm" },
  { rule: "cast", file: "src/terminal/BoundaryPlant.svelte", line: 4, key: "unknown" },
  { rule: "member", file: "src/terminal/BoundaryPlant.svelte", line: 4, key: "Terminal.linkDetector" },
  { rule: "name", file: "src/terminal/BoundaryPlant.svelte", line: 4, key: "linkDetector" },
  { rule: "name", file: "src/terminal/BoundaryPlant.svelte", line: 4, key: "linkDetector" },
  { rule: "name", file: "src/terminal/BoundaryPlant.svelte", line: 7, key: "renderer" },
  { rule: "cast", file: "src/terminal/BoundaryPlant.svelte", line: 8, key: "any" },
  { rule: "member", file: "src/terminal/BoundaryPlant.svelte", line: 8, key: "Terminal.isOpen" },
  { rule: "cast", file: "src/terminal/BoundaryPlant.svelte", line: 9, key: "unknown" },
  { rule: "member", file: "src/terminal/BoundaryPlant.svelte", line: 9, key: "Terminal.canvas" },
  { rule: "member", file: "src/terminal/BoundaryPlant.svelte", line: 10, key: "Terminal.isOpen" },
  { rule: "cast", file: "src/terminal/BoundaryPlant.svelte", line: 11, key: "type parameter T to unknown" },
  { rule: "escape", file: "src/terminal/BoundaryPlant.svelte", line: 12, key: "Terminal into a parameter any" },
  { rule: "cast", file: "src/terminal/BoundaryHolder.svelte", line: 12, key: "any" },
  { rule: "member", file: "src/terminal/BoundaryHolder.svelte", line: 12, key: "Terminal.isOpen" },
  { rule: "cast", file: "src/terminal/BoundaryHolder.svelte", line: 13, key: "unknown" },
  { rule: "member", file: "src/terminal/BoundaryHolder.svelte", line: 13, key: "Terminal.isOpen" },
  { rule: "deep", file: "src/terminal/boundaryPlant.test.ts", line: 2, key: "../../../ghostty-web-ng/lib/renderer" },
  { rule: "member", file: "src/terminal/boundaryPlant.test.ts", line: 3, key: "Terminal.isOpen" },
  { rule: "patch", file: "src/terminal/boundaryPlant.test.ts", line: 4, key: "write Terminal.cols" },
  { rule: "member", file: "src/terminal/boundaryPlant.test.ts", line: 10, key: "Terminal.selectionManager" },
  { rule: "member", file: "src/terminal/boundaryPlant.test.ts", line: 14, key: "Terminal.isOpen" },
  { rule: "member", file: "src/terminal/boundaryPlant.test.ts", line: 17, key: "Terminal.assertOpen" },
  { rule: "member", file: "src/terminal/boundaryPlant.test.ts", line: 21, key: "Terminal.isOpen" },
  { rule: "member", file: "src/terminal/boundaryPlant.test.ts", line: 27, key: "Terminal.isOpen" },
  { rule: "member", file: "src/terminal/boundaryPlant.test.ts", line: 31, key: "Terminal.isOpen" },
  { rule: "member", file: "src/terminal/boundaryPlant.test.ts", line: 34, key: "Terminal.assertOpen" },
];

/// Entries over the planted reads that pin a reader too few, a reader too
/// many, a second read on a line where one is pinned, and a reader of
/// another text, and one that is right, so the pin shows it fires on each
/// and only there.
const PLANT_PENDING: readonly Pending[] = [
  ...pending("app terminal", "planted", "deep", "src/terminal/boundaryPlant.ts", {
    "@chan/ghostty-web-ng/lib/renderer": [],
  }),
  ...pending("app terminal", "planted", "patch", "src/terminal/boundaryPlant.ts", {
    "Object.assign Terminal": ["Object.assign(term, { cols: 1 })", "Object.assign(term, { cols: 1 })"],
  }),
  ...pending("app terminal", "planted", "member", "src/terminal/boundaryPlant.ts", {
    "Terminal.canvas": ["(term as unknown as { canvas: HTMLCanvasElement }).canvas", 'term["canvas"]'],
    "Terminal.__proto__": ["term.__proto__"],
  }),
  ...pending("app terminal", "planted", "name", "src/terminal/boundaryPlant.ts", { wasmTerm: ["wasmTerm?: unknown"] }),
];

function show(f: Site): string {
  return `${f.rule} ${f.file}:${f.line} ${f.key}`;
}
const covers = (p: Pending, f: Finding) => p.rule === f.rule && p.file === f.file && p.key === f.key;
/// The entries whose readers are not the texts of the findings they cover,
/// each with the texts it pins and the texts it covers, sorted.
const mispinned = (entries: readonly Pending[], findings: readonly Finding[]) =>
  entries.flatMap((p) => {
    const pins = [...p.readers].sort();
    const found = findings
      .filter((f) => covers(p, f))
      .map((f) => f.text)
      .sort();
    return JSON.stringify(found) === JSON.stringify(pins) ? [] : [{ entry: `${p.rule} ${p.file} ${p.key}`, pins, covers: found }];
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

  test("each pending entry covers exactly the readers it pins", () => {
    expect(mispinned(PENDING, real)).toEqual([]);
  });

  test("a pending entry fails on a reader more, fewer or of another text than it pins", () => {
    expect(mispinned(PLANT_PENDING, planted)).toEqual([
      {
        entry: "deep src/terminal/boundaryPlant.ts @chan/ghostty-web-ng/lib/renderer",
        pins: [],
        covers: ['"@chan/ghostty-web-ng/lib/renderer"'],
      },
      {
        entry: "patch src/terminal/boundaryPlant.ts Object.assign Terminal",
        pins: ["Object.assign(term, { cols: 1 })", "Object.assign(term, { cols: 1 })"],
        covers: ["Object.assign(term, { cols: 1 })"],
      },
      {
        entry: "member src/terminal/boundaryPlant.ts Terminal.canvas",
        pins: ["(term as unknown as { canvas: HTMLCanvasElement }).canvas", 'term["canvas"]'],
        covers: ["(term as unknown as { canvas: HTMLCanvasElement }).canvas", 'term["canvas"]', 'term["canvas"]'],
      },
      {
        entry: "member src/terminal/boundaryPlant.ts Terminal.__proto__",
        pins: ["term.__proto__"],
        covers: ['term["__proto__"]'],
      },
    ]);
  });
});
