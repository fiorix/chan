---
name: webdev
description: >-
  Frontend and web app work, especially TypeScript, Svelte 5, Vite,
  SPA architecture, browser APIs, CodeMirror 6, and Rust-backed web frontends.
when_to_use: >-
  Building or reviewing the chan SPA (`web/`), the marketing site, or
  any browser/WebView surface; deciding shell vs feature boundaries, command and
  keyboard model, or Tauri host readiness.
---

# Web Development

Build lean, maintainable browser software. Treat HTML, CSS, browser APIs, and the app's interaction model as the platform. Add framework and package weight only when it earns its keep.

## Current Default Stack

- Vite, Svelte 5, TypeScript, CodeMirror 6.
- SvelteKit only when routing, SSR, server actions, or file-based app structure are actually useful. For a Rust-served SPA, plain Vite is usually enough.
- Component CSS plus shared CSS variables. Tailwind only if already present.
- Native `fetch` behind a typed transport/client boundary. No Axios by default.
- lucide-svelte for icons where available.
- Vitest for unit tests, svelte-check for Svelte/TypeScript validation.

## Svelte 5 Rules

- Use runes mode deliberately: `$state`, `$derived`, `$effect`, `$props`, `$bindable`.
- Prefer `$derived` for derived data. Do not use `$effect` to synchronize state that can be computed.
- Use `$effect` only for side effects: DOM integration, subscriptions, timers, network calls, third-party imperative libraries. Return cleanup functions.
- Keep `$effect` state writes rare and justified; avoid update loops.
- Use `.svelte.ts` modules for shared reactive state when a feature needs cross-component state. Keep modules focused by concern.
- Avoid React patterns: no hook-shaped abstractions, no prop drilling where a small state module or context is clearer, no component trees that exist only to shuttle callbacks.
- Use typed `$props()` destructuring. Use `$bindable` sparingly; bound props are for true two-way component state such as inputs, resize widths, and open state, not general data flow.
- Use snippets for reusable render regions when component extraction would add ceremony without a clearer boundary.

## Vite Rules

- Keep `vite.config.ts` short. Prefer Vite defaults and official plugins.
- Treat `index.html` as source and the app entry point.
- Use Vite env variables only with the `VITE_` prefix; never put secrets in frontend env.
- Keep assets in the Vite asset pipeline unless they are true public root assets.
- Split heavy routes/surfaces with dynamic imports when initial bundle size or startup cost warrants it.
- For Rust-backed apps, build static assets that Rust serves or embeds. Use a dev proxy only as a development convenience.

## CodeMirror 6 Rules

- Respect CM6's model: immutable `EditorState`, transactions, facets, extensions, state fields, view plugins, decorations.
- Do not mutate CodeMirror state or DOM directly. Dispatch transactions or use documented extension points.
- Use compartments for dynamic configuration such as language, theme, read-only, keymaps, line wrapping, or feature toggles.
- Use state fields for editor-owned state that must track transactions.
- Use view plugins for shallow DOM-facing views over editor state. Implement cleanup in `destroy`.
- Use decorations/widgets for presentation. Keep the markdown/source document as the single backing document; WYSIWYG is a presentation layer.
- Keep keymaps explicit and ordered. Use precedence when a feature-specific keymap must beat defaults.
- Destroy EditorView instances on unmount.

## Baseline App Shell

- A workspace acts like a small window manager: panes, tabs, split panes, active focus, drag resize, session restore.
- Feature surfaces are window-level overlays: files, search, graph, assistant, settings, history, diff, modal prompts, disconnect/auth states.
- Overlays share shell behavior: backdrop, stacking, Escape handling, safe-area gutters, maximized/restored sizing, animation policy.
- Overlay chrome convention:
  - maximize/restore on the left,
  - primary title/context in the center,
  - hamburger/actions and close on the right,
  - optional right inspector,
  - optional left navigation/outline pane.
- Design for future detachable/floating overlays, minimize-to-dock, z-order, persistent placement, and theme skins such as CDE, WindowMaker, or macOS. Do not bake modal assumptions into feature internals.

## Shell Architecture

- Separate shell primitives from feature bodies:
  - `OverlayShell`: backdrop, stacking, panel sizing, safe-area rules.
  - `Inspector`: resizable side-pane chrome only.
  - `HamburgerMenu` or equivalent: one triggerless/triggered menu primitive.
  - Feature components: own data loading, body rendering, and action lists.
- App root owns global overlays and global keyboard handling.
- Overlay stack is central; Escape closes one topmost overlay, not every mounted overlay.
- Menus are command surfaces. Header hamburger and right-click context menu should render the same action list.
- Preserve native context menus in text inputs unless the app provides a better editor-specific command menu.
- Use portals for fixed menus/popovers when transformed ancestors would break viewport positioning.

## Command And Keyboard Model

- Maintain a central shortcut/command registry.
- Stable command ids are the contract. Chords are platform-specific bindings to those ids.
- The registry should feed:
  - browser key handling,
  - native/Tauri key remapping,
  - visible menu chord labels,
  - shortcut tables,
  - generated CLI/help text.
- Match browser-reserved chords honestly. Use web fallbacks where browsers own shortcuts; let native shells intercept OS/browser-reserved chords and dispatch command events.
- Prefer `KeyboardEvent.code` when modifier keys can change `key`, especially Option/Alt on macOS.
- Commands should be invokable from keyboard, menu, context menu, and host bridge without duplicating behavior.

## Tauri And Host Readiness

- Keep the SPA usable in a normal browser.
- Native wrappers should add capabilities through a small host bridge that dispatches stable command events and injects platform metadata.
- Prefer one HTTP/WebSocket transport and one typed API surface across browser and native. Do not split protocol paths unless it removes real complexity.
- Avoid `window.prompt` and `window.confirm`; use in-app modals that work in WebViews.
- Keep native detection localized to host integration and presentation labels.

## Organization

- Keep modules aligned by responsibility, not by framework artifact type.
- Shared state modules should expose a small domain API, not a junk drawer of writable globals.
- Prefer explicit domain types for pane ids, overlay ids, command ids, tab state, inspector targets, and file kinds.
- Split large components when there is a real boundary: shell vs body, chrome vs content, data loading vs rendering, command list vs menu primitive.
- Avoid barrels unless the project already uses them and tree-shaking impact is understood.
- Comments explain constraints and non-obvious tradeoffs, not what the code says.

## Quality Bar

- Semantic HTML and keyboard accessibility are baseline requirements.
- Every interactive surface must have keyboard reachability, focus behavior, and sane ARIA where native elements are not enough.
- Layout must be stable: fixed-format controls need stable dimensions and text must not overlap.
- Mobile and small-window behavior must be intentional, even when a feature is desktop-first.
- No decorative framework churn. Prefer small, boring components and explicit state transitions.
- Verify with `npm run check`, focused Vitest tests, and manual interaction.
- For shell changes, explicitly check overlay stacking, Escape behavior, menu placement, context-menu parity, command dispatch, focus restoration, and safe-area/mobile gutters.

## Tests

- A frontend test fails when behaviour breaks and passes when a comment or a spelling changes. Test what a user or a caller can observe: mount the component with `svelte`'s `mount` (the whole app over the in-memory demo transport in `src/demo/` when the behaviour crosses components) or call the exported function, and assert on the DOM, the state module, the request sent, or the value returned.
- Source-text assertions (a `?raw` import of a production module, `import.meta.glob` with `query: "?raw"`, a `node:fs` read of a source file) survive only for a build-time contract with no runtime seam: a property of the source tree that no mounted or behavioural test can observe, typically because it must hold for a module nobody has written yet. The allowed cases are:
  - `no_native_dialogs.test.ts` in both SPAs: no shipped module calls `window.alert`, `window.confirm` or `window.prompt`, which fail silently in the desktop WebView.
  - `random_uuid_centralization.test.ts`: the shipped modules that name `crypto.randomUUID`, which throws outside a secure context such as a devserver reached over plain http, are `state/ids.ts` and exactly the modules its `OWN_MINT` list names as still minting with a fallback of their own, so a new call site fails and so does a module folded onto `newUuid` but left on the list.
  - `tauri_invoke_centralization.test.ts`: `tauriInvoke` is called only in `api/desktop.ts` and the Tauri globals are reached only from the audited modules, because the desktop ACL parity test reads the invoke vocabulary from those files with `include_str!`.
  - `editor/widgets/widgetWritable.test.ts`: every widget module that dispatches a document change imports the write predicate, so a widget added later is checked the moment it lands.
  - The launcher's `themeTokens.test.ts`: both themes define the same tokens and no source spells a token's colour as a literal, which `var()` resolution hides from every runtime check.
  - `state/paneMouseSplit.test.ts`: the edge-split size gate's chrome constant equals one split divider plus two pane margins as the Workspace and Pane stylesheets set them, and jsdom lays out nothing, so no mounted test can measure either.
  - `the back face never paints at rest` in `components/Pane.test.ts` and in the launcher's `lib/flip.test.ts`: the flip's back face is held off the screen at rest by a `visibility` gate, handed over at the easing's 90deg crossing, gated again under reduced motion, and named so the `animationend` substring match finds only its own keyframe. WebKitGTK ignores `backface-visibility` and jsdom applies no component CSS, so no mounted test can see which face paints (`scripts/e2e/scenarios/desktop-webview-rendering.md`).
- A new allowed case is added to this list in the same commit as the pin it justifies, and a surviving pin carries a one-line comment above it naming its contract.
- Four `node:fs` readers of source are known exceptions to this rule: `editor/widgets/table.test.ts` (Wysiwyg.svelte's stylesheet), `state/desktopBridgeLayout.test.ts` and `state/keyboardLayout.test.ts` (the desktop app's Rust and connect page sources) and `state/extensionRelayLayout.test.ts` (an example extension's page). They were outside the v0.101.0 conversion and are tracked as their own roadmap item.
- No assertion on comment text. A comment is documentation; rewording it to follow the writing rules must never turn the suite red.
- No absence assertion on an identifier that exists nowhere in the tree: a `not.toMatch` on a name nobody spells passes against an empty file and cannot fail for a real reason. A negative stays only where it guards a shape someone could plausibly re-add and no positive assertion can express it.
- Test files are named `<module>[.<concern>].test.ts` beside the module they test (`tabs.test.ts`, `shortcuts.windows.test.ts`), not after the incident, round or feature that prompted them. Re-homing a file is two commits, a rename with no content change and then the edit, so history follows the file.
- Shared fixtures live under the package's `src/__tests__/`. The workspace app's tree-wide scanners skip that directory and vitest runs only `*.test.ts`, so a fixture there is never read as production source or run as a test.
