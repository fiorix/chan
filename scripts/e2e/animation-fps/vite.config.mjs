// Build the animation frame-rate harness.
//
// WHY its own config rather than the app's: workspace-app's vite.config.ts
// carries the excalidraw font copier, the rust-embed output path and the whole
// SPA's plugin chain. None of that is needed to mount seven components, and a
// harness that failed because an unrelated plugin failed would be reporting on
// something it does not measure. This config is the svelte plugin and an alias,
// which is the entire dependency of the measurement.
//
// WHY it is COPIED into a staged directory rather than run where it lives:
// this file's home is scripts/e2e/, which is outside the npm workspace, so
// node walks up from it and never finds a node_modules -- `vite` itself does
// not resolve. The driver stages a temp directory holding a copy of this file,
// the page and the entry, plus a node_modules symlink into web/, and builds
// there. It is the same staging terminal-pixels.py does for the same reason.
// A symlink of this file would not do: node resolves a module's imports from
// its realpath, which would land back outside the workspace.
//
// The components are imported from the app's own source tree through the
// @components alias, so what gets measured is the product, not a copy of it.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// Set by the driver. The fallbacks let this config be run by hand from its
// home in the source tree, once a node_modules is reachable from there.
const workspaceApp =
  process.env.CHAN_FPS_WORKSPACE_APP ??
  resolve(here, "../../../web/packages/workspace-app");
const outDir =
  process.env.CHAN_FPS_OUT ?? resolve(here, "../../../target/e2e/animation-fps/dist");

// Resolved through the staged node_modules rather than imported by bare
// specifier at the top of the file, so the failure mode is a clear message
// instead of a rollup UNRESOLVED_IMPORT trace.
const { svelte } = await import("@sveltejs/vite-plugin-svelte");

export default {
  root: here,
  // Relative, so the built page opens from a file:// path or from any prefix
  // a static server happens to mount it under.
  base: "./",
  plugins: [svelte({ configFile: resolve(workspaceApp, "svelte.config.js") })],
  resolve: {
    alias: { "@components": resolve(workspaceApp, "src/components") },
  },
  build: {
    outDir,
    emptyOutDir: true,
    // The harness is read by a human as often as by the driver; unminified
    // output keeps a stack trace legible when a component throws during mount.
    minify: false,
  },
};
