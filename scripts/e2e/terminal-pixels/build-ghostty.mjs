#!/usr/bin/env node
/**
 * Bundle the ghostty widget into one ES module for the pixel harness page.
 *
 * WHY: the page loads the widget straight into a real webview, and the
 * workspace package @chan/ghostty-web-ng holds TypeScript sources only. Vite
 * compiles them as the app's build does, each file under its nearest
 * tsconfig.json, so the page paints with the code the app ships. Both drivers
 * (terminal-pixels.py and terminal-pixels.mjs) call this before they serve.
 *
 * Usage: node scripts/e2e/terminal-pixels/build-ghostty.mjs OUT_DIR
 *
 * Writes OUT_DIR/ghostty-web.js, whatever chunks it imports, and a copy of
 * the widget's ghostty-vt.wasm, which the page loads by path.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, "../../../web");
const WIDGET = path.join(WEB, "packages/ghostty-web-ng");

export async function buildGhostty(outDir) {
  const require = createRequire(path.join(WEB, "package.json"));
  let vite;
  try {
    vite = await import(pathToFileURL(require.resolve("vite")).href);
  } catch (error) {
    throw new Error(`missing vite (${error.message}); run \`npm install\` under web/`);
  }
  fs.mkdirSync(outDir, { recursive: true });
  await vite.build({
    configFile: false,
    // Vite writes its caches under the root; keep them out of the sources.
    root: outDir,
    publicDir: false,
    logLevel: "error",
    build: {
      outDir,
      emptyOutDir: false,
      minify: false,
      lib: {
        entry: path.join(WIDGET, "lib/index.ts"),
        formats: ["es"],
        fileName: () => "ghostty-web.js",
      },
    },
  });
  if (!fs.existsSync(path.join(outDir, "ghostty-web.js"))) {
    throw new Error(`vite wrote no ghostty-web.js to ${outDir}`);
  }
  fs.copyFileSync(path.join(WIDGET, "ghostty-vt.wasm"), path.join(outDir, "ghostty-vt.wasm"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const outDir = process.argv[2];
  if (!outDir) {
    console.error("usage: build-ghostty.mjs OUT_DIR");
    process.exit(2);
  }
  await buildGhostty(path.resolve(outDir));
}
