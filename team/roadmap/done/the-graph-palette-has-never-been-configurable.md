# The graph palette has never been configurable, and a dead legend implies it was

Closed: shipped in [v0.89.0](../../release/release-v0.89.0.md).


Status: REGISTERED 2026-08-11 as v0.89.0 scope, carried forward from a draft the owner raised on 2026-08-11 after going looking for the graph colour setting he remembered and finding none. The owner accepted it at "~10-12h, SPA + Rust + CLI keys" and scoped it across three surfaces. Every claim below is verified against `f9c2878c`. Two sibling drafts that touch the same CSS are named and dispositioned in the boundary section; neither is being promoted and neither is absorbed here.

## What

There is no setting for the graph's node colours and there never has been. What existed, and what each commit did, read at `f9c2878c`:

```
commit    date        what it did
--------  ----------  --------------------------------------------------
362aa960  2026-05-22  added a READ-ONLY swatch legend, HybridGraphConfig
4cee61b9  2026-07-06  dropped surface="graph" from that legend's shell,
                      removing the ThemeToggleButton it rendered
0d59d01f  2026-07-06  replaced the config-back pane model with A/B tab
                      flip, deleting the legend's only render site
```

The two 2026-07-06 commits are four hours and eighteen minutes apart (`4cee61b9` at 00:00:04 +0100, `0d59d01f` at 04:18:17 +0100), which is why the release notes describe a state that never shipped. `CHANGELOG.md:993` still reads "Graph keeps its read-only colour legend" inside the entry titled "Back-of-pane configuration duplicates are removed".

`HybridGraphConfig.svelte` has been unreachable since that morning. **Its only remaining reference in the tree is its own test, and that test imports it as text:** `import source from "./HybridGraphConfig.svelte?raw"` (`components/HybridGraphConfig.test.ts:2`). The component never mounts, so fifteen assertions across three `describe` blocks pass against a string. The legend renders nine rows in three groups (`components/HybridGraphConfig.svelte:30`, the `groups` array) and every row is a label, a description and a `<span class="legend-swatch" style="background: var({row.cssVar})">` (`:112-116`). There is no input anywhere in the file.

**The control that survives is three-state.** The two-state control was the `ThemeToggleButton` that `4cee61b9` removed. What is in Settings today is a `PillRadio` over Inherit / Light / Dark (`components/settings/AppearanceSection.svelte:68-72`, `SURFACE_THEME_OPTIONS`) driven by the row `{ kind: "graph", label: "Graph body theme" }` (`:77`), which writes `editor.hybrid_surface_themes.graph`. It pins which of the two hand-tuned palettes the graph uses. It cannot change a hue.

## Where the colours actually live

Every graph colour is a CSS custom property read at runtime from the canvas host's own computed style by `readTheme(host)` (`components/GraphCanvas.svelte:453`), whose fourteen slots each carry a literal fallback as the second argument to the local `v()` helper (`:461-473`). Those same literals are written out a second time in the same file as the `$state` seed for `theme` (`:479-484`).

**There are six declarations of these hexes.** The dark set is written four times and the light set twice:

```
where                                   which set  lines
--------------------------------------  ---------  ---------
App.svelte :root                        dark       1676-1691
App.svelte [data-theme="light"]         light      1763-1772
GraphTuner.svelte :global(:root)        dark         384-391
GraphTuner.svelte light override        light        403-410
GraphCanvas.svelte readTheme fallbacks  dark         461-473
GraphCanvas.svelte theme $state seed    dark         479-484
```

**`--g-language` is not a bare hex in `App.svelte`.** It aliases `--chan-color-language`, declared one line above it in each block (`App.svelte:1679` then `:1681` dark, `:1766` then `:1768` light), and `--chan-color-code` aliases the same token. `web/packages/workspace-app/src/design.md:100` states that indirection as the contract. `GraphTuner.svelte` declares `--g-language` as a bare hex instead (`:387`, `:406`), so the playground and the app disagree in form even where they agree in value. Any single-definition module this item builds has to preserve the alias rather than flatten it, or `--chan-color-code` silently detaches from the language hue.

`readTheme` is called with `containerEl`, not `document.documentElement` (`GraphCanvas.svelte:494`), and a `MutationObserver` already re-reads on a `data-theme` flip at both the document root and the nearest `.graph-tab` ancestor (`:1741-1750`, with the `closest(".graph-tab")` lookup at `:1745`). **The renderer has always been built to take its palette from its own subtree. Nothing has ever supplied one.**

## The palette is not graph-private, so the override cannot go on the root

The `--g-*` tokens are the app's file-kind palette, and `web/packages/workspace-app/src/design.md:88` ("Canonical semantic palette") states the contract deliberately: one hue per concept across the graph, the file tree, the info panes and the editor pills. The consumers outside the graph, all read at `f9c2878c`:

```
consumer                             line  reads
-----------------------------------  ----  -------------------------
state/kinds.ts colorVarFor            141  doc/img/tag/binary/folder
state/kinds.ts colorVarForBucket      171  doc/source/img/binary
state/kinds.ts chipColorVar           206  dispatches the two above
components/FileTree.svelte           1644  --g-folder
components/FileInfoBody.svelte       1659  --g-doc
components/FileInfoBody.svelte       1660  --g-img
components/LanguageInfoBody.svelte    189  --g-language
editor/JsonNode.svelte                156  --g-doc
components/EmptyPaneCarousel.svelte   674  --g-doc
```

An override written to `:root` repaints all nine. An override written to the `.graph-tab` element (`components/GraphPanel.svelte:2633`, which already carries `data-theme={tab ? surfaceThemeOverride("graph") : undefined}` at `:2635`) repaints only the graph, and works today with no renderer change, because the canvas already reads from inside that subtree. A section named Graph must do the second.

One consumer escapes the subtree and this is the part that will be missed. The tab menu bubble carries `use:portal` (`components/GraphPanel.svelte:2663`), and `portal` is three lines that call `document.body.appendChild(node)` (`components/portal.ts:1`). That menu holds the filter dots, whose swatch is `style="background:{show[kind] ? FILTER_COLORS[kind] : 'transparent'};border-color:{FILTER_COLORS[kind]}"` (`:2775`), fed by `FILTER_COLORS` (`:1859`), whose entries are `var(--g-img)`, `var(--g-folder)`, `var(--g-doc)`, `var(--g-source)` and three `EDGE_COLORS` references (`:1860-1871`). Once the bubble is on `document.body` it inherits nothing from `.graph-tab`. **Without a second application site the dots keep the theme colours while the canvas shows the custom ones, and the two surfaces the user compares side by side are the two that disagree.**

## The pattern this item follows already exists end to end

**The Rust and CLI half is not work to be invented.** A validated colour preference on the Editor owner already ships, for the terminal, and every piece the graph palette needs is in place:

```
leg                    where                                       line
---------------------  ------------------------------------------  ----
preference struct      chan-server/src/preferences.rs               203
  on the Editor owner  chan-server/src/preferences.rs EditorPrefs    64
PATCH validation       chan-server/src/routes/preferences.rs        494
  hex normaliser       chan-server/src/routes/preferences.rs        509
CLI value kind         chan/src/lib.rs ConfigValueKind::Color       7111
  parse arm            chan/src/lib.rs                             7845
  hex normaliser       chan/src/lib.rs normalize_config_color       7856
CLI key rows           chan/src/lib.rs CONFIG_KEYS                  7136
absent-subtree sample  chan/src/lib.rs config_schema_sample         7675
SPA read + reject      state/paneColor.ts resolveTerminalColors       99
SPA consumer           components/TerminalTab.svelte                 325
docs row               docs/config-reference.md                      112
```

That is `editor.terminal_colors.custom.background`, shipped by [terminal-editor-appearance-settings](../done/terminal-editor-appearance-settings.md) in v0.84.0 and brought under CLI key coverage by [chan-config-key-coverage](../done/chan-config-key-coverage.md) in v0.85.0. The graph palette is the same shape with more rows. `ConfigValueKind::Color` (`crates/chan/src/lib.rs:7111`) already exists and already accepts `#rgb` or `#rrggbb` and persists lowercase `#rrggbb` (`normalize_config_color`, `:7856`). Nothing about the type, the parser or the error message has to be designed.

The coverage machinery is real and it will fire. `validate_config_dump` (`crates/chan/src/lib.rs:7869`) walks every serialized leaf and fails any that `config_key_spec` (`:7644`) does not own, and it is called on the live no-key dump path (`:7444`), not only from a test. So a serialized palette field with no `CONFIG_KEYS` row does not merely fail the suite: **it breaks `chan config get` for every user.** Two tests pin it: `config_serialized_leafs_have_get_set_coverage` (`:10957`) and `config_schema_audit_rejects_an_unowned_serialized_leaf` (`:11010`), both driven by the `populated_config_for_coverage` fixture (`:10923`). That fixture is load-bearing for anything optional: it explicitly populates `terminal_colors.custom` and all five `hybrid_surface_themes` (`:10934-10949`) precisely because a `skip_serializing_if` field that is `None` never reaches the dump and therefore never reaches the check.

**The precedent does not validate on every path a colour can take to the field.** `sanitize_terminal_colors` runs only on the PATCH merge (`crates/chan-server/src/routes/preferences.rs:223`); `EditorPrefs::load_from` is a bare `crate::store::load_toml` with no sanitising pass (`crates/chan-server/src/preferences.rs:347`). A hand-edited `preferences.toml` containing `background = "chartreuse"` deserializes into a `String` and is served to the SPA unchanged. What saves the terminal is the client: `resolveTerminalColors` returns `null` if any of the three fails `normalizeHexColor` (`state/paneColor.ts:106`, normaliser at `:48`), so the whole custom payload is dropped and the standard palette shows. **The graph has no equivalent today and the failure mode is worse there:** a raw garbage string handed to `ctx.fillStyle` is silently ignored by the canvas and the previous colour persists, so the user sees a stale hue rather than a default one. Either the item adds the load-path sanitise the terminal never got, or it copies the terminal's client-side reject. It must not assume the first is already true.

## Light versus dark is the part that cannot be automated

The theme carries two hand-tuned palettes and the light values are not a mechanical function of the dark ones. `--g-doc` goes `#ff8a3d` to `#c25a1f` (`App.svelte:1676`, `:1763`), a hue and a saturation shift; `--g-language` goes `#ff4db8` to `#c71585` (`:1679`, `:1766`). A single stored hex is therefore wrong in one mode for every user who ever flips theme, and the failure is silent: pick colours at night, get glare in the morning. Deriving the counterpart algorithmically produces hues the user did not choose and cannot correct. Two stored sets keyed by mode is the only shape that does not silently lie to somebody, and it is why the key count doubles.

## Contract

- A user can set the graph's node colours from Settings, and the item names where that control lives rather than assuming a section that does not exist.
- Changing a graph colour changes the graph and nothing outside it. The file tree, the kind chips, the inspector refs, the JSON tree and the empty-pane carousel keep the theme palette.
- The canvas, the filter dots and the legend content agree on every colour at all times, including while the filter menu is portaled to `document.body`.
- A custom palette survives a theme flip in both directions, and a Graph body theme pin opposite the app theme, without a wrong-mode colour and without a migration prompt.
- The default hexes have one definition that every remaining copy is checked against, and the `--chan-color-language` alias survives that consolidation rather than being flattened into a hex.
- A malformed colour never reaches a paint call. Whether that is enforced on load, on read, or both, is the implementer's call, but the current terminal precedent enforces it in only two of its three entry points and this item states which it adopts.
- The reader, the writer and the dump derive from one key set, so a serialized palette field cannot reach `chan config get` without reaching `get <key>` and `set <key>`. Inherited verbatim from [chan-config-key-coverage](../done/chan-config-key-coverage.md).

## Boundary

Three surfaces, so the line is drawn per surface.

**In scope.** The seven node-kind tokens `--g-doc`, `--g-source`, `--g-binary`, `--g-img`, `--g-folder`, `--g-tag` and `--g-language`, in both modes; the two application sites (`.graph-tab` at `components/GraphPanel.svelte:2633` and the portaled menu at `:2663`); one palette module the six declarations above collapse onto; the `EditorPrefs` field, its `CONFIG_KEYS` rows, its `config_schema_sample` entry and its `populated_config_for_coverage` entry; one row block in `docs/config-reference.md`'s `EditorPrefs` table (`:107-115`); and the deletion of `components/HybridGraphConfig.svelte`.

**The contact token is a decision, not a free step.** Introducing `--g-contact` as `var(--warn-text)` changes no pixel on its own, and `web/packages/workspace-app/src/design.md:98` has already ruled on it: "There is no dedicated `--g-contact` token; the graph reads `--warn-text` directly for contact and mention nodes. Add one only if the graph ever needs to diverge from the warning hue." Making it settable is that divergence, so the doc must change with the code. The sharper cost is that contact and mention are one concept here: `readTheme` has a single `mention` slot reading `--warn-text` (`components/GraphCanvas.svelte:464`), the fill dispatch sends both kinds to it (`:1240-1241`), the legend lists them in different groups on the same token (`components/HybridGraphConfig.svelte:56` and `:81`), and `web/packages/workspace-app/src/design.md:143` says a mention shares the contact palette by design. Splitting contact off leaves mention on `--warn-text` and breaks that. Either both move or neither does, and the item says which.

**Ruled 2026-08-11: both move.** `--g-contact` is added as an eighth settable hue covering contact and mention together, per theme mode, taking the palette to eight hues and seventeen CLI keys. Its introduction is zero-pixel, as `--g-contact: var(--warn-text)` in both blocks, and `web/packages/workspace-app/src/design.md:98` is rewritten to say the graph reads `--g-contact` for contact and mention nodes, defaulting to `var(--warn-text)` and settable as part of the graph palette. `:143` stands unchanged, because a mention still shares the contact palette; only the palette's name changes.

The reasoning that decided it is the one already in `design.md:98`, which licenses the token "only if the graph ever needs to diverge from the warning hue". A user-settable palette is that divergence, with the user rather than the theme needing it. The alternative was rejected on a concrete prediction: contact and mention are one of the legend rows a user compares against the canvas, so a palette that moves six hues and pins the seventh to warn-yellow reads as a defect rather than as a boundary.

This ruling widens the in-scope token set below from seven to eight, and it carries one obligation the seven-token version did not have. Routing `EDGE_COLORS.mention` and the `state/kinds.ts` contact and mention mappings through `var(--g-contact, var(--warn-text))` places a settable token in code paths that also feed the file tree and the inspector chips. That is safe only because the override is applied on the graph subtree and the portaled bubble, so the token resolves to its default everywhere else, and the acceptance below is extended to check it rather than to argue it.

**Deliberately out, with the reason each is not a tidy exclusion.**

- `--bg`, `--bg-card`, `--text` and `--text-secondary`. See the sibling disposition below. Not settable here.
- `--accent` and `--text-secondary` as node fills. They are not only chrome: the index-state override at `components/GraphCanvas.svelte:1227-1233` fills an `indexed` node with `theme.accent` and a `pending` node with `theme.textSec`, and takes precedence over the kind fill. So during an index pass some nodes ignore the user's palette entirely, and one of the three index states (`indexing`) borrows `theme.doc` (`:1230`), which means setting the markdown hue also recolours the indexing pulse. That is a real interaction and the item names it rather than discovering it in acceptance.
- `--fb-drafts-fg`. The Drafts root is a directory node whose fill is chosen before the kind dispatch (`:1237`), so one directory in every workspace ignores the folder colour the user picked. Leaving this out is defensible, but it is a visible hole in "the graph's node colours are settable" and it belongs in the item rather than in a bug report later.
- The `tag` fallback. `theme.tag` is the final `else` of the fill dispatch (`:1247`), so any node kind not listed paints in the tag hue. Setting the tag colour therefore also moves every unclassified node.
- Any app-wide application of the palette. Out by construction, because the override lands on the graph subtree.

**Where the setting lives is this item's problem, not another item's.** `SettingsOverlay.svelte:195-202` lists six sections: appearance, editor, terminal, files, shortcuts, workspace. **There is no Graph section.** Placing the setting under a Graph section is therefore not possible today without either creating that section or landing the control in Appearance beside the existing colour block. [settings-is-organised-by-concern-not-by-app](settings-is-organised-by-concern-not-by-app.md) is registered for the same version and its acceptance creates a Graph section, but it is a Large item whose real cost is extracting six shared field primitives, and **this item must be shippable whether or not that one lands.** The cheapest honest answer is therefore Appearance, next to the terminal colour control at `components/settings/AppearanceSection.svelte:322-361`, which already ships the exact UI shape needed: a swatch input, a hex text field, a per-field error, and a reset button. If the reorganisation lands first, the control moves into the Graph section with no change to the preference, the CLI keys or the appliers, because none of them knows which section renders it.

## The two sibling drafts, by name

Both edit the same `App.svelte` palette blocks, so the relationship has to be explicit. **Neither is a strict subset of this item and neither is absorbed by it.** Both stay drafts.

`the-graph-background-and-text-colours-are-not-configurable.md` covers a disjoint token set (`--bg`, `--bg-card`, `--text`, `--text-secondary`) and is not merely more of the same work. Its own reasoning verifies: the node stroke ring reads the page background by design (`components/GraphCanvas.svelte:214-216`), the label halo strokes in `theme.bg` (`:1318`), the icons are knocked out in `bg` (`rebuildIcons`, `:384-422`), and the selected and hover rings read `theme.text` (`:1282-1283`). Changing those needs a luminance resolver of the kind `relativeLuminance` provides for the terminal (`state/paneColor.ts:87`), which this item does not need at all. Doing this one first makes that one materially cheaper: the preference shape, the two application sites, the Settings home and the CLI rows are all reusable, and its own draft already says to sequence it second. It also conflicts: it edits `readTheme` and the same two `App.svelte` blocks, so the two must not run concurrently.

`the-pill-palette-duplicates-the-concept-token-hexes.md` covers a disjoint token set (`--pill-*`) and is **not** a prerequisite for this item. Its claim to block a feature is about app-wide concept theming, which nobody has proposed; because this item scopes its override to the graph subtree, the pills cannot desynchronise from it. Its claim that the same relationship exists in both blocks is half true: in dark mode every `--pill-*-fg` is `var(--text)` (`App.svelte:1707-1719`), so only the backgrounds copy a hue there; the copied foregrounds are light-mode only (`:1781-1793`). Its two specific citations are correct at HEAD (`--pill-wiki-bg` at `:1708`, `--pill-wiki-fg: #c25a1f` at `:1781`). This item makes it slightly cheaper by producing the single palette definition its derivation would want as a source, and it conflicts in the same way: same file, same two blocks, and both are pinned by the `App.svelte` hex regexes in `components/HybridGraphConfig.test.ts:81-96`.

## Sequencing against the live branch

Run at `f9c2878c`: `git diff --stat main...origin/feat/linux-terminal-grid` reports 23 files, 1001 insertions, 66 deletions. Two of them are config surfaces.

**`crates/chan-library/src/config.rs` is not a collision, because this item does not touch it.** The branch changes `TerminalConfig::ghostty` (declared `:91`, struct at `:36`) from `#[serde(default)]` to a platform-keyed `#[serde(default = "default_terminal_ghostty")]` and adds three tests. That file holds `server.*` keys. A graph palette is an editor preference, so it lands on `EditorPrefs` in `crates/chan-server/src/preferences.rs:58`, which the branch does not touch, and its CLI rows land in `CONFIG_KEYS` in `crates/chan/src/lib.rs:7122`, which the branch does not touch either. The premise that new config keys go through `chan-library/src/config.rs` holds only for the server namespace.

**`docs/config-reference.md` is a shared file but not a conflicting hunk.** The branch rewrites one row, `terminal.ghostty` at `:30`, inside the `ServerConfig` table. This item appends rows to the `EditorPrefs` table at `:107-115`, seventy-seven lines below. Git merges those independently; whichever lands second rebases without a textual conflict.

Sequencing: no dependency in either direction, land in either order. The one thing to avoid is doing this work on that branch. The branch's Rust change is a default-value flip whose tests are `cfg!(target_os)`-conditional across three platforms; this item's Rust change adds seventeen key rows behind a dump validator that breaks a user-facing command when it is wrong. Mixing them makes a red gate ambiguous about which change caused it.

## Acceptance

- The eight node-kind hues are settable per mode and repaint the canvas live, with `web/packages/workspace-app/src/design.md:98` updated to match the 2026-08-11 ruling that contact and mention both move onto `--g-contact`.
- **A custom hue does not escape the graph subtree.** With a custom contact hue set, the file tree, the kind chips, the inspector refs, the JSON tree and the empty-pane carousel are unchanged. This is the check on the obligation the contact ruling introduces, and it is the observable form of the contract line that changing a graph colour changes the graph and nothing outside it.
- Setting a hue and then exercising all four combinations of app theme and Graph body theme pin paints the correct palette in every one. Checked by eye on a real graph, because no test observes canvas pixels and none is being written that does.
- The filter dots match the canvas after an override. This is the check that catches the portaled menu at `components/GraphPanel.svelte:2663` being missed, and it fails today for any implementation that applies the override only to `.graph-tab`.
- `chan config set editor.graph_colors.dark.doc '#ff0000'` is accepted from a default config where the palette subtree does not yet exist, which requires the new field in `config_schema_sample` (`crates/chan/src/lib.rs:7675`) and not only in `CONFIG_KEYS`. A malformed hex is refused with the message `normalize_config_color` (`:7856`) already produces.
- The reader, writer and dump still derive from one key set, proven the way [chan-config-key-coverage](../done/chan-config-key-coverage.md) requires: `config_serialized_leafs_have_get_set_coverage` (`:10957`) passes with the new palette **populated** in `populated_config_for_coverage` (`:10923`), and is demonstrated able to go red by removing one palette row from `CONFIG_KEYS` and watching it fail. If the field is optional, an unpopulated fixture makes this check vacuous, which is exactly the trap the terminal and surface-theme entries in that fixture exist to avoid.
- `chan config get` with no key still succeeds against a config carrying a custom palette, because `validate_config_dump` runs on that path (`:7444`) and a missing key row breaks the command rather than only the suite.
- A colour that fails hex validation cannot reach `ctx.fillStyle`. Demonstrated by hand-editing `preferences.toml` to a non-hex value and observing the default palette rather than a stale one, which is the case the terminal precedent covers on the client (`state/paneColor.ts:106`) and does not cover on load (`crates/chan-server/src/preferences.rs:347`).
- A running window repaints without a reload after `chan config set`, via the existing `preferences.toml` watcher and its `config_changed` broadcast (`crates/chan-server/src/config_watch.rs:29` and `:106`). Assert the propagation, not a reload.
- Dragging a colour picker does not re-rasterise the icon set per pointer move. `refreshTheme` calls `rebuildIcons` unconditionally (`components/GraphCanvas.svelte:498`), and `rebuildIcons` (`:384`) issues exactly twenty `loadIcon` calls (`:391-422`), each constructing a `new Image()` from an SVG data URL and awaiting `img.decode()` (`loadIcon`, `:371`; `svgStrokeIcon`, `:353`). **Every one of those twenty is a function of `bg` and `ghostStroke` only, so a hue-only change rebuilds twenty byte-identical images.** The existing terminal colour control commits on `oninput` (`components/settings/AppearanceSection.svelte:331`), so this fires on every pointer move unless the rebuild is made conditional on the two inputs it actually depends on.
- The default hexes have one definition and the surviving copies are asserted equal to it, so a retune cannot land in one place only. The three regex-based assertions that currently pin `App.svelte`'s hexes by hand (`components/HybridGraphConfig.test.ts:81-96`) are replaced by that check rather than left beside it.
- `components/HybridGraphConfig.svelte` is deleted, its legend's grouping and descriptions survive as the layout of the new control rather than being retyped, and the assertions in `components/HybridGraphConfig.test.ts` that pin `GraphCanvas.svelte`, `state/kinds.ts` and `App.svelte` rather than the legend are rehomed rather than deleted with it. That file is not a single-component test and deleting it wholesale drops coverage of the file-bucket colour scheme.
- `docs/config-reference.md`'s `EditorPrefs` table carries a row per new key, because `:105` states that every scalar leaf below it is reachable through `chan config get/set` and that sentence must stay true.

## Rough size

Medium. The owner's ten to twelve hours is plausible for a working path, and it is his estimate rather than a measurement. Inside it, the bulk is the SPA half, not the Rust and CLI plumbing.

The Rust and CLI plumbing is mechanical and not optional, but it is not the bulk, because none of it is new: the value kind, the parser, the error text, the schema sample, the coverage fixture and the two coverage tests all exist and are exercised by `editor.terminal_colors.custom.*` today. What is left is one struct, seventeen `CONFIG_KEYS` rows on a table that already carries forty-three (`crates/chan/src/lib.rs:7122-7297`), two fixture edits and a documentation table block. The seventeen is arithmetic on one shape choice, eight hues times two modes plus a mode key, not a count of anything that exists; a different shape moves it.

The SPA half is where the time goes, for four reasons. Two application sites rather than one, because of the portal. Six declarations of the palette to collapse into one without flattening the `--chan-color-language` alias, three of which are pinned by regex tests that have to be rewritten in the same change. A Settings home that does not exist yet, which is a placement decision this item has to make rather than inherit. And an acceptance that is visual in four theme combinations and cannot be discharged by the suite, on a canvas no test observes.

The specific overrun risk is the single-definition refactor. It reaches `App.svelte`, `GraphCanvas.svelte`, `GraphTuner.svelte` and three test files, and it is the part most likely to be deferred under time pressure, which would leave the item shipping a settable palette on top of six unsynchronised default declarations. If that is going to be cut, cut it explicitly and record it, rather than discovering it at the retune.
