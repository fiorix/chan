# ghostty-web as an alternate terminal backend

Status: REGISTERED for v0.79.0, NOT specced. The work exists as a branch, not as an accepted design; spec the acceptance boundary before merging it.

## What

An opt-in `terminal.ghostty` server setting (default off, with a Settings checkbox) that makes newly opened terminals parse and render through ghostty-web, Ghostty's WASM VT engine with an xterm.js-compatible API, instead of xterm.js. The ~420 KB wasm plus library lazy-load only when the toggle is on, and a failed load falls back to xterm.js.

## Where the work sits

Branch `v076/ghostty-backend`, one commit `0d392692`, based on `3674d30b` (the v0.77.0 GA commit). **It needs rebasing onto post-0.78.0 main before any further work.** The branch touches `CHANGELOG.md`, so the rebase will conflict there against the v0.78.0 section; that conflict is expected and mechanical.

The branch pins ghostty-web `0.4.0-next.20`, because the `0.4.0` release predates its `InputHandler` mouse reporting. A pre-release pin is itself a spec question, not a settled decision.

## What the branch already establishes (grounding, not acceptance)

Four upstream-behavior workarounds are the substance of the change, and each is a place where ghostty-web and xterm.js are not actually interchangeable:

- OSC 52 clipboard rides a byte-level observer (`web/packages/workspace-app/src/terminal/osc52Bridge.ts`), because ghostty-web's WASM parser swallows the sequence with no JS hook.
- SGR wheel reporting rides a chan-side shim, because upstream's capture-phase viewport scroller `stopPropagation()`s the wheel before its `InputHandler` sees it.
- The key-handler wrap maps chan's xterm-semantics handler to ghostty-web's inverted (`true` = handled) contract.
- The write-origin tracker uses a synchronous writer on the ghostty branch, because upstream defers write callbacks to rAF, which stalls in a backgrounded or headless page and would wedge replay suppression open, silently eating mouse reports and Alt+keys.

`terminal.mouse_capture` keeps working: its DECSET strip is byte-level and runs ahead of either parser.

The branch reports browser-smoke `98` (a new ghostty matrix including OSC 52 and mouse) and `97` (xterm regression) green, plus `make pre-push` green, on its own base. Those results predate two releases of main and are claims about the old base, not evidence for the rebased tree.

## Open (decide at spec time, not now)

- Whether a second terminal backend is scope chan wants at all, given that the four workarounds above are ongoing maintenance against an upstream pre-release.
- Feature parity: find bar, styled scrollback snapshots, and `openExternalUrl` link routing stay xterm-only on the branch. Whether that gap is acceptable for an opt-in toggle, or blocks it.
- Whether the pin can move to a stable ghostty-web release, and what the upgrade contract is.
- Whether check `98` belongs in the default browser-smoke run or stays gated, given the suite's existing contention flakiness on the dev host.
