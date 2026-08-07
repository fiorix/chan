// vite.config.ts
//
// Build the editor web app.
//
// Output goes to the repo-root /web/dist/, which chan-server embeds via
// rust-embed at compile time. This package lives at web/packages/workspace-app
// under the ./web npm-workspaces root, so the embed-output path is two levels
// up (../../dist); the rust-embed input path is frozen, so the source layout
// moves and the output path does not. The Rust backend serves /api/* and the
// WS at /ws; everything else is the SPA, so we set base to "./" to keep asset
// URLs relative.

import { svelte } from "@sveltejs/vite-plugin-svelte";
import { createReadStream } from "node:fs";
import { cp } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

// Resolve svelte's client entry through node resolution so it works whether
// svelte is hoisted to the workspace-root node_modules or kept package-local;
// svelte's exports map does not expose ./src, so reach it via the package dir.
const require = createRequire(import.meta.url);
const svelteClient = join(dirname(require.resolve("svelte/package.json")), "src/index-client.js");

// Self-host excalidraw's canvas fonts. Excalidraw fetches label fonts at
// runtime from `EXCALIDRAW_ASSET_PATH + fonts/<Family>/<file>.woff2`;
// without a local copy it falls through to the esm.sh CDN, so offline
// sessions and chan-desktop degrade silently. Copy the package's prod
// fonts verbatim into dist/static/excalidraw/fonts (chan-server serves
// web/dist/static/* through its SPA fallback, prefix-aware) and serve the
// same files from the vite dev server. Filenames must survive the copy since
// excalidraw composes them itself, so no hashing. Xiaolai (the 12.7M CJK
// family) is excluded, keeping dist growth near 0.5M; CJK boards fall back
// to the CDN.
function excalidrawFonts(): Plugin {
  const SKIP_FAMILY = "Xiaolai";
  let fontsSrc: string | null = null;
  const resolveFontsSrc = (): string => {
    if (fontsSrc === null) {
      fontsSrc = join(dirname(require.resolve("@excalidraw/excalidraw")), "fonts");
    }
    return fontsSrc;
  };
  return {
    name: "excalidraw-fonts",
    async writeBundle(options) {
      if (!options.dir) return;
      await cp(resolveFontsSrc(), join(options.dir, "static/excalidraw/fonts"), {
        recursive: true,
        filter: (src) => !src.split(sep).includes(SKIP_FAMILY),
      });
    },
    configureServer(server) {
      const marker = "/static/excalidraw/fonts/";
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? "";
        const at = url.indexOf(marker);
        if (at === -1) return next();
        const rel = decodeURIComponent(url.slice(at + marker.length).split("?")[0]);
        const base = resolveFontsSrc();
        const filePath = normalize(join(base, rel));
        // Path-traversal guard: stay inside the fonts dir.
        if (filePath !== base && !filePath.startsWith(base + sep)) {
          res.statusCode = 403;
          res.end();
          return;
        }
        res.setHeader("Content-Type", "font/woff2");
        createReadStream(filePath)
          .on("error", () => next())
          .pipe(res);
      });
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [svelte(), excalidrawFonts()],
  resolve: {
    alias: {
      "@chan/web-shared/command-deck": join(dirname(fileURLToPath(import.meta.url)), "../web-shared/src/command-deck/model.ts"),
      "@chan/web-shared/CommandDeck.svelte": join(dirname(fileURLToPath(import.meta.url)), "../web-shared/src/components/CommandDeck.svelte"),
    },
  },
  server: {
    port: 5173,
    // Allow vite to serve files from the chan repo root + the
    // docs/templates/ tree: the team orchestrator imports
    // `docs/templates/team-process/*.tpl?raw` to bundle the process
    // docs into the SPA build at compile time (vite `?raw`, no
    // chan-server endpoint). Without this `fs.allow`, vite's
    // default `fs.strict` blocks the parent-dir traversal.
    fs: {
      allow: [".", ".."],
    },
    // While iterating, proxy API + WS to a running `chan open` /
    // `chan devserver` backend so we get the real backend without
    // rebuilding the binary on every change.
    proxy: {
      "/api/terminal/ws": { target: "ws://127.0.0.1:8787", ws: true },
      "/api": "http://127.0.0.1:8787",
      "/ws": { target: "ws://127.0.0.1:8787", ws: true },
    },
  },
  build: {
    // Frozen rust-embed input path: repo-root web/dist, two levels up
    // from this package.
    outDir: "../../dist",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
    // The SPA ships as one embedded bundle served from localhost by
    // chan-server; aggressive code-splitting is a non-goal. The main
    // chunk sits near 1.5 MB (CodeMirror + xterm + svelte), so the
    // default 500 kB advisory would always fire. Keep a ceiling so
    // real regressions still warn.
    chunkSizeWarningLimit: 1600,
    rollupOptions: {
      onwarn(warning, warn) {
        // Known-cosmetic: store.svelte.ts is imported dynamically as a
        // deliberate module-eval cycle-breaker (tabs.svelte.ts), and
        // @codemirror/lang-html statically pulls lang-css/js that
        // code_languages.ts loads lazily. Neither dynamic import is
        // meant to create a chunk, so the "ineffective" advisory is
        // expected. Everything else still warns.
        if (warning.code === "INEFFECTIVE_DYNAMIC_IMPORT") return;
        warn(warning);
      },
    },
  },
  test: {
    environment: "jsdom",
    // Guarantees a working localStorage / sessionStorage under every Node the
    // gate runs on; see vitest.setup.ts for what jsdom does not deliver.
    setupFiles: ["./vitest.setup.ts"],
    alias: [{ find: /^svelte$/, replacement: svelteClient }],
    testTimeout: 30_000,
  },
});
