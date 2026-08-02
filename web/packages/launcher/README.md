# web-launcher

The chan launcher SPA: the workspace and devserver launcher, served by the chan-library loopback HTTP server and embedded into chan-desktop.

Same stack as `web/` (Svelte 5, Vite, svelte-check, vitest), without `web/`'s editor (CodeMirror), terminal (xterm), or graph (cytoscape) weight.

## Contract

The ordinary launcher window is an HTTP client of chan-library. `src/api/library.ts` is the typed form of that contract: the workspace and devserver registry surfaces under `/api/library/`, plus the window feed it renders (`GET`/watch `/api/library/windows`). In Chan Desktop, the same bundle's `?command=1` entry renders the trusted command overlay and uses only the overlay-specific Tauri permissions.

## Develop

```
npm install
npm run dev      # vite dev server on :5174, proxying /api to a chan-library on :8787
npm run check    # svelte-check
npm test         # vitest
npm run build    # -> dist/ (embedded by chan-library via rust-embed)
```
