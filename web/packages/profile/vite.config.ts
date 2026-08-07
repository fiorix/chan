// Build the gateway identity SPA (@chan/profile), served on the identity
// origin gw.{domain}.
//
// Output goes to the frozen gateway/crates/identity/web/dist, which the
// gateway identity crate embeds via rust-embed at compile time. This package
// lives at web/packages/profile under the ./web npm-workspaces root, so the
// embed-output path is three levels up; the rust-embed input path is frozen,
// so the source layout can move while the output path does not. Backend
// serves /auth/*, /api/*,
// /healthz; everything else falls back to the SPA, so we keep asset URLs
// relative.

import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  plugins: [svelte()],
  server: {
    port: 5173,
    // Proxy backend routes to a running identity-service so
    // `npm run dev` works end-to-end against real OAuth.
    proxy: {
      "/api": "http://127.0.0.1:7000",
      "/auth": "http://127.0.0.1:7000",
      "/healthz": "http://127.0.0.1:7000",
    },
  },
  build: {
    // Frozen rust-embed input path: the gateway identity crate's
    // gateway/crates/identity/web/dist, three levels up from this package
    // (static_files.rs declares #[folder = "web/dist/"]).
    outDir: "../../../gateway/crates/identity/web/dist",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
  },
});
