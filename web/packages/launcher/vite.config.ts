// vite.config.ts
//
// Build the launcher web app (the workspace/devserver launcher).
//
// Output goes to the repo-root /web-launcher/dist/, which chan-library embeds
// via rust-embed at compile time and serves from its loopback HTTP server. This
// package lives at web/packages/launcher under the ./web npm-workspaces root, so
// the embed-output path is three levels up; the rust-embed input path is frozen
// (X-2), so the source layout moves and the output path does not. The library
// serves /api/library/* and the /api/library/windows/watch socket; everything
// else is this SPA, so base is "./" to keep asset URLs relative. The launcher is
// a pure HTTP client, so it carries none of the workspace-app's editor
// (CodeMirror), terminal (xterm), or graph (cytoscape) weight.

import { svelte } from "@sveltejs/vite-plugin-svelte";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

// Resolve svelte's client entry through node resolution so it works whether
// svelte is hoisted to the workspace-root node_modules or kept package-local;
// svelte's exports map does not expose ./src, so reach it via the package dir.
const require = createRequire(import.meta.url);
const svelteClient = join(dirname(require.resolve("svelte/package.json")), "src/index-client.js");

const here = dirname(fileURLToPath(import.meta.url));

// Frozen rust-embed input path (X-2): repo-root web-launcher/dist.
const OUT_DIR = join(here, "../../../web-launcher/dist");

// The backend port the vite dev server proxies to. Defaults to 8787 (the local
// loopback library / a default `chan devserver`); override with VITE_PROXY_PORT
// to point at a devserver on another port.
const proxyPort = process.env.VITE_PROXY_PORT ?? "8787";

// Hard ceiling on the launcher's gzipped JS. The launcher is the minimal
// HTTP-client SPA (its only runtime dep is lucide-svelte); this budget FAILS the
// build if an accidental heavy import lands -- a CodeMirror/xterm/cytoscape pull,
// or a non-tree-shaken import from @chan/web-shared, would multiply the bundle,
// so the gate catches it here instead of at release. The bundle is ~46 KiB
// gzipped (the client-side window manager, per-tenant leadership derivation,
// window URL builder, config-backed per-machine collapse, the Gateways screen,
// and the shared command deck with its Computers provider); the ceiling carries
// headroom for normal drift while staying far below what any heavy import would
// produce, since CodeMirror or xterm would multiply rather than merely nudge it.
const LAUNCHER_GZIP_BUDGET_BYTES = 56 * 1024;

function launcherSizeBudget(): Plugin {
  return {
    name: "launcher-size-budget",
    apply: "build",
    closeBundle() {
      const assets = join(OUT_DIR, "assets");
      let total = 0;
      const parts: string[] = [];
      for (const name of readdirSync(assets)) {
        if (!name.endsWith(".js")) continue;
        const gz = gzipSync(readFileSync(join(assets, name)), { level: 9 }).length;
        total += gz;
        parts.push(`${name} ${(gz / 1024).toFixed(1)} KiB`);
      }
      const kib = (total / 1024).toFixed(1);
      const budgetKib = (LAUNCHER_GZIP_BUDGET_BYTES / 1024).toFixed(0);
      if (total > LAUNCHER_GZIP_BUDGET_BYTES) {
        throw new Error(
          `@chan/launcher gzipped JS ${kib} KiB exceeds the ${budgetKib} KiB budget ` +
            `(${parts.join(", ")}). The launcher must stay minimal: check for an ` +
            `accidental CodeMirror/xterm/cytoscape import or a non-tree-shaken ` +
            `@chan/web-shared pull.`,
        );
      }
      console.log(`launcher gzipped JS ${kib} KiB / ${budgetKib} KiB budget (${parts.join(", ")})`);
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [svelte(), launcherSizeBudget()],
  resolve: {
    alias: {
      "@chan/web-shared/command-deck": join(here, "../web-shared/src/command-deck/model.ts"),
      "@chan/web-shared/CommandDeck.svelte": join(
        here,
        "../web-shared/src/components/CommandDeck.svelte",
      ),
    },
  },
  server: {
    port: 5174,
    // While iterating, proxy the library HTTP surface to a running
    // `chan devserver` (or the local loopback library) so the SPA talks
    // to the real backend without rebuilding the binary on every change.
    proxy: {
      "/api/library/windows/watch": { target: `ws://127.0.0.1:${proxyPort}`, ws: true },
      "/api": `http://127.0.0.1:${proxyPort}`,
    },
  },
  build: {
    // Frozen rust-embed input path (X-2): repo-root web-launcher/dist, three
    // levels up from this package. crates/chan-server/build.rs +
    // static_assets.rs are untouched; only the source location moved under ./web.
    outDir: "../../../web-launcher/dist",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
  },
  test: {
    environment: "jsdom",
    alias: [{ find: /^svelte$/, replacement: svelteClient }],
    testTimeout: 30_000,
  },
});
