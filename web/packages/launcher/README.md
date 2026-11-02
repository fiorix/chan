# @chan/launcher

The chan launcher SPA: the Computers screen that lists this machine, devservers, gateways and windows, embedded in chan-server and served at the root of every host, the desktop loopback, a devserver and a gateway origin alike.

Same stack as the workspace app (Svelte 5, Vite, svelte-check, vitest), without the workspace app's editor, terminal or graph weight. The design of record is [design.md](design.md).

## Contract

The launcher page is an HTTP client of chan-server's library routes. `src/api/library.ts` is the typed form of that contract: the workspace, devserver and gateway registries under `/api/library/`, the window feed it renders (`/api/library/windows` and its watch socket, whose snapshot also carries the live tmux control-mode connections the Computers deck deals as cards), and the request route behind those cards.

## Develop

```
npm install
npm run dev      # vite dev server, proxying /api to a chan devserver on :8787
npm run check    # svelte-check
npm test         # vitest
npm run build    # -> repo-root web-launcher/dist/ (embedded by chan-server via rust-embed)
```

`VITE_PROXY_PORT` points the dev proxy at another port.
