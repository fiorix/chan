// vite.config.ts
//
// Build the Hybrid shell: the internal window manager that hosts chan windows
// as frames inside one host webview, with the launcher docked beside them.
//
// Output goes to the repo-root /web-hybrid/dist/, which chan-server embeds via
// rust-embed at compile time and serves under /__hybrid/ from the launcher
// router. That path is same-origin with the launcher at `/` and with every
// tenant at `/{prefix}/`, which is what lets the shell reach into its frames.
// This package lives at web/packages/hybrid under the ./web npm-workspaces
// root, so the embed-output path is three levels up; the rust-embed input path
// is frozen, so the source layout can move while the output path does not.
//
// base is "./" because the shell is served from a subpath, not the origin
// root: relative asset URLs resolve under /__hybrid/ without the build needing
// to know the mount point.
//
// The shell has no npm dependencies. Its window manager is the vendored WinBox
// bundle in public/vendor, copied verbatim rather than bundled so it keeps its
// upstream Apache-2.0 header and stays trivially replaceable.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = dirname(fileURLToPath(import.meta.url));

// The backend the vite dev server proxies to while iterating on the shell:
// a running `chan open` or `chan devserver`. Overridden with VITE_PROXY_PORT.
const proxyPort = process.env.VITE_PROXY_PORT ?? "8787";

export default defineConfig({
  base: "./",
  server: {
    port: 5175,
    proxy: {
      "/api/library/windows/watch": { target: `ws://127.0.0.1:${proxyPort}`, ws: true },
      "/api": `http://127.0.0.1:${proxyPort}`,
    },
  },
  build: {
    // Frozen rust-embed input path: repo-root web-hybrid/dist, three levels up
    // from this package.
    outDir: join(here, "../../../web-hybrid/dist"),
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
  },
  test: {
    environment: "node",
  },
});
