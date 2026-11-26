// @vitest-environment node
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";
import { build, type Plugin } from "vite";
import { expect, test } from "vitest";

test("the terminal bundle ships the vendored wasm without an inline copy", async () => {
  const result = await build({
    configFile: fileURLToPath(new URL("./vite.config.ts", import.meta.url)),
    logLevel: "silent",
    build: {
      write: false,
      rollupOptions: {
        input: fileURLToPath(new URL("./src/terminal/backend.ts", import.meta.url)),
        preserveEntrySignatures: "strict",
      },
    },
  });
  if (Array.isArray(result) || !("output" in result)) throw new Error("expected one bundle");
  const chunks = result.output.filter((item) => item.type === "chunk");
  const renderer = chunks.filter((chunk) => Object.keys(chunk.modules).some((id) => id.endsWith("/ghostty-web-ng/lib/terminal.ts")));
  expect(renderer.map((chunk) => chunk.fileName), "the renderer is bundled in one chunk").toHaveLength(1);
  // Checks 211 and 223 find the widget's chunk by this name.
  expect(renderer[0].fileName).toMatch(/^assets\/ghostty-web-[\w-]+\.js$/);
  // The emitted JavaScript must not carry a second, unused wasm binary.
  expect(chunks.filter((chunk) => chunk.code.includes("data:application/wasm")).map((chunk) => chunk.fileName)).toEqual([]);
  const wasm = result.output.filter((item) => item.type === "asset" && item.fileName.endsWith(".wasm"));
  expect(wasm).toHaveLength(1);
  expect(Buffer.from(wasm[0].source)).toEqual(readFileSync("../ghostty-web-ng/vendor/ghostty-vt/ghostty-vt.wasm"));
  const loader = chunks.filter((chunk) => Object.keys(chunk.modules).some((id) => id.endsWith("/src/terminal/backend.ts")));
  expect(loader.map((chunk) => chunk.fileName), "the loader is bundled in one chunk").toHaveLength(1);
  // An engine may keep a failed module import for the page's life. The
  // loader's own chunk names the core's URL, so no module import stands
  // between a spawn and the core's fetch.
  const core = posix.basename(wasm[0].fileName);
  expect(chunks.filter((chunk) => chunk.code.includes(core)).map((chunk) => chunk.fileName), "the chunks naming the core").toEqual([loader[0].fileName]);
  // And after an import of the widget failed, the loader asks for the
  // widget's chunk at the chunk's own URL.
  const widget = posix.basename(renderer[0].fileName).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  expect(loader[0].code).toMatch(new RegExp(`new URL\\(\\s*(["'\`])${widget}\\1\\s*,\\s*import\\.meta\\.url\\s*\\)`));
});

// After a failed import the loader asks for the widget's chunk at a new URL,
// which leaves the chunks it imports at theirs. A lazily loaded module that
// shares one of the widget's modules makes the bundler put that module in a
// chunk of its own, which the widget's chunk imports and no entry loads.
test("a build fails when the widget's chunk would import a chunk no entry loads at startup", async () => {
  const entry = "\0shared-widget-module-entry";
  const lazy = "\0shared-widget-module-lazy";
  const backend = fileURLToPath(new URL("./src/terminal/backend.ts", import.meta.url));
  const glyphs = fileURLToPath(new URL("../ghostty-web-ng/lib/box-glyphs.ts", import.meta.url));
  const sharesAWidgetModule: Plugin = {
    name: "shares-a-widget-module",
    resolveId: (id) => (id === "virtual:entry" ? entry : id === "virtual:lazy" ? lazy : undefined),
    load(id) {
      if (id === entry) return `export * from ${JSON.stringify(backend)};\nexport const lazy = () => import("virtual:lazy");`;
      if (id === lazy) return `export { isCustomGlyph } from ${JSON.stringify(glyphs)};`;
      return undefined;
    },
  };
  const building = build({
    configFile: fileURLToPath(new URL("./vite.config.ts", import.meta.url)),
    logLevel: "silent",
    plugins: [sharesAWidgetModule],
    build: { write: false, rollupOptions: { input: "virtual:entry", preserveEntrySignatures: "strict" } },
  });
  await expect(building).rejects.toThrow(/the terminal widget's chunk assets\/ghostty-web-[\w-]+\.js imports assets\/box-glyphs-[\w-]+\.js, which no entry loads at startup/);
});

// The app's one terminal is the Ghostty widget. @xterm/xterm stays installed
// as a development dependency for the keyboard parity tests, so only a build
// of the whole app keeps production code from bundling it or its stylesheet.
const SECOND_TERMINAL_MODULES = "/node_modules/@xterm/";
const SECOND_TERMINAL_CSS = ".xterm";

test("the app bundle carries no xterm.js module or stylesheet", async () => {
  const result = await build({
    configFile: fileURLToPath(new URL("./vite.config.ts", import.meta.url)),
    logLevel: "silent",
    build: { write: false },
  });
  if (Array.isArray(result) || !("output" in result)) throw new Error("expected one bundle");
  const chunks = result.output.filter((item) => item.type === "chunk");
  const moduleIds = chunks.flatMap((chunk) => Object.keys(chunk.modules).map((id) => `${chunk.fileName} ${id}`));
  // The build is the app's, from its entry to the lazily loaded widget.
  expect(moduleIds.some((entry) => entry.endsWith("/src/App.svelte"))).toBe(true);
  expect(moduleIds.some((entry) => entry.endsWith("/ghostty-web-ng/lib/terminal.ts"))).toBe(true);
  expect(moduleIds.filter((entry) => entry.includes(SECOND_TERMINAL_MODULES))).toEqual([]);
  const stylesheets = result.output.filter((item) => item.type === "asset").filter((asset) => asset.fileName.endsWith(".css"));
  expect(stylesheets.length).toBeGreaterThan(0);
  const styled = stylesheets.filter((asset) => Buffer.from(asset.source).toString("utf8").includes(SECOND_TERMINAL_CSS));
  expect(styled.map((asset) => asset.fileName)).toEqual([]);
}, 120_000);
