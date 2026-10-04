# web-launcher

The chan launcher SPA: the workspace and devserver launcher, embedded and served by chan-server at the devserver and desktop loopback roots.

Same stack as `web/` (Svelte 5, Vite, svelte-check, vitest), without `web/`'s editor (CodeMirror), terminal (xterm), or graph (cytoscape) weight.

## Contract

The ordinary launcher window is an HTTP client of chan-server's library routes. `src/api/library.ts` is the typed form of that contract: the workspace and devserver registry surfaces under `/api/library/`, plus the window feed it renders (`GET`/watch `/api/library/windows`).

## Develop

```
npm install
npm run dev      # vite dev server on :5174, proxying /api to a chan devserver on :8787
npm run check    # svelte-check
npm test         # vitest
npm run build    # -> repo-root web-launcher/dist/ (embedded by chan-server via rust-embed)
```
