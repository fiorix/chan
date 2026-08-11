# Settings is organised by concern, not by the app being configured

Status: REGISTERED 2026-08-11 as v0.89.0 scope, from a draft the owner proposed the same day after reviewing the overlay against how the app is actually used, and sized by the owner as large, seven steps, two of them parallelisable. Verification against `f9c2878c` before promotion corrected the draft on six counts, each recorded in place below, the sharpest being that the rail it proposes has no home for one of the five surfaces the code already knows about. Three findings are added that the draft did not carry: the test harness its central acceptance line leans on cannot observe the thing that line asserts, the mass of the work is not where the draft put it, and the owner's branch turns the draft's cheapest win into a control that does nothing under the platform default. The owner's live branch `origin/feat/linux-terminal-grid` edits one of the files this item rewrites; the ordering ruling for it, and for the graph-palette item promoted alongside this one, each have their own section below.

## The surface, counted

Every number here was counted at `f9c2878c` by opening the files. The overlay has six sections, declared as `ALL_SECTIONS` (`SettingsOverlay.svelte:195-202`), of which `This workspace` is filtered out when `workspace.info` is null (`sections`, `SettingsOverlay.svelte:204-206`). `rows` counts rendered controls, not preference keys.

```
section              body                            rows  write path
-------------------  ------------------------------  ----  -----------------
Appearance           AppearanceSection.svelte          15  commit -> PATCH
Editor               EditorSection.svelte               5  commit -> PATCH
Terminal             TerminalSection.svelte             8  commit -> PATCH
Files & search       FilesSearchSection.svelte          2  commit -> PATCH
Keyboard Shortcuts   KeymapSettings.svelte              1  override layer
This workspace       workspace/, six controls           6  own endpoints
```

Appearance's 15 is ten `SettingField` rows (`AppearanceSection.svelte:237`, `:254`, `:267`, `:280`, `:295` rendered five times from `SURFACE_ROWS` at `:73-79`, and `:311`) plus five more that appear only when custom terminal colours are on: three colour rows, an ANSI contrast row and a reset button (`:322-361`). The other three per-machine sections are eight, five and two literal `SettingField` instances.

The draft's grouping claim holds exactly. Appearance holds `theme`, `editor_theme`, `line_spacing`, `bubble_overlay_mode`, all five `hybrid_surface_themes` rows, and the whole `terminal_colors` block including mode, three colours, contrast and reset. Terminal holds the eight `terminal.*` rows. Editor holds `editor_font_size`, `date_format`, `strip_trailing_whitespace_on_save`, `page_width_ratio` and `empty_pane_carousel_cycling`.

So configuring the terminal means visiting Terminal for its font, its size and its scrollback, and Appearance for its background, foreground, cursor, ANSI contrast and body theme. Configuring the editor means visiting Editor for its font size and page width, and Appearance for its theme and line spacing. The Graph has no section: its only knob is one row inside Appearance, `hybrid_surface_themes.graph` (`SURFACE_ROWS`, `AppearanceSection.svelte:77`). The Dashboard is in the same position (`:78`).

## The command registry already groups by surface, and it has for longer than Settings has existed

Ten commands set a surface body theme, two per surface, and each is filed under that surface's own category:

```
surface     command ids                               file:line
----------  ----------------------------------------  ------------------
editor      app.editor.surfaceTheme.{light,dark}      editor.ts:57, :65
terminal    app.terminal.surfaceTheme.{light,dark}    terminal.ts:89, :97
browser     app.browser.surfaceTheme.{light,dark}     browser.ts:222, :230
graph       app.graph.surfaceTheme.{light,dark}       graph.ts:25, :33
dashboard   app.dashboard.surfaceTheme.{light,dark}   dashboard.ts:68, :76
```

All ten are under `web/packages/workspace-app/src/state/commands/`, and each carries `category` equal to its surface: `"Editor"`, `"Terminal"`, `"File Browser"`, `"Graph"`, `"Dashboard"` (`editor.ts:59`, `terminal.ts:91`, `browser.ts:400`, `graph.ts:27`, `dashboard.ts:70`). The launcher therefore already answers "who owns a surface's body theme" with "that surface". Settings answers "Appearance". Both read and write the same field, `hybrid_surface_themes`, through the same setters. Two views of one model, and one of them is wrong.

The draft cited `terminal.ts:94-102` and `graph.ts:30-38`; both ranges are shifted and neither contains a whole command object. The correct blocks are `terminal.ts:88-95` and `:96-103`, and `graph.ts:24-31` and `:32-39`. Corrected here rather than carried, because [item-citations-anchor-on-content-and-are-checked](item-citations-anchor-on-content-and-are-checked.md) is in this same version's scope.

The registry's category set is the natural definition of the rail, and it is a set that already exists and is already exercised by `surfaceCommands.test.ts`. Eleven categories are in use tree-wide: `Apps`, `Dashboard`, `Editor`, `File Browser`, `Global`, `Graph`, `Panes`, `Search`, `Tabs`, `Terminal`, `Workspace`.

## The rail the draft proposed has no home for the Dashboard

The draft's acceptance asked for a rail reading Global, Terminal, Editor, File browser, Graph, Keyboard Shortcuts, This workspace, and in the next line asked that "each of the five area sections holds its own body theme row". Those two sentences contradict each other: the rail names four area sections and the code has five surfaces. `HybridSurfaceKind` is `editor | terminal | browser | graph | dashboard` (`api/types.ts:109-114`), the dashboard row renders today (`SURFACE_ROWS`, `AppearanceSection.svelte:78`), the CLI reaches it (`docs/config-reference.md:132`), and two launcher commands set it (`dashboard.ts:68`, `:76`). A rail without a Dashboard section leaves one field with nowhere to go, which is the exact defect the item exists to remove.

The rail this item takes is therefore derived from the command registry's categories rather than typed out, and the categories deliberately excluded are named so the question is not reopened:

```
section              holds                          derived from
-------------------  -----------------------------  ---------------------
Global               theme, bubble_overlay_mode,     category "Global"
                     empty_pane_carousel_cycling
Editor               editor_theme, line_spacing,     category "Editor"
                     editor_font_size,
                     page_width_ratio, date_format,
                     strip_trailing_whitespace...,
                     hybrid_surface_themes.editor
Terminal             terminal.* (8 rows),            category "Terminal"
                     terminal_colors.* (5 rows),
                     hybrid_surface_themes.terminal
File browser         browser_side_panes.{left,       category "File Browser"
                     right}, hybrid_...browser
Graph                hybrid_surface_themes.graph     category "Graph"
Dashboard            hybrid_surface_themes.dashboard category "Dashboard"
Search               search_aggression               category "Search"
Keyboard Shortcuts   shortcuts                       not a category; meta
This workspace       six per-workspace controls      category "Workspace"
```

Excluded categories, with the reason: `Apps` and `Tabs` persist no preference; `Panes` persists only `pane_widths`, which is drag-owned and stays unsurfaced for the reason given below.

One placement is a judgement call this item does not pre-decide: `attachments_dir` is described as the folder for pasted and uploaded images (`FilesSearchSection.svelte:49-50`), and pasting happens in the editor while uploading happens in the file browser. Either destination satisfies the contract. What the item requires is that whichever is chosen is recorded in `docs/config-reference.md`, not left to the reader.

## What is already shared, what is forked, and what the fork has already cost

The draft said "nothing shared exists for a slider, a number input, a colour swatch, a chip list or a section heading". That is half right and the half that is wrong matters for sizing. `SettingField.svelte:64-82` already styles `select`, `input[type=text]`, `input[type=number]` and `input[type=range]` once, for any control a section nests inside it, through `:global` descendant rules. The per-machine band's *look* is already shared. What is not shared is behaviour, and what is not shared at all is the per-workspace band.

Five debounce timers are hand-rolled at five sites with three different delays, none of them cleared when the component is destroyed:

```
site                            symbol             delay
------------------------------  -----------------  ------
EditorSection.svelte:37-45      onWidthInput       200ms
TerminalSection.svelte:39-47    onScrollbackInput  200ms
TerminalSection.svelte:80-87    onTermInput        400ms
FilesSearchSection.svelte:22-31 onAttInput         400ms
ExcludedDirsControl.svelte:89   saveTimer          600ms
```

Three number-with-clamp commit handlers are hand-rolled: `commitFontSize` (`EditorSection.svelte:59-71`, clamping through `clampEditorFontSize` imported from `state/editorTheme`), `commitFontSize` (`TerminalSection.svelte:58-67`, clamping through a local `clampFontSize` at `:49-51`), and `commitTimeout` (`ScreenLockControl.svelte:66-92`, clamping inline against `SCREENSAVER_MIN_TIMEOUT_SECS` / `SCREENSAVER_MAX_TIMEOUT_SECS`). The colour-plus-hex control exists once, at `AppearanceSection.svelte:322-361`. The chip list exists twice, and the second copy says so in its own comment: `TerminalSection.svelte:228-229` reads "Read-only value chips, same vocabulary as the workspace settings' excluded-directories baseline list", above a `.chips` / `.chip` / `.chip-name` block (`:235-258`) that duplicates `ExcludedDirsControl.svelte:240-279`.

The draft said the six per-workspace controls "each re-declare their own `.hint`, `.pill` and `.grid` CSS". Counted, that is false as written and the true shape is more useful. `.hint` is declared in five of six (`ExcludedDirsControl.svelte:187`, `MetadataControl.svelte:180`, `ReportsControl.svelte:81`, `ScreenLockControl.svelte:306`, `SemanticControl.svelte:243`); `IndexControl` declares none. `.pill` is declared in two (`ReportsControl.svelte:103`, `SemanticControl.svelte:265`). `.grid` is declared in two (`IndexControl.svelte:112`, `SemanticControl.svelte:318`). The single sharpest statement is simpler than any of those: **not one of the six imports `SettingField`, `PillRadio` or `PillToggle`**. A grep for those three names over `settings/workspace/*.svelte` returns nothing.

The draft also called `ScreenLockControl.svelte:283-301` a hand-rolled checkbox pill. The line range is right and the description is not: that control is `<label class="screen-lock-switch">`, a third checkbox shape with its own vocabulary, not a third copy of the pill. The pill has exactly two copies, `SemanticControl.svelte:169-178` and `ReportsControl.svelte:57-66`.

**That duplication has already cost the project one round.** [settings-checked-checkbox-pill-border](../done/settings-checked-checkbox-pill-border.md), shipped in v0.85.0, had to remove one CSS declaration because the pill exists **four** times. All four still resolve and are byte-identical in the block that item touched: `PillToggle.svelte:50-52`, `ReportsControl.svelte:127-129`, `SemanticControl.svelte:289-291` and `PillRadio.svelte:67-69` each read `.pill.on { background: var(--hover-bg); }`. (Corrected 2026-08-11: this said three, and omitted `PillRadio`, which the closed item itself names at its `:23` as "the fourth and last site".) The two copies have since drifted again in the other direction: both carry a `:has(input:disabled)` rule (`ReportsControl.svelte:130-133`, `SemanticControl.svelte:292-295`) that `PillToggle` does not have, because `PillToggle`'s props are only `checked`, `label` and `ontoggle` (`PillToggle.svelte:5-13`). So consolidating is not a delete: `PillToggle` has to grow a `disabled` prop first.

## A control offers bounds the server does not accept

`TerminalSection.svelte:24-31` declares `SCROLLBACK_MIN = 10`, `SCROLLBACK_MAX = 500`, `SCROLLBACK_STEP = 10` and a `clampScrollback` whose absent-field fallback is 50. The canonical values are `SCROLLBACK_MB_MIN = 10`, `SCROLLBACK_MB_MAX = 50` and `SCROLLBACK_MB_DEFAULT = 10` (`terminal/scrollback.ts:13`, `:14`, `:19`), mirrored as `TERMINAL_SCROLLBACK_MB_MIN` / `TERMINAL_SCROLLBACK_MB_MAX` (`crates/chan-library/src/config.rs:234-235`), and `sanitize_terminal_config` clamps every write to that range (`crates/chan-server/src/routes/preferences.rs:475-481`). The slider renders `max={SCROLLBACK_MAX}` at `TerminalSection.svelte:109`, so it offers up to 500 MB and the server silently snaps anything above 50 back down.

Both constant blocks that these should have come from carry a comment telling the reader to keep them in lockstep by hand (`terminal/scrollback.ts:10-12`, `crates/chan-library/src/config.rs:232-233`), and one of the two comments names the wrong crate: it points at `crates/chan-server/src/config.rs`, where the constants are imported (`crates/chan-server/src/config.rs:29-30`) rather than declared. `EditorSection` shows the shape that works: it imports `EDITOR_FONT_SIZE_MIN` / `EDITOR_FONT_SIZE_MAX` and `clampEditorFontSize` from `state/editorTheme` (`EditorSection.svelte:16-22`) and declares nothing. The same file that hardcodes the scrollback bound also hardcodes the 8 and 32 terminal font bounds (`TerminalSection.svelte:27-28`) that exist in Rust as `TERMINAL_FONT_SIZE_MIN` / `TERMINAL_FONT_SIZE_MAX` (`crates/chan-library/src/config.rs:238-239`).

## Four documented claims about this surface are false at HEAD

Whoever picks this up will read these, and three of them point away from the truth in exactly the direction this item argues.

```
claim                                  where                  truth
-------------------------------------  ---------------------  ----------------
"Server clamps to [10, 500]; default    api/types.ts:147       [10, 50], 10
 50"
search_aggression "Not surfaced in      api/types.ts:292-294   is surfaced,
 Settings yet"                                                 Files & search
terminal "Not surfaced in Settings      api/types.ts:300-301   is surfaced,
 yet"                                                          Terminal
editor_theme surface is "Settings ->    config-reference.md:   is in Appearance
 Editor -> theme selector"              109
```

A fifth row in the same doc is wrong in the opposite direction: `bubble_overlay_mode`'s reachability reads "`chan config get/set` + Bubble menu" (`docs/config-reference.md:127`), naming a surface with no caller. `api.setBubbleOverlayMode` is declared at `api/client.ts:1272` and a grep over `web/` and `desktop/` returns that declaration and nothing else. The only writer is the Appearance radio at `AppearanceSection.svelte:284-291`, which the row does not mention. The dead export is not this item's work; the row is, because that table is the instrument the acceptance below binds to.

## Two knobs are cheap to surface, and seven should stay unsurfaced

`browser_side_panes.{left,right}` has no Settings row. It is reachable from the File Browser's stick buttons (`FileBrowserSurface.svelte:639`, `:648`) and from two launcher commands, `app.browser.toggleLeftDock` and `app.browser.toggleRightDock` (`browser.ts:397-404`, `:405-412`). Both leaves already have CLI specs, `editor.browser_side_panes.left` and `.right` (`crates/chan/src/lib.rs:7176`, `:7180`), so a Settings row needs no new plumbing on either side.

`terminal.secret_masking` renders as read-only text saying Enabled or Disabled, with a hint pointing at `server.toml` (`TerminalSection.svelte:168-181`). It is a plain bool on the composite, `sanitize_terminal_config` leaves it untouched (`crates/chan-server/src/routes/preferences.rs:456-492` sets only `idle_timeout_secs`, `session_cap`, `ring_bytes`, `font_size`, `scrollback_mb` and `default_term`), and it already has a CLI spec, `server.terminal.secret_masking` (`crates/chan/src/lib.rs:7290`). Making it editable is a `PillToggle` and a `commit`. See the collision section for why this one is not free after all.

Seven fields stay unsurfaced, named here with the reason so nobody reopens them:

- `terminal.secret_mask_suffixes`: `normalize_terminal_secret_mask_suffixes` (`crates/chan-library/src/config.rs:201-230`) drops entries outside `[A-Za-z0-9_]` (`:210-216`), dedupes (`:223-224`) and truncates at `TERMINAL_SECRET_MASK_SUFFIX_MAX` (`:225-228`). A chip editor must mirror all three or silently discard what the user typed.
- `terminal.idle_timeout_secs` and `terminal.session_cap`: `sanitize_terminal_config` replaces only a literal 0 (`preferences.rs:458-463`). There is no clamp, so a slider offering 1 second is accepted and reaps sessions.
- `terminal.ring_bytes`: same zero-only treatment (`preferences.rs:464-466`), and no user-facing unit.
- `cs_dismissed`: `PreflightOverlay` reads it from the pre-flight snapshot before preferences load (`csDismissed`, `PreflightOverlay.svelte:48-50`) and gates the card on `csOffer`, which the server sets only when `cs` is absent from PATH (`showCsCard`, `:64`). A toggle would be inert until the next window load, and inert forever once `cs` is on PATH.
- `overlay_maximized`: it already has a control, the maximize button in this overlay's own header (`toggleMax`, `SettingsOverlay.svelte:217-219`, rendered at `:260-272`).
- `pane_widths`: drag-owned continuous geometry, as `docs/config-reference.md:117-121` records.

## Contract

- A Settings section corresponds to an app surface, and every knob belonging to that surface is in it.
- The section list is derived from the same category set the command registry uses, so Settings and the launcher cannot disagree about which surface owns a setting.
- One visual and behavioural vocabulary across the whole overlay, per-workspace band included.
- A control's bounds come from the same constant the server validates against, by import, not by a comment asking the reader to keep two numbers in lockstep.
- A knob that is not editable is either absent or visibly read-only with the reason, never a control that silently disagrees with the server.
- Every field that exists has a recorded destination or a recorded reason for having none, in a file that is checked rather than remembered.

## Boundary

In scope: the fourteen Svelte files under `web/packages/workspace-app/src/components/settings/` and its `workspace/` subdirectory, the `CommitFn` type they share (`settings/commit.ts`), `SettingsOverlay.svelte`, the two Settings test files, the four stale doc rows named above, and the two knobs named as cheap.

Deliberately out:

- **The Keyboard Shortcuts body.** `KeymapSettings.svelte` owns its own filter row and scrolling grid and is mounted through a dedicated container for that reason (`SettingsOverlay.svelte:316-322`, `.keymap-mount` at `:434-439`). This item moves its rail entry and touches nothing inside it. That matters because [the-deck-chords-are-invisible-to-the-shortcut-registry](the-deck-chords-are-invisible-to-the-shortcut-registry.md) is in this same version and works inside that grid, at the `groups` derived that walks `allCommands()` (`KeymapSettings.svelte:40`). The two do not overlap: it edits the grid's contents, this edits the rail entry that mounts the grid.
- **The graph palette.** Its own item, and the ordering is below.
- **Endpoint, polling and error semantics of the six per-workspace controls.** They call their own endpoints and never flow through the `PreferencesView` buffer (`WorkspaceSection.svelte:1-7`). `IndexControl` re-arms its own poll chain (`statusPollTimer`, `IndexControl.svelte:30`) and `MetadataControl` reloads the window on a timer (`MetadataControl.svelte:86`). This item changes how they look and what they are built from, not what they call.
- **The dead `api.setBubbleOverlayMode` export.** Named as evidence, not taken as work.
- **Batching.** `updateWithRetry` sends exactly what the mutation returned (`api/preferenceWrite.ts:31-36`), one narrow patch per control. Nothing here introduces a multi-field write, and the reason is in the next paragraph.

One constraint the reorganisation must not walk into. `PreferencesPatch::owner` (`crates/chan-server/src/routes/preferences.rs:182-212`) splits every field into `Editor` or `Server` and rejects a patch that carries both with a 400 (`:208-210`). `terminal_colors` and `hybrid_surface_themes` are `Editor` (`:185`, `:193`); `terminal` is `Server` (`:201`). A Terminal section that gathers the surface's whole configuration therefore holds fields from both owners. That is fine while each control emits its own patch, and it breaks the moment somebody adds the obvious next control, a per-section "reset to defaults", which would produce a mixed patch and a 400. Any such control must emit one patch per owner.

## The collision: this lands after `origin/feat/linux-terminal-grid`, not beside it

The owner has a live branch, `origin/feat/linux-terminal-grid`. `git diff --stat main...origin/feat/linux-terminal-grid` at `f9c2878c` reports 23 files and 1,001 insertions, and three of those files are in this item's blast radius: `web/packages/workspace-app/src/components/settings/TerminalSection.svelte`, `crates/chan-library/src/config.rs` and `docs/config-reference.md`.

The textual overlap on the Svelte file is one line: the branch rewrites the "Ghostty backend" hint at `TerminalSection.svelte:158`. That is not the reason to sequence. The reason is what the branch does to two of this item's steps:

- It flips `terminal.ghostty` from a fixed `false` to a platform-keyed default, `cfg!(target_os = "linux")`, in `chan-library`'s `TerminalConfig`, and updates `docs/config-reference.md:30` to read "`true` on Linux, `false` elsewhere". This item's first step rewrites the constants block ten lines above that field's UI and corrects four rows of that same doc table, one of which is in the same terminal table the branch edits.
- Its new hint text states that "Secret masking is xterm-only and does nothing here". So once the branch merges, Linux users are on ghostty by default, and this item's cheapest win, making `terminal.secret_masking` editable, would ship a control that does nothing under the platform default on one of the three platforms. That step needs re-deciding after the merge, not before: either it stays read-only, or it ships with its xterm-only scope stated in the row itself.

**This item's work starts after that branch merges.** Not alongside it. A reorganisation of Settings rewrites every section including that one, and a lane that starts first hands the owner a conflict in a file whose semantics the owner is in the middle of changing. Nothing in this item is urgent enough to justify that, and the two doc rows would have to be reconciled by hand either way.

## Order against the graph palette item

[the-graph-palette-has-never-been-configurable](the-graph-palette-has-never-been-configurable.md) was accepted into this same version, on the same day, and it adds seven to eight colour keys with a Settings surface. **It has already ruled on the ordering, in the opposite direction, and this item defers to that ruling rather than reopening it.** Its boundary section says the placement is its own problem, that it must not block on this item, and that "the cheapest honest answer is Appearance, next to the terminal colour control at `components/settings/AppearanceSection.svelte:322-361`, which already ships the exact UI shape needed".

So the palette item runs first, and this item pays for it in two named places rather than in a surprise:

- **A second copy of the colour control.** `AppearanceSection.svelte:322-361` is the one hand-rolled swatch-plus-hex-plus-error-plus-reset block in the tree, and it is the block the palette item names as its template. When step 2 extracts the colour primitive it will be collapsing two copies, not lifting one, and step 3 will be migrating both.
- **Eight more rows to move in step 5.** The palette's rows land in Appearance and this item's rail then moves them to Graph. That is mechanical once the primitive exists, but it is work that would not exist in the other order.

The reverse order is cheaper by roughly the palette's whole UI half: a Graph section would already exist, the swatch primitive would already exist, and the palette would add rows rather than a control. That is stated here so the tradeoff is on the record and the owner can flip it with one sentence. It is not proposed as a change, because the palette item's own reasoning for not blocking is sound: its expensive half is Rust, a preference struct with server-side hex validation plus seventeen `CONFIG_KEYS` entries, and none of that needs anything from here.

Both items must not edit `AppearanceSection.svelte:322-361` at the same time. That is the whole of the mechanical conflict, and the accepted order resolves it.

The full chain: `origin/feat/linux-terminal-grid` merges, then the graph palette, then this item.

### The ruling, 2026-08-11: superseded by the owner

**@@Alex ruled that the lane rebases onto `origin/feat/linux-terminal-grid` and works there, rather than waiting for it to reach `main`.** That supersedes the sentence above requiring the branch to merge first, and the "not alongside it" instruction in the collision section. It is recorded here rather than by deleting those paragraphs, because the reasoning in them is still the reason this item is done on a rebase rather than on `main`.

What the ruling does **not** change: the graph palette stays on `main`, per its own item's instruction not to do that work on that branch, and it still lands first, because this item's step 2 waits on the palette's copy of the swatch block independently of anything about the branch. The order remains palette, then this item.

## The seven steps, and which two run in parallel

```
step  what                                        depends on   size
----  ------------------------------------------  -----------  ------
1     bounds by import, four doc rows corrected    branch       small
2     extract the field primitives                 1, palette   medium
3     migrate the four per-machine sections        2            large
4     migrate the six per-workspace controls       2            large
5     rebuild the rail, move every field           3 and 4      medium
6     surface browser_side_panes, rule on          5            small
      secret_masking
7     harness records the patch body; owner and    5 and 6      small
      inventory assertions
```

`branch` is `origin/feat/linux-terminal-grid` and `palette` is the graph palette item, for the reasons in the two sections above. Step 2 is the one that waits on the palette specifically: its colour primitive collapses the swatch block at `AppearanceSection.svelte:322-361`, and the palette lands a second copy of that block. Everything from step 3 on inherits that wait through step 2.

**Steps 3 and 4 are the parallelisable pair.** They are safe to split across lanes because they are disjoint on all three axes that matter here. Files: step 3 touches `settings/*.svelte`, step 4 touches `settings/workspace/*.svelte`, and the only file they share is the primitive module step 2 produced, which both consume without editing. Data path: the per-machine sections write through the shared `PreferencesView` buffer and the parent's `commit` (`SettingsOverlay.svelte:178-188`), the per-workspace controls call their own endpoints and never touch that buffer, which `WorkspaceSection.svelte:1-7` states as the reason they are separate. Tests: `SettingsOverlay.render.test.ts` drives only the per-machine sections, and nothing in the tree mounts a per-workspace control, so the two lanes cannot redden each other.

The other five are serial and each for a stated reason. Step 1 is alone and first because it is the only step that changes a value a user can see, the slider's ceiling dropping from 500 to 50, so it should be revertible without unwinding a refactor. Step 2 defines the props every later step calls. Step 5 moves fields between the same files steps 3 and 4 are rewriting, so it cannot run beside them. Step 6 adds rows to sections step 5 creates. Step 7 asserts the arrangement steps 5 and 6 produce.

Two traps, both carried from the draft and both confirmed:

- **The primitives take a one-way `value` prop with an `oncommit` callback and never `$bindable`.** Three effects exist today only to keep a server reseed from fighting a control in use: the buffer reseed guarded on the server snapshot and on `inflight` (`SettingsOverlay.svelte:136-143`), and the two local mirrors that let a slider thumb track a drag (`EditorSection.svelte:34-36`, `TerminalSection.svelte:36-38`). A `$bindable` primitive writes back into the buffer and reintroduces exactly the fight those three exist to prevent.
- **`SettingsOverlay.render.test.ts` exists because these effects have caused `effect_update_depth_exceeded`**, which its own header says in as many words (`:3-7`). Six primitives across roughly two dozen call sites enlarges that surface.

A third, found in verification and not in the draft: none of the five debounce timers is cleared on destroy, so switching sections mid-debounce still commits after the section unmounts. That is current behaviour, it is arguably the right behaviour, and it is easy to change by accident when the timer moves into a shared primitive. Preserve it deliberately or change it deliberately.

## Acceptance

- The rail is derived rather than typed: a test checks the section list against the command registry's category set, and every excluded category is named in that test with its reason. What fails if this is false is the next surface somebody adds, which will get commands and no section, exactly as the Graph and the Dashboard did.
- Every field in the two tables of `docs/config-reference.md` carries either a `Settings -> <section>` destination or an explicit "not surfaced" with a reason, and the doc is checked against the shipped rail rather than against memory. The four rows corrected in step 1 are the evidence that it was never checked before.
- The scrollback slider's rendered `max` attribute equals `SCROLLBACK_MB_MAX` imported from `terminal/scrollback.ts`, and its absent-field fallback equals `SCROLLBACK_MB_DEFAULT`, asserted against the rendered DOM rather than against the source text. Today it renders 500 against a server that clamps to 50 (`preferences.rs:475-481`).
- **The render harness records the PATCH body.** `SettingsOverlay.render.test.ts:106` pushes the merged `server` object into `patches`, not `body.preferences`, so every existing assertion inspects post-merge state. Three tests whose names claim to check a patch are in fact checking the merge, including "changing a field PATCHes exactly that slice" (`:174-191`), "terminal font size clamps on blur and PATCHes the terminal owner" (`:281-302`) and "toggling mouse capture PATCHes terminal.mouse_capture and keeps siblings" (`:435-464`). Until the mock at `:96-107` records the wire body, no owner assertion is possible at all. The draft's line that "nothing today tests it" is right, and this is why.
- With that fixed, driving one control in every section produces a body whose fields fall on exactly one `PreferencesOwner` (`preferences.rs:182-212`). This holds today because nothing batches; the check is there so it still holds once one section renders both owners in one panel.
- One implementation of the body-theme merge-versus-delete survives. Two exist: `nextSurfaceThemes` for the optimistic buffer (`AppearanceSection.svelte:81-90`) and `setHybridSurfaceTheme` / `clearHybridSurfaceTheme` for the persist (`store.svelte.ts:405`, `:416-419`).
- Exactly one `.pill.on` block survives **under `components/settings/`** and `PillToggle` carries the `disabled` prop its copies already implement. Four exist there today with identical bodies (`PillToggle.svelte:50-52`, `ReportsControl.svelte:127-129`, `SemanticControl.svelte:289-291`, `PillRadio.svelte:67-69`), which is the same set v0.85.0 had to edit four times. (Corrected 2026-08-11: this line read "exactly one `.pill` block survives tree-wide" against a count of three. As written it was unachievable: `StyleToolbar.svelte:504` also declares `.pill`, and the closed item ruled it out of reach. State what happens to `PillRadio` rather than leaving it to the reader.)
- A grep for `SettingField`, `PillRadio` and `PillToggle` over `settings/workspace/*.svelte` returns six files instead of zero. That is the observable form of the fork and it is one command.
- The six per-workspace controls keep their endpoints, their poll cadence and their error semantics, established by diffing the fetch calls each makes before and after, not by the suite staying green. `IndexControl`'s self-re-arming poll (`IndexControl.svelte:30`) is the one with timing behaviour to lose.
- Nothing reaches Settings that the server does not validate. `terminal.secret_masking` passes through `sanitize_terminal_config` untouched (`preferences.rs:456-492`), which is why it is editable at all; if step 6 surfaces it, its row states that it applies to xterm.js terminals only.

## Rough size

Large, and I agree with the owner's sizing while disagreeing with the draft about where the mass sits. The draft said the reorganisation is mechanical and the primitives are the real work. Counted at `f9c2878c`, the surface is 3,515 lines across sixteen files: 1,131 in the per-machine band including the three shared components, 1,700 in the six per-workspace controls, 477 in the overlay and 207 in the keymap grid. **The per-workspace migration is the larger half by line count**, and it is the half with live endpoints, polling, busy states and error strings to preserve, against a band that has no test mounting it today. Step 4 is the single largest step, not step 2.

The primitives themselves are contained: six of them, collapsing five debounce sites, three clamp handlers, two colour controls once the palette item lands its copy, and two chip lists. The rail rebuild is genuinely mechanical once both migrations land, which is what makes the 3-and-4 split worth taking. Steps 1, 6 and 7 are small, and step 7 is small only because the harness change it needs is one function.

Two things could inflate it. Making `PillToggle` carry `disabled` means auditing every existing pill for a disabled state it did not have, and there are thirteen `PillToggle` and `PillRadio` call sites across the four per-machine sections, seven of them in `AppearanceSection` alone. And if the rail is argued rather than derived, step 5 stops being mechanical; the derivation from the command registry's categories exists in this item precisely so that argument has a settled answer before a lane starts.

No timing is claimed here. The owner's "seven steps, two parallelisable" is the owner's estimate of shape, and this item adopts it; the sizes in the step table are mine, from the line counts above, and no part of this was built or run, because the host has no Rust or Node toolchain.
