// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "vite";
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
  expect(Buffer.from(wasm[0].source)).toEqual(readFileSync("vendor/ghostty-vt/ghostty-vt.wasm"));
});
