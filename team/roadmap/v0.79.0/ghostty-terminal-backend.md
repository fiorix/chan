# ghostty-web as an alternate terminal backend

Status: ACCEPTED on `v079/integration` for v0.79.0 as an optional, default-off backend.

## What

An opt-in `terminal.ghostty` server setting (default off, with a Settings checkbox) that makes newly opened terminals parse and render through ghostty-web, Ghostty's WASM VT engine with an xterm.js-compatible API, instead of xterm.js. With the setting false or absent, newly opened terminals retain the existing xterm.js implementation and feature set. The ~420 KB wasm plus library lazy-load only when the toggle is on, and a failed load falls back to xterm.js.

## Implementation boundaries

The implementation pins ghostty-web `0.4.0-next.20`, because the `0.4.0` release predates its `InputHandler` mouse reporting. Four upstream-behavior workarounds are load-bearing:

- OSC 52 clipboard rides a byte-level observer (`web/packages/workspace-app/src/terminal/osc52Bridge.ts`), because ghostty-web's WASM parser swallows the sequence with no JS hook.
- SGR wheel reporting rides a chan-side shim, because upstream's capture-phase viewport scroller `stopPropagation()`s the wheel before its `InputHandler` sees it.
- The key-handler wrap maps chan's xterm-semantics handler to ghostty-web's inverted (`true` = handled) contract.
- The write-origin tracker uses a synchronous writer on the ghostty branch, because upstream defers write callbacks to rAF, which stalls in a backgrounded or headless page and would wedge replay suppression open, silently eating mouse reports and Alt+keys.

`terminal.mouse_capture` keeps working: its DECSET strip is byte-level and runs ahead of either parser.

Browser-smoke check `98` covers the default-off contract, lazy loading, fallback, OSC 52, key input, mouse capture, selection, and SGR wheel reports. Check `97` remains the xterm regression proof.

## Open owner decisions

- Whether the pin can move to a stable ghostty-web release, and what the upgrade contract is.
- Whether check `98` belongs in the default browser-smoke run or stays gated, given the suite's existing contention flakiness on the dev host.
