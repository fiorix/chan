# Letter shortcuts follow key positions instead of the keyboard layout

Status: shipped in [v0.100.0](../../release/release-v0.100.0.md): Letter and punctuation shortcuts follow the active keyboard layout on every surface, and the extension keyboard relay moved to v2 across chan, mobile-chat and Doom; the macOS Colemak, Dvorak and Option checks are pending for the contributor.

## Goal: preserve Laurie's value

Laurie's fix is the acceptance criterion: on Colemak, Cmd+T must open a terminal rather than dispatch Find because the key's physical code is KeyF. Letter shortcuts must follow the active layout across the workspace, launcher, desktop bridge, terminal escape matching, and shortcut overrides.

Keep Laurie's layout-aware letter matching, Option-generated glyph/dead-key fallback, help-generator fix, and behavioral regression coverage. Fix inconsistencies by extending that behavior to the remaining paths, never by reverting letters to physical positions. Punctuation, Shift handling, and extension updates are our additions to Laurie's work, not reasons to replace its purpose.

## Reviewed source and findings

Source: [lclarkmichalek/chan, fix/layout-aware-shortcuts](https://github.com/lclarkmichalek/chan/tree/fix/layout-aware-shortcuts).

- `61e5f09d8dd1935571c79da9872779090ce77c93`: Respect keyboard layouts for letter shortcuts. Adds the shared letter helper and updates workspace handlers, launcher, desktop bridge, terminal escape matching, and tests.
- `43e1bfed353c33f24519d2dbe6988a807500825e`: Compile the shared helper when generating shortcut help. Compiles the helper alongside the registry and invokes TypeScript with an argument array instead of shell parsing.

The reviewed diff is 16 files, +127/-40, with no new dependencies. A trial merge against upstream `52251eac02ff0be99204c4b873477ba7ce89fe54` had no conflicts. This is historical evidence, not a claim about the tree after the frontend review. That base is now 516 commits behind `main`, and neither reviewed commit is present in this checkout: no remote for the fork is configured, so the import begins by fetching one.

Two regression classes were established with synthetic keyboard events:

1. Letter resolution takes precedence over punctuation-key positions, while some dispatchers still treat punctuation physically. On Dvorak, terminal escape matching disagrees with the Settings and Hybrid Nav handlers, and the native bridge loses the physical Slash split command.
2. Extension iframes still advertise and validate physical codes. On Colemak, logical T is rejected by the relay while the formerly accepted physical T no longer dispatches New terminal.

At review time, 236 targeted tests, both affected SPA type checks and production builds, and shortcut-help verification passed. Four additional probes passed against main and failed with the branch. Those probes demonstrate the inconsistencies; their physical-punctuation expectations must be replaced with the agreed logical-symbol behavior below. They are not a specification to restore physical punctuation matching.

## Relationship to the frontend review

- Finish the frontend-review work first. Re-read the resulting keyboard ownership, propagation, override, and extension code before importing this change. Reuse the owners and helpers established there instead of restoring old structure from Laurie's patch.
- Reconcile recommendations that assume physical letter matching. In particular, DESKTOP-05 recommends moving the connecting window's close handlers to `e.code` and updating three substring assertions in `serve.rs` in the same commit, and the Ctrl+D consistency recommendation prefers App.svelte's physical `KeyD` predicate over TerminalTab's `e.key` one. Their propagation, ownership, and modifier corrections still matter, including TerminalTab's missing Shift exclusion; their physical-letter choice must yield to this plan's layout-aware policy. Both touch `desktop/src-tauri/src/serve.rs`, whose `KEY_BRIDGE_JS` is a Rust string literal pinned by unit assertions, so a JavaScript-only edit there turns pre-push red.
- The frontend-review work this import waits for is now accepted scope in this same version: [terminal-chords-run-twice-or-not-at-all](terminal-chords-run-twice-or-not-at-all.md), [full-window-covers-do-not-block-input](full-window-covers-do-not-block-input.md) and [escape-closes-the-overlay-under-an-open-menu](escape-closes-the-overlay-under-an-open-menu.md). The import starts after all three have landed, and moves to the next version rather than holding this release if they land late.
- Preserve frontend-review fixes for duplicate dispatch, terminal escape, modal blocking, command availability, and modifier exclusions when applying this import.
- Require Laurie's Colemak behavior to remain green throughout integration. Neither a conflict resolution nor a source-pattern test may silently restore physical letter matching.

## Agreed design and scope

- Letters and punctuation follow the active layout's symbols.
- First target: Latin layouts, including Colemak, Dvorak, AZERTY, and QWERTZ. Non-Latin layout discovery is deferred.
- Shift needed to produce punctuation may be consumed by matching. An explicitly shifted binding takes priority when both could match.
- Retain physical top-row digit shortcuts, numpad zoom behavior, and the existing Option-glyph/dead-key fallback where no supported logical symbol is available.
- Include Chan, its extension example, mobile-chat, and Doom, including Doom's nested game-frame relay.
- Add no new configuration, dependencies, or terminal encoding changes.

Compared with Laurie's branch, the additions are logical punctuation, Shift-aware matching and conflict detection, the extension keyboard contract and consumer updates, and broader behavioral validation. His letter behavior and help-generator correction remain the foundation.

## Integration and implementation

### Import and history

- Create an isolated integration branch from refreshed upstream main after the frontend-review changes land.
- Import the two reviewed commits ending at `43e1bfed`, preserving their history and authorship. Add corrections as separate commits. Do not silently substitute a newer fork revision without reviewing its additional changes.
- Prepare separate branches for affected extension consumers. Keep unrelated work out of each branch.

### Surfaces at `d3de0180b`

The fork's diff was 16 files; the work here is enumerated against the current tree, where nothing matches letters by layout (`canonicalKey` in `state/shortcuts.ts` and the `e.code !== "KeyD"` predicate in `App.svelte` are both physical):

- `web/packages/workspace-app/src/state/shortcuts.ts` (`canonicalKey`, `chordFromEvent`, `shouldEscapeTerminal`, `canonicalChordTokens`). There is no separate keyboard helper file today; this module is where one is extracted from.
- `state/keymapAssign.ts` (shortcut capture), `state/keymapOverrides.svelte.ts` (override resolution and conflict detection), `state/extensionBridge.ts` (the v1 keyboard contract).
- `App.svelte` (the global handlers and the Ctrl+D capture), `components/Pane.svelte` (`e.code === "KeyT"`), `components/TerminalTab.svelte` (terminal escape dispatch and `isCloseExitedTabKey`).
- `web/packages/launcher/src/components/CommandLauncher.svelte` (the launcher's `KeyK` matching).
- `desktop/src-tauri/src/serve.rs` (`KEY_BRIDGE_JS`, a Rust string literal with substring assertions pinning its spellings) and `desktop/src/connecting.js` (the second injected bridge).
- `web/packages/workspace-app/scripts/shortcuts-table.mjs`, `scripts/check-shortcuts-help.py`, and `KEYBINDINGS_TABLE` in `crates/chan/src/lib.rs` with its guard test, which `make shortcuts-check` diffs.
- `crates/chan-server/examples/echo-extension.rs` (the in-tree extension fixture on the v1 contract), `docs/extensions.md` and `docs/config-reference.md`, whose relay description says "match only the supplied physical-key descriptors".

### Keyboard matching

- Extend the shared keyboard helper beyond letters into one normalization and matching contract used by workspace handlers, launcher, terminal escape matching, shortcut capture, and overrides.
- Resolve letters case-insensitively and punctuation through `event.key`. A letter on a punctuation-key position must never trigger that position's former punctuation command.
- Preserve named keys, physical top-row digits, numpad zoom behavior, and existing shifted-punctuation aliases such as `?` / `Shift+/`.
- Match the exact normalized chord first. If nothing claims it, permit a second candidate that consumes Shift used to produce a punctuation symbol. Keep Ctrl, Cmd, and Alt strict. Preserve explicit shifted aliases so `?` continues to select split-down rather than split-right.
- Preserve override precedence within each candidate. Terminal escape and dispatch must select the same winning chord and invoke a command at most once.
- Keep shortcut capture explicit about held modifiers. Use the same matching rules for conflict detection, including overlaps with the punctuation fallback.
- Apply the contract to both injected desktop bridges. Preserve direct IPC actions and platform ownership rules. Test their small JavaScript implementations against the same event vectors as the TypeScript helper.
- Preserve Option-generated glyph/dead-key fallback where no supported logical symbol is available. Reject composing events and AltGr character entry consistently. Chords requiring AltGr may need rebinding in this first version.
- Update shortcut documentation and help generation for the final helper structure. Keep Laurie's argument-array invocation and correct compilation of the helper dependency.

### Extension keyboard contract

- Replace the physical-only keyboard contract with `chan:extension-host-keymap:v2` and `chan:extension-keydown:v2`. Other extension message contracts remain unchanged.
- Advertise normalized key identities with modifier booleans. Digit identities retain physical top-row semantics; letters and punctuation use the logical matching contract.
- Relay raw `key`, `code`, modifiers, repeat, composition, and AltGraph state. Chan normalizes and validates the event against advertised bindings before dispatching it.
- Preserve frame-source checks, empty-allowlist rejection, and bounded message validation. Do not trust a consumer-supplied normalized identity or command ID.
- Update Chan's example and extension documentation, mobile-chat's relay, and Doom's outer host bridge and nested game-frame relay. Preserve Doom's source/nonce checks and ordinary game input.
- Remove v1 keyboard handling rather than maintaining parallel contracts. Treat the three repositories as one coordinated rollout.

## Validation and acceptance

- Preserve Laurie's behavioral tests for logical letters, Caps Lock, terminal escape, and native dispatch. Colemak Cmd+T must open a terminal, and physical KeyT producing G must not open one.
- Convert the temporary findings into permanent behavioral tests for the agreed policy: Dvorak comma opens Settings, period enters Hybrid Nav, slash splits, and former physical positions do not trigger those commands.
- Cover Colemak terminal creation from ordinary focus, both terminal backends, extension focus, and Doom's nested frame.
- Test letter/punctuation exchanges, shifted punctuation, exact-binding precedence, overrides, Option fallback, AltGr, composition, digits, zoom, and unchanged Ctrl+D terminal EOF behavior.
- Exercise actual injected scripts and extension relays with shared event vectors. Include rejected messages, unadvertised chords, stale Doom frames, and single-dispatch assertions. Use runtime behavior as the evidence rather than source-text resemblance.
- Run Chan's frontend checks, shortcut-help check, desktop checks, and full pre-push gate against the final committed integration state. Run each extension's repository gate and focused relay tests.
- Rebuild embedded assets and smoke the combined builds in a browser and native desktop. Obtain macOS smoke results for Colemak/Dvorak and Option behavior; record unavailable platform checks as pending.

Completion requires all automated checks green, Laurie's original user-visible fix preserved, both reported regression classes resolved under the selected symbol policy, and successful extension round trips using rebuilt consumers.

## Delivery

Deliver tested local branches and a review summary separating the imported contribution from our additions. Include the tested commit IDs, gate results, native smoke evidence, and any pending platform checks. Pushing, merging into main, and releasing remain separate actions. Coordinate deployment of Chan and both extension consumers because the keyboard relay contract changes together.
