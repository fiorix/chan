# The slide deck's two chords are in none of the registry's 32 entries, and the consequence is a rebind that works everywhere except on a deck

Status: REGISTERED 2026-08-11 as v0.89.0 scope, carried forward from the draft `the-deck-chords-are-invisible-to-the-shortcut-registry`, raised by the owner on 2026-08-11 after asking for `Cmd+Enter` to present and discovering the chord was already bound to preview. The owner ruled that the shipped defaults stay and the two actions become rebindable, so the preference is expressed in the user's own config rather than by changing a default under everyone who has the muscle memory, and sized it at half a day plus a gate run. Verification against `f9c2878c` before promotion corrected the draft on four counts, each recorded in place below: the direction in which shadowing is actually reachable, the size of the registry, the reason the actions are not rebindable, and four of its file:line citations. It also falsified the leading example of one of the three sibling drafts, which is recorded here because that sibling is not being promoted and the correction would otherwise be lost.

## What

A slide deck has two keyboard actions. Every line below was read at `f9c2878c`:

```
action                    chord            dispatched at
------------------------  ---------------  ------------------------
open the deck windowed    Mod+Enter        FileEditorTab.svelte:446
open the deck fullscreen  Mod+Shift+Enter  FileEditorTab.svelte:445
```

Both come out of one hardcoded branch, `onSlideShortcutKeydown` (FileEditorTab.svelte:438), which tests `e.key !== "Enter"` directly at :439 and derives the modifier from a `currentOS()` captured once into `slideShortcutOS` at :353 and read at :450. The handler is mounted `onkeydowncapture` on the `.editor-host` div in the wysiwyg branch (:1311) and the source branch (:1427), and it calls both `preventDefault()` (:443) and `stopPropagation()` (:444). The actions themselves are `previewSlides` (:426) and `playSlides` (:432), also wired to the Outline body's two buttons (:1294 and :1295).

Nothing else in the app knows either chord exists. There is no `SHORTCUTS` entry, no command-catalog entry, and no `app.slides.preview` or `app.slides.present` id anywhere in the tree; a grep for `app.slides` returns nine hits and every one of them is `app.slides.new` (declared at `state/commands/slides.ts:59`). No document mentions the chords either: `web/packages/marketing/src/pages/manual.html` documents the Rich Prompt's `Cmd+Enter` and says nothing about decks. Reading `FileEditorTab.svelte` is the only way to learn them.

The absence needs a denominator, so here is what is registered. `SHORTCUTS` (shortcuts.ts:81) holds exactly 32 entries:

```
group     entries  what is in it
--------  -------  -----------------------------------------------------
App             9  launcher, computers launcher, settings, search, new
                   terminal, reload, close window, hide window, dismiss
File            1  delete file or directory
Panes           6  hybrid nav, flip side, prev, next, split right, split
                   down
Tabs            5  close, reopen closed, next, prev, jump to N
Find            3  open, next, prev
Editor          3  show source, bold, italic
Terminal        5  copy, paste, rich prompt, group broadcast, find
--------  -------
total          32
slides          0
```

Two of those 32 are the precedent this item follows. Bold (`id` at shortcuts.ts:367) and Italic (:374) are dispatched by the CodeMirror keymap, not by the registry, and carry entries anyway; the comment above them at :361-365 says the entries exist "for cheatsheet + StyleToolbar tooltip discoverability" with "the editor keymap is the dispatch source". A registry entry whose dispatch lives elsewhere is an established shape here, not an invention.

## The consequence, and only one direction of it is reachable

The draft said a user "can assign `Cmd+Enter` to another command and silently shadow, or be shadowed by, the deck." Only the second half is reachable, and stating which half matters because the two have different victims.

The rebinding path was walked end to end rather than assumed:

1. `CommandChordAssign.onCaptureKeydown` (CommandChordAssign.svelte:82) turns the keystroke into a candidate through `captureChord` (keymapAssign.ts:23), which is `chordFromEvent` (shortcuts.ts:631). For Ctrl+Enter, `canonicalKey` (shortcuts.ts:658) falls through its `Key[A-Z]`, `Digit[0-9]`, punctuation and single-char arms and returns `e.key` verbatim, so the candidate is `"Mod+Enter"`. Enter is capturable.
2. The candidate goes to `keymapConflicts` (keymapAssign.ts:31) against `resolvedKeymapEntriesForSlot` (keymapOverrides.svelte.ts:120), which is built from the 32 `SHORTCUTS` entries plus catalog commands that already carry an override. Not one of the 32 chords contains `Enter`; the only non-modifier keys in the whole registry are `Backspace`, `Esc` and the digit range. So the conflict list is empty.
3. `assignOverride` (keymapOverrides.svelte.ts:213) stores it and the dialog closes clean (CommandChordAssign.svelte:101). The user is told nothing.
4. At dispatch, the only general override path is `commandIdForChord` (keymapOverrides.svelte.ts:151) called from `onWindowKey` (App.svelte:572, the override block at :594-620), and `onWindowKey` is registered on `document` in the **bubble** phase (App.svelte:1143). The one other capture-phase listener, `onCtrlDCapture` (registered App.svelte:1202), is `e.code !== "KeyD"`-gated and cannot see Enter.

So on a slide deck, the `.editor-host` capture handler runs first and its `stopPropagation()` ends the event before `document` bubbles. The user's newly assigned command does not run, and the deck opens instead. On a plain markdown file the handler bails at `!slidesSpec` (FileEditorTab.svelte:439, from the derived at :352), the CodeMirror `Mod-Enter` chain consumes the key but does not stop propagation, and the same assignment works. **The observable defect is that one chord fires its command in every file except a slide deck, silently, and the user has no way to find out why.** It is even focus-dependent inside one tab: `shouldIgnoreSlideShortcutTarget` (:453) lets the event through when focus is on a button or input that is not inside `.cm-editor`, so the assigned command fires from the Outline pane of the same deck where it is dead in the editor.

The other direction does not exist. A rebind cannot take `Mod+Enter` away from the deck, because the deck's capture claim is unconditional and runs before any override dispatch; off a deck there is no deck to shadow.

The discoverability half of the draft holds as written. The chords are absent from the command launcher, which renders `allCommands()` and reads each row's chord through `chordFor` (CommandLauncher.svelte:250); from Settings -> Keyboard Shortcuts, whose grid iterates `allCommands()` (KeymapSettings.svelte:40); and from `chan open --help`, whose `KEYBINDINGS_TABLE` (crates/chan/src/lib.rs:131) is generated from the registry. The Outline Preview and Present buttons advertise no chord either: their titles are `Preview slides (${slidesSpec.aspectRatio})` (OutlineBody.svelte:123) and the same shape for Present (:132).

## What makes them unrebindable is the command catalog, not the conflict set

The draft attributed this to `resolvedKeymapEntriesForSlot`. That function builds the conflict set, not the assignment surface. The assignment surface is `KeymapSettings.svelte`, whose `groups` derived walks `allCommands()` at :40 and renders one `CommandChordAssign` cell per slot per command. An id with no catalog entry has no row, so there is nothing to assign to.

This is load-bearing for the shape of the fix: a `SHORTCUTS` entry alone puts the chords into conflict detection and the help table but not into the grid or the launcher, and a catalog entry alone does the reverse. Both are needed, and the catalog entry needs a way to reach the mounted editor, because `previewSlides` and `playSlides` close over component state (`editorTabEl`, `editorTheme`, `tab.content`). That seam already exists and is already used for exactly this: `mountedEditors.ts` keys an imperative `EditorCommands` surface (declared :14) by tab id, `FileEditorTab` registers into it at :760, and `app.editor.toggleCollapse` reaches through it with `editorCommandsFor(tab.id)?.toggleCodeBlocks()` (`state/commands/editor.ts:126`). Two more members on that type is the whole plumbing cost.

## The dispatch site is load-bearing and the ordering around it is real

`Mod+Enter` is the most contested chord in the app. Confirmed claimants, with the phase each one runs in:

```
claimant                    file:line                     phase
--------------------------  ----------------------------  ---------------
link preview popover Open   overlays/preview_popover.ts:  document capture
                            197 (listener at :219)        (stopImmediate)
deck preview / present      FileEditorTab.svelte:1311     element capture
                            and :1427                     (stopPropagation)
date pill popover           Wysiwyg.svelte:599            CM6 keymap
fence escape, anywhere      Wysiwyg.svelte:616            CM6 keymap
fence escape, doc end       Wysiwyg.svelte:617            CM6 keymap
submit-or-no-op guard       Wysiwyg.svelte:630            CM6 keymap
Rich Prompt submit          RichPrompt.svelte:137         CM6 keymap
image widget View           widgets/image.ts:831          document bubble
                            (listener at :817)
override dispatch           App.svelte:594-620            document bubble
                            (listener at :1143)
```

The deck wins the ones below it purely by phase. The submit-or-no-op guard sets `stopPropagation: !!onSubmit` (Wysiwyg.svelte:635), which is `false` in a file editor, so CodeMirror preventDefaults without stopping propagation and the event keeps travelling. Moving deck dispatch to the window layer would therefore make two handlers fire on one press: on a deck with the caret on a date pill, the calendar popover and the slide player both open. That is a shipped regression class in this repo and the mechanism is written down: [`../done/bug-fixes.md`](../done/bug-fixes.md):51 records "CM6 keymaps preventDefault but do not stop propagation, so one press submitted the Rich Prompt and opened the fullscreen image zoom on top of it."

## Registering the chords the obvious way would make one thing worse than it is today

**If the capture handler is changed to match by resolved chord, the deck stops claiming two compile-time keystrokes and starts claiming whatever the user assigned, in the capture phase, ahead of CodeMirror, on every deck tab, and conflict detection cannot see a single CodeMirror binding, so the change converts an existing double-fire into a silent takeover.** That is the most important sentence in this item.

Worked through concretely. `Shift+Tab` is assignable: `chordFromEvent` emits `"Shift+Tab"` for it, and no registry entry holds it, so the assign dialog accepts it with no conflict. `Shift-Tab` is also list-outdent in the editor keymap (Wysiwyg.svelte:696), with no `stopPropagation`. Assign `Shift+Tab` to a deck action today and both things happen: outdent runs and the override fires, which is ugly and visible. Assign it after a match-by-resolved-chord refactor and only the deck runs, because the capture handler would `preventDefault()` and `stopPropagation()` on it. Outdent disappears from every deck, the dialog said nothing, and there is no surface in the app that will ever mention it.

The containment is available inside this item and costs almost nothing, which is why this is a design instruction rather than a blocker. Keep the capture handler claiming only the built-in default shape, gate it on `builtInChordSuperseded` (keymapOverrides.svelte.ts:174) so a rebind makes it inert, and let a user-assigned chord dispatch through the override path that already exists at App.svelte:594-620 into the catalog command and the `mountedEditors` seam. The capture claim then never widens, and a rebound deck chord double-fires against an unregistered CodeMirror chord exactly the way every other rebound command already does, which is a sibling's defect and not one this item introduced.

## The three sibling drafts, what they share, and which one a lane needs

All three are in `dev/roadmap-drafts/` and none is being promoted. They are one class seen from four places, and the files they share with this item are these:

```
file                                        this  editor  supers  swap
------------------------------------------  ----  ------  ------  ----
state/shortcuts.ts                          edit  edit    -       -
components/FileEditorTab.svelte             edit  -       -       -
state/commands/ (catalog)                   edit  -       -       -
state/mountedEditors.ts                     edit  -       -       -
components/OutlineBody.svelte               edit  -       -       -
crates/chan/src/lib.rs KEYBINDINGS_TABLE    edit  edit    -       -
editor/Wysiwyg.svelte                       read  edit    -       -
state/keymapOverrides.svelte.ts             read  read    edit    edit
components/CommandChordAssign.svelte        -     -       -       edit
App.svelte                                  read  -       edit    -
```

`editor-chords-are-missing-from-the-shortcut-registry.md`. Shares `shortcuts.ts` and the regenerated help table; reads the same override layer. This item does not fix it and half-fixes it only in the narrow sense that it removes one pair of chords from that draft's "dispatched outside the registry" set and demonstrates the pattern on that pair. The section above is the reason a lane must read it even without taking it. **Its leading example did not survive verification and should not be carried forward: there is no strikethrough keybinding anywhere in the tree.** `toggleStrike` (`editor/commands/format.ts:123`) is reachable only from the StyleToolbar button's `onclick` (StyleToolbar.svelte:316); a grep for `Mod-Shift-s` in any casing returns nothing, and the complete modifier-bearing chord set in `editor/` plus `RichPrompt.svelte` is five `Mod-Enter`, two `Shift-Enter`, one `Shift-Tab`, one `Mod-b` and one `Mod-i`. Two comments in the tree assert otherwise and are wrong at HEAD: shortcuts.ts:448-452 says "strike (Cmd+Shift+S) is owned by the editor keymap directly", and StyleToolbar.svelte:311 titles the button "strikethrough (Cmd/Ctrl+Shift+S)", a chord that is bound to nothing and that `app.search.toggle` holds on macOS (shortcuts.ts:112). Whoever takes the sibling should start from its own acceptance line about enumerating the CM6 keymaps rather than from its three examples.

`built-in-chord-supersession-is-checked-inconsistently.md`. Shares the override layer and `App.svelte`. This item does not fix it. It adds one more consumer of `builtInChordSuperseded`, in a file that draft's table does not list, and whether that consumer is a conforming branch or a new unchecked one is exactly the dispatch decision above. A lane taking this item should read that draft's table and does not need to take the item.

`assigning-an-already-held-chord-has-no-swap-path.md`. Shares the override layer and owns `CommandChordAssign.svelte`. This item does not fix it and makes it bite, on the owner's own request. After this item `Mod+Enter` is held by deck preview, so "Cmd+Enter presents" becomes a swap, and `onCaptureKeydown` refuses a held chord and holds the capture open with no next step offered (CommandChordAssign.svelte:97-99). Reaching the owner's ask takes three assignments: park preview on a throwaway chord, give present `Mod+Enter`, then move preview onto the freed `Mod+Shift+Enter`. **A lane doing this item should be given that one too**, because otherwise the work requested to satisfy the owner's ask ends by blocking it in a dialog. That draft's own size estimate ("small to medium, mostly interaction design") looks right; `assignOverride` and `clearOverride` (keymapOverrides.svelte.ts:213 and :227) already compose into a swap. One correction for whoever takes it: it says the gap "affects all 27 registry ids", and the registry holds 32.

## The chord item being promoted in parallel

`ctrl-shift-w-closes-the-window-not-the-tab.md` and this item touch two of the same files in different regions, and one shared generated artifact. It edits `osChord` (shortcuts.ts:505-546) and the `app.tab.close` / `app.window.close` entries; this item appends entries to the `SHORTCUTS` array (shortcuts.ts:81-446) and does not need `osChord` at all, since the deck chord is the same on every platform. Neither touches the other's lines. The collision is `KEYBINDINGS_TABLE` (crates/chan/src/lib.rs:131): both items regenerate it by hand from the same generator, so whichever lands second rebases a hand-pasted Rust const. They also both depend on `make shortcuts-check` being green, and that check is a gate step (Makefile:261, target at :436), so each item's SPA and Rust edits must land in one commit. Beyond that they are independent: this item never touches `App.svelte`'s `KeyW` branch, `desktop/src-tauri/src/serve.rs` or `main.rs`, and the key bridge has no `Enter` handling at all, which was checked by grep.

## Contract

- Every chord the app binds is described by the registry that feeds the launcher, the Settings grid, the help table and conflict detection. A chord that is dispatched somewhere else still has an entry, on the Bold and Italic precedent.
- A user can rebind any action the registry describes, and the rebind replaces the built-in rather than aliasing it.
- A control that has a chord shows it.
- Adding an action to the registry does not change which handler runs first for any chord that action does not hold.
- A capture-phase claim on a chord is never wider than the set of chords its owner is advertised as holding.

## Boundary

In scope: two `SHORTCUTS` entries; two catalog commands and the two `EditorCommands` members that let them reach the mounted editor; the capture handler at FileEditorTab.svelte:438; the two Outline button titles; the regenerated `KEYBINDINGS_TABLE`; and the test fallout named in Acceptance.

Deliberately out, and named so the next reader does not reopen it. Enumerating and registering the CodeMirror keymap chords is `editor-chords-are-missing-from-the-shortcut-registry`. Auditing every `App.svelte` keydown branch for a supersession check is `built-in-chord-supersession-is-checked-inconsistently`. Giving the assign dialog a swap or take-anyway path is `assigning-an-already-held-chord-has-no-swap-path`. Changing which chord opens which mode is out by the owner's ruling.

Also out, and correct as it stands: the handler is mounted on two of the five `.editor-host` divs, wysiwyg (:1311) and source (:1427), and not on pretty (:1381), table (:1392) or canvas (:1408). `parseSlidesSpec` reads YAML frontmatter and only a markdown buffer reaches the two mounted modes, so `slidesSpec` is null in the other three regardless. This item does not extend the mount.

## Acceptance

- Both actions have a `SHORTCUTS` entry carrying **both** a `web` and a `native` chord. `osChord` returns `undefined` when the requested platform's field is absent (shortcuts.ts:510-511), so a native-only entry would drop the row from `chan open --help`, which the generator produces for `--platform web --os mac` (shortcuts-table.mjs:54-55), and would make `chordFor` return `null` in a browser. The `native` field's own doc comment (shortcuts.ts:61-64) invites exactly that mistake by saying to omit it when native and web share a chord; no entry among the 32 does that, and this item either corrects the comment or records why not.
- Both rows appear in `chan open --help` with `make shortcuts-check` green against a regenerated `KEYBINDINGS_TABLE`. `ShortcutGroup` is a closed union with no slides member (shortcuts.ts:41-48), so the entries either join `Editor` or the union gains a member; `renderTable` orders groups by first appearance (shortcuts.ts:811-819), so adding one moves the table's sections. State which was chosen and why.
- Both appear as rows in the Settings keymap grid with a per-slot assignment cell, and in the command launcher with their chord. A `SHORTCUTS` entry alone does not achieve this: the grid iterates `allCommands()` (KeymapSettings.svelte:40).
- Assigning a chord to either action makes that chord open the deck and makes `Mod+Enter` stop opening it, verified by pressing the old chord on a real deck and observing nothing happen, not by reading the resolver.
- Assigning `Mod+Enter` to any other command is reported as a conflict naming the deck preview action. Today `keymapConflicts` returns empty for it, because nothing in `resolvedKeymapEntriesForSlot` holds `Enter` at all.
- **The capture handler's claim is no wider after the change than before.** Assign a deck action a chord CodeMirror uses and the registry does not (`Shift+Tab`, Wysiwyg.svelte:696) and confirm list outdent still runs on a deck. This line exists because the natural implementation fails it.
- The `Mod+Enter` pile-up is unchanged: on a non-deck file, `Mod+Enter` on a date pill opens the calendar and nothing else; in a Rich Prompt it submits and does not open the image zoom; in a file editor with a ring-selected image it still opens the zoom. Established by a test that mounts real CodeMirror in jsdom, on the harness `editor/wysiwygModEnter.test.ts` already provides (`mountWysiwyg` at :16, `press` at :33), asserting the document is unchanged and a document-level tripwire never fired, and shown to fail when the capture mount at FileEditorTab.svelte:1311 is removed.
- The Outline Preview and Present titles (OutlineBody.svelte:123 and :132) carry the current chord resolved through `chordFor`, so a rebind is reflected. `FileEditorTab` already wraps that lookup as `chordLabel` (:917).
- `components/slideShortcuts.test.ts` keeps only the claim it is uniquely good at, the two template-shape assertions at :17-22 that pin the capture mount on both hosts. Its two text pins, the handler-body regex at :8-10 and the modifier line at :14-16, describe code this change rewrites; they go rather than growing into new regexes. Renaming `onSlideShortcutKeydown` would also break the two template pins, so either keep the name or update all four.

## Rough size

Small, and the production half is smaller than the draft's estimate. The draft's author put it at roughly 120 lines of production change plus roughly 180 lines of test; that is the author's estimate and no part of it was measured. My own reading is that production lands nearer 60 to 80 lines, because every seam already exists and none has to be invented: two array literals in `shortcuts.ts`, two catalog entries next to `app.slides.new`, two members on `EditorCommands` and their registration at FileEditorTab.svelte:760, a `builtInChordSuperseded` gate in the existing handler, two prop threads into `OutlineBody`, and a regenerated Rust const. The test estimate is about right, and it is the majority of the work.

I agree with the owner's half a day plus a gate for the code, conditional on the dispatch shape being decided before a lane starts rather than during. I do not think the acceptance above fits in that: two of its lines need a real-CodeMirror jsdom test that can be shown to fail, and one needs a live rebind check in a running client. A day including the gate is the honest number.

The estimate inflates in one way only, and it is worth pricing before starting: this item makes the owner's original ask expressible and then leaves it refused by the assign dialog. If the lane is expected to deliver "Cmd+Enter presents" rather than "the deck actions are rebindable", it has to take `assigning-an-already-held-chord-has-no-swap-path` as well, and that one is mostly interaction design.
