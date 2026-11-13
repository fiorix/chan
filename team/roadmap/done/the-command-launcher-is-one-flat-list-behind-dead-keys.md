# The command launcher is one flat list behind dead keys, and an action has up to five names across the deck, the menus and Settings

Status: shipped in [v0.129.0](../../release/release-v0.129.0.md): the command deck as `feat/command-deck` built it, with the four changes built on the owner's answers (the last section); every reading of the deck's Mac brief passed on the owner's Mac on 2026-11-13 (a build of `8a44e110e`). Not shipped, each a v0.130.0 row on his word: a standalone terminal window loading saved shortcut overrides ([the row](../v0.130.0/a-standalone-terminal-window-loads-no-saved-shortcut-overrides.md)), and the file browser's `New` and `Paste` choosing the folder the launcher's commands of those titles choose ([the row](../v0.131.0/the-file-browsers-new-and-paste-rows-and-the-launchers-commands-choose-different-folders.md)). An extension's iframe that focuses itself under the open deck stays a known gap.

Record before the release: built on `feat/command-deck` from `8ded1bda9` (the v0.128.0 tag) on 2026-11-12, brought onto the integration branch's tip `6bd1852cb` by its own lane on 2026-11-13 (merge `6c792e94b`, 11 files resolved, with fixes on top to `79cb618db`) and taken into the integration branch as `ffa6772e3` the same day, on the owner's word and without a review at the intake: the lane's three reviews, their fix round and an independent read of the merge are the reviews it has. The lane's scoped gate passed on `79cb618db` and the integration gate covered the intake at `ffa6772e3`. The owner answered the lanes' thirteen open points the same day, and four changes built on his answers were merged as `09d7a4f9e` and `ac53b246b` (the last section). The owner walks it on macOS and in chan-desktop at the release. The text below is the lane's draft, placed as written: where it calls itself a draft, or says the work is not merged or not pushed, this paragraph and the note under it hold.

Brought forward 2026-11-13T10:05Z: the branch now holds `v0129/int` at `6bd1852cb` (merge `6c792e94b`, 11 files resolved), passed its scoped gate again and is on origin at `79cb618db`; `handoff-v0129-intake.md` has that state and its gate table. The text below was written at `f791eb5c1` and is kept as written except where this note says otherwise. What the bring-forward changed for this draft: the graph command titled `Scope details` is now `Select workspace` (it selects the workspace's node; the round's graph has no scope); the launcher's `Increase depth` and `Decrease depth` rows show the depth of the round's selected node; a graph tab offers all seven filters, since the round's graph has no modes; the workspace app's vitest count is 9921 with the round's tests, and the browser checks are 131 (130 passed, 220 skipped). `Open` on a directory in a graph still lists the directory itself in the merged panel, held by `GraphPanel.inspector.test.ts`. Sentences below that say nothing is pushed, or that a trial merge into `v0129/int` conflicts, are superseded by this note.

Record: the proposal (`dev/command-launcher-revamp/proposal.md`) was written 2026-11-12T09:12Z from a read of `main` at `8ded1bda9` (v0.128.0) with nothing in the product changed. `build-spec.md` records that the owner accepted every recommendation in it on 2026-11-12 and asked for a working prototype in the product code, to validate in a browser: first a standalone terminal window, then a workspace window, then the Computers window. Three rounds were built and merged the same day, the owner answered the thirty-five questions the build raised (`open-questions.md`), and four more by `cs terminal survey` at 16:59Z. The merge-readiness round followed (the shortcut table and the lanes' small debts, the documents, the browser checks), then three read-only reviews of `bc7956d66` and a fix round over their findings (`review-findings.md`), whose last merge is `f791eb5c1` at 2026-11-12T20:39Z.

What is unverified in this draft is listed in its last section.

## What was seen

The owner's first message is not on file under `dev/command-launcher-revamp/`, and that directory is gitignored, so it has no history to read it from. The proposal answers that message and quotes one phrase of it, "Support all options" (section 2.7). Its section titles say what was asked about: organisation, keyboard and discoverability; the catalogue; the Computers window. Two more phrases are the proposal's own, addressed to the owner, and show what he had said: layout B "costs the rail you like", and layout A is "the smallest change that answers both complaints".

Read at `8ded1bda9`, paths under `web/packages/` (`WA/` is `workspace-app/src/`, `LA/` is `launcher/src/`, `SH/` is `web-shared/src/`). Counts marked (inv) are the proposal's own inventory passes, spot-checked by its author and not counted again for this draft.

Keys, read from the handler in `SH/components/CommandDeck.svelte` and three of them seen in headless Chrome against a served build:

- The deck ran three virtual zones (input, results, scope rail) on top of real focusable buttons. The first Down moved from the input to row 1, which was already highlighted, so every open cost one dead keypress.
- Up or Tab into the rail ringed the first orb without applying it; the first scope could only be applied by Right then Left.
- Right in the list ran the selected command, as Enter does, so on a leaf it reloaded the window or switched the theme. Left and Right were taken as back and run, so the text caret could not move.
- Tab outside the input was not handled: DOM focus walked onto orb and row buttons while the deck kept acting on its own selection. Shift+Tab was never handled.
- Up at row 1 jumped to the rail and Down at the last row wrapped; there was no Home, End, PageUp or PageDown.
- Esc closed from any depth, and nothing on screen said that back was Backspace or Left on an empty query.
- Reopening resumed the old query, scope and branch, with the query not selected.

Discoverability:

- One flat alphabetical list of roughly 70 rows on a terminal tab in a workspace window, 8 visible, each row two lines with a breadcrumb repeated on every one. No section headers and no order by use: a terminal opened on `Copy path to $CWD`, `New file or directory ($CWD)`, `Restart terminal`.
- Scope orbs were icon-only at 36% opacity with the label in a tooltip. The chord showed on the selected row only. Toggles did not say on or off, and 28 of the 138 rows had the shape `X: value` with no mark on the current one.
- Unavailable commands were hidden with no reason, there were no recents, the query matched as one string and not word by word, there was no hint line, and the opening animation took 0.4 to 0.6 s to settle.

Catalogue:

- 138 static commands in 11 categories, mapped to scopes by one function: Tabs to Tab, Panes to Pane, the active app's category to Tab, everything else to Window. `Window` held about 40 rows mixing spawners, window lifecycle, app-wide and workspace preferences, workspace actions and file browser layout.
- The category did not say where a thing lives: screen lock was `Global` in the catalog and under `This workspace` in Settings; `Focus border: <colour>` was a Pane command that recoloured the whole window; `Terminal engine` sat in the Tab scope and set the engine of terminals opened later.
- One action had up to five names: `Flip pane`, `Flip`, `Flip pane side`, `Flip side`, `Flip to side B`; `Toggle details`, `Details`, `Show Details` and `Hide Details`; `Reload` for the window and, in the search panel, for the search. Menus and the deck shared about 50 actions and worded 30 of them differently (inv).
- The deck's `Editor theme: light` and `Editor theme: dark` changed a different key from the Settings field `Editor theme`, and the deck could not set `Inherit`.
- Duplicates inside the catalog (`Flip` and `Flip pane`, `Reopen last closed tab` twice, `New terminal` and `New graph` twice each with different behaviour), and six grammars for a toggle.
- Coverage ran short both ways (inv): about 35 menu actions had no command, about 45 commands were in no menu, 12 of the 34 chorded ids had no command so the Keyboard Shortcuts grid could not rebind them, and 13 of about 55 Settings fields had a command.

The Computers window:

- Its deck's rail was one orb that changed the placeholder and nothing else. The root was a verb list (`New terminal`, `New window`, `Windows`, `Reconnect`, `Disconnect`, `Turn on`, `Turn off`, the theme switch, `Quit`, `New devserver`), with machines and workspaces hidden until a verb was picked or something typed.
- The deck existed on the Computers screen only, so no gateway action was reachable from it, and about a dozen card actions had no row.
- Labels differed from the cards (`Reconnect` against `Connect`, `New devserver` against `Add devserver`, `Open in this browser` against `Open window`), and this machine had four names.
- Turn off asked twice: once on the deck's card and again in a modal with the count.
- A row that a session leader or a pending operation ruled out was filtered away where the card shows it disabled with the reason.
- The two hosts each carried their own copy of the close-count logic and the entry builders, which is how the wording drifted. In the workspace app `New terminal` was a branch with one child, `This library`.

## Desired contract

1. Focus never leaves the query. Up and Down move rows and wrap, with row 1 selected on open so the first Down selects row 2; PageUp and PageDown move a page; Home and End reach the first and last row on an empty query; Alt+Up and Alt+Down move by section; Tab and Shift+Tab step through the scopes, with "no scope" as one stop; Enter runs a row or opens its branch; Right opens a branch, a choice or a row's page with the caret at the end of the query and never runs an action; Left and Backspace go back on an empty query; Esc leaves a branch one level at a time and closes at the root; `?` on an empty query shows the key list.
2. Opening the deck starts at the root with no scope, the last query kept and selected. A command that ran clears the query. A reload restores an open deck as it stood.
3. The same shell, sectioned: a capsule, a labelled rail, one-line rows under section headers, a right column for state and chord, a footer with the keys.
4. Six scopes in a window: the focused tab's app (named after it), Pane, Window, Workspace, Settings, Computers.
5. One registry entry per action, and the entry owns the title. Menus, the shortcut table's labels and Hybrid Nav help read it. A toggle is named for the thing and shows its state. A former title stays findable as a keyword.
6. Settings reach the deck through a settings index: a toggle or a choice changes in place, any other field opens Settings on that field, and a setting's row uses the field's own words.
7. Typed search matches words in any order with title hits first; an unavailable command is listed last, dimmed, with the reason. Browsing hides what cannot run.
8. The Computers deck is object-first with the rail as a type filter, built by one provider for both hosts in the cards' words: chained actions where one needs another first, a disabled row with the card's reason where one cannot run, one confirmation per action on the deck's own card with the live count, and the deck on both screens. A window's Computers scope is the same tree over its capability snapshot, and on chan-desktop it ends with `All computers...`.
9. A chord saved for a command id that no longer exists is dropped when the overrides load, and the status line says so once.
10. Added by the review of `bc7956d66` and built in the fix round. The deck holds the keyboard for as long as it is open and no modal dialog is showing, whatever a row that applies in place shows under it. The launcher's chord closes the open deck from any level, as a dismissal that keeps the query. One press of Enter runs one row, and a key an input method is composing with is left to it. Under a card Tab stays in the deck and the query is read-only. A command dismissed while it ran answers nothing in a deck opened after it. A setting whose write does more than store a value asks on the deck's card first, as `Semantic search` does before it downloads a model. A title that is the whole typed query ranks first. A reload restores the Computers page's deck on the page it stood on.

## What was built

Round one, four lanes over the shared contract commit `9ead949cf`, merged at `6940cdf57`:

- The shared deck (`5dcf1b9e7`, `e187fbf79`, `57b4b8335`): focus held on the input, the key contract, sticky section headers, one-line rows with fixed right-column slots, captioned rail, crumbs chip, footer and key list, word-by-word ranking with a compact title abbreviation as the loosest hit.
- The registry and the workspace app's deck host (`94c321476`, `c3782dd51`, `7479dee87`, `6940cdf57`): `scope`, `group`, `order`, `kind`, `state`, `options` and `unavailableReason` on every command; canonical titles with the former ones as keywords; the `X: value` rows gone; the sectioned browse list with `Recent`; typed search across scopes; toggles and options applied in place.
- The settings index and the link to a field (`dc8dba65f`, `5909986b2`): one entry per Settings field, the sections rendering their labels and options from it, `openSettings({ section, field })` and the overlay landing on the field.
- The Computers tree and the Computers page's deck (`f04a3f9b2`, `d09cb1244`, `3ce6a61c6`): the shared provider in `SH/command-deck/computers.ts` and `computersConfirm.ts`, the object-first root, the type filter, pages, chained actions, disabled reasons, one counted confirmation per action, the deck on both screens. The launcher's gzip ceiling went from 68 to 72 and then 78 KiB (`48aa4b115`, `14cfd6984`).

Round two, five lanes, merged at `63b75540e`:

- Menus worded from the registry: the terminal's two menus (`a13424a68`), the editor's menus and the Details inspector's actions (`f024a66b9`), the file browser's and the file tree's (`6d1cef076`), the graph's (`31a236694`), the pane hamburger and context menu, the dashboard, extension and search menus, the title bar's pane tree button and the status bar's transfers button (`d89a46413`). Toggle rows are a title with a check; every tab menu ends with `Flip pane` and `Close tab`, every body menu with `Command launcher`.
- Commands for menu actions that had none: the terminal's `Find`, `Copy`, `Paste`, `Copy scrollback` and `Broadcast targets` (`a13424a68`, `692525e67`, `8118ba6bb`); the editor's `Download` and `Export to PDF` (`c2676e198`); the file browser's `Open`, `View`, `Export to PDF`, `Hidden files`, `Select multiple` and its key list (`6d1cef076`); the divider moves, `Equalize panes`, `Details (search)`, `Reload extension` and `Present extension` (`c701daf90`). The search panel's `Reload` row, which re-runs the search, reads `Search again` (`d89a46413`).
- A window's Computers scope built from the shared tree (`8df6ff60e`), typed hits of one kind listed in scope order (`02ed716e7`), the Computers page's query cleared after a run (`f1e2f7737`), and `All computers...` from a one-machine tree to the desktop's launcher panel (`f15fa0238`, `a62eaac93`).

Round three, four lanes routing the owner's answers, merged at `bc7956d66`:

- Alt+digit and Ctrl+N and Ctrl+P removed from the deck (`ccc56eff9`); the unscoped list ends with three rows under `Computers` (`e4babca4d`) and a fourth, `All computers...`, on chan-desktop (`91acc9d65`); `Theme` on the Computers page is a choice (`fe42842c3`) that offers `System` (`769541e43`); `Select` is offered off the desktop too (`fe42842c3`).
- Four Settings headings reworded (`54f5ffc09`), `Secret masking` a choice of `On`, `Off` and `Default` (`cf8e95be3`), and saved chords of the 43 removed command ids dropped when the table loads (`1e0cbee99`).
- `Download` and `Export to PDF` on a draft (`6f7c5dda6`), menu roles on the editor's and terminal's action rows (`b78326047`), a chord assigned to the terminal's `Copy` copying the selection alone (`bc0303bc8`), the outline's slide deck buttons worded from their commands (`c7825e934`).
- A `Details` command for the file browser and one function per row for `Download`, `Upload` and `Copy path` (`4d0c9d724`), the Hybrid Nav help's stage rows in sentence case (`cfe51084c`), one divider move for the key, the commands and the drag (`a71da2620`), and `scope` required on every command (`bc7956d66`).

The merge-readiness round, four lanes, the last merged at `698a25cc6`:

- The shortcut table and the lanes' small debts (merged at `46d8f7796`): the keybinding table `chan serve --help` prints, regenerated from `shortcuts.ts` (`ace4357bd`), and the `cs` help naming rows as they read (`a42b21640`); the dashboard's and the extension tab's `Flip pane` flipping the menu's own pane (`9a8909438`); a command told that an assigned chord ran it, which the terminal's `Copy` reads in place of the browser's current event (`68032d80a`); one `shortcutLabel` for every menu's launcher row (`5e0ce6847`); the Details inspector's `Upload` raising the picker the tree's row raises (`0b9c666b3`); the graph's reveal folded onto the store's, so `Open` on a directory lists that directory (`e61e7ac08`); the workspace status switch moved beside its type and two functions with no caller removed (`c7c07d884`, `eaa4d17f9`); three comments that named `Dashboard carousel` and the launcher's size comment (`5d8af9bd9`, `01f3f0846`).
- The documents (`b8ac11285`, `fd0802c0b`, `3c0c57101`, `7c5f3b3ca`, `a9bcb5949`, `ee781a9d0`): the workspace, launcher and desktop design documents, `EDITOR.md`, `CONTEXT.md`, `docs/config-reference.md`, the manual pages and the browser-smoke README.
- The browser checks, repaired to drive the deck, the menus and Settings by their present words, roles and keys: `lib/files.mjs`, `lib/drafts.mjs` and checks 15, 21, 93, 112, 120, 122, 125, 126, 127, 130, 131 and 133 (`77f8b0be4`, `1988408c6`, `3842bc91a`, `f7667fed8`, merged at `c3f6c7d7d`); checks 163, 170, 173 to 178, 195, 198, 203, 206, 208, 209, 219 and 223 (`df0089951`, `79354d758`) and the desktop observation `focus-open`, rewritten by reading and not run (`a4fd77191`, `96957e296`), merged at `698a25cc6`. Checks 80 and 182, which the lanes had named, are unchanged.

The review and its fix round: three read-only reviews of `bc7956d66` against `8ded1bda9`, by area, with every finding and its disposition in `review-findings.md`, and four fix lanes, the last merged at `f791eb5c1`:

- Components (merged at `14856070e`): every change of a terminal's masking reaching its masker, whether the launcher's row, an assigned chord or Privacy mode makes it (M1, `e971a7e2f`), and a failed masker's mark dropped when its terminal is built again (`a89939e7a`); `Download` and `Export to PDF` saving what the editor shows first (M2, `b467cb992`); a file browser tab's `Hidden files`, `Select multiple` and key list kept while the tab is open (M4, `c82ee5352`); the editor's tab menu a dialog with its action rows in a menu (M5, `0676091e1`); and that lane's smaller debts (`8f690daf5`, `57b4a5c2c`, `10184e5e1`, `f8c62c837`, `361c59b6b`).
- Settings (merged at `42fc865c1`): `Semantic search` asking on the deck's card before it downloads a model and reading `downloading` meanwhile (R2, `e748ef150`); a read sent before a write kept from landing over the write's answer (R3, `046fa0d3e`); the two dock fields offered only in a window over a workspace (R4, `35496dfa3`); a screen lock write loading its own answer into the running lock (R5, `ad5c8b65f`); `Details (search)` last in the Workspace scope (R6, `c85669404`); and two tests that could not fail made able to (R7, `a7a762646`; R8, `4ffa314d0`).
- The deck (`9d74199c0` to `be6b51082`): the keyboard held on the open deck whatever a row shows under it (R1, `9d74199c0`); a run dismissed while it ran answering nothing in a later deck (D1, `884cdc100`); a reloaded Computers deck kept on its page until the library is read (D2, `a9fe13b26`); the Enter that commits a composition left to the input method (D3, `ce5d14891`); Tab and the query kept to the deck while a card shows (D4, `affc49626`) and an answered card taken down when its row runs in place (`1accac4bd`); the keyboard put on a card shown from the other screen (D5, `31c7827ef`); the chord closing the open deck (D6, `0cbca0ab5`); one row for one press of Enter (D8, `de2c73b05`); a title that is the whole query ranked first (D9, `93d675e7a`), with check 120 requiring it (`be6b51082`); the `allComputers` comment (R9, `6e9c81996`) and an unused re-export (`430edc581`).
- Follow-ups (merged at `f791eb5c1`): `Download` and `Export to PDF` from a file's Details running the editor's two functions (`c5889aad7`), the save they wait on named `saveTabEdits` (`cfe66369e`), the manual's sentence that the shortcut closes the launcher (`d671d3518`), the launcher bundle's measured size in its comment (`964a49f43`), and a test file's header (`348f4ec9e`).

M3, the dashboard's and the extension tab's `Flip pane`, was in a lane before the review (`9a8909438`, above). D7 is left as built for the owner and is under "What is owed".

Not built, by the owner's answers: row actions on Alt+Enter (`Assign shortcut...`, `Show in Settings`); the typed query carried into the desktop's launcher panel; editing a window's caption, bulk remove and generating a WireGuard key from the deck.

## The owner's decisions

The nine decisions of the proposal's section 5 were accepted as recommended on 2026-11-12, as `build-spec.md` records ("The owner accepted every recommendation in `proposal.md`"); the owner's words for that acceptance are not in the files read for this draft. The nine: layout A; Esc backs out one level and reopening starts at the root with the last query selected; the six scopes; a toggle named for the thing with its state; settings through a settings index (G1); unavailable commands dimmed with a reason in typed search only; the object-first Computers root (O1) with the rail as the type filter; `All computers...` from a window's deck on chan-desktop; the words of section 2.6 rule 5.

The thirty-five answers to `open-questions.md`, and the four given by survey at 2026-11-12T16:59Z (items 36 to 39, each the option the owner picked, in the survey's words). Each question is as that file states it, with the builder's pick, and each answer is verbatim. In item 3 the pick line carries a first-person clause ("if we were to use any, i'd pick shift+arrows...") that reads as the owner's own.

1. Launcher size ceiling. The Computers page's bundle went from 66.2 to 74.4 KiB gzipped (the new deck about 2.5, the object-first tree about 5.5), and I raised its ceiling from 68 to 78 KiB so it builds. Pick: accept 78; the growth is the surface you asked for, not an accidental import.
    Answer: sure let's bump
2. The rail sits on its own capsule with a caption under each orb, where the orbs used to float. Pick: keep; it is what makes the scopes readable.
    Answer: keep
3. Alt+1 to Alt+9 (jump to a scope) and Ctrl+N, Ctrl+P (move rows) are taken by some browsers, so they are dependable on chan-desktop only. Tab and the arrows work everywhere. Pick: keep them as extras; if we were to use any, i'd pick shift+arrows like we do in the computers window to switch cards with shift+left/right
    Answer: no need for extras
4. Esc closes from the root even with a scope chip showing; Backspace on an empty query removes the chip. Inside a branch Esc goes back one level. Pick: keep.
    Answer: keep
5. A toggle, a choice's option and a typed leaf such as `Theme: Dark` apply in place and leave the deck open; an action closes it. Pick: keep.
    Answer: keep
6. After a command runs the query is cleared; after Esc it is kept and selected at the next opening. Pick: keep.
    Answer: keep
7. Enter with Ctrl, Alt or Cmd held does nothing, reserving Alt+Enter for row actions (`Assign shortcut...`, `Show in Settings`), which are not built. Pick: build them next, after your first pass.
    Answer: sure but i dont know why we'd use these now, can't think of any case right now
8. A row that is off shows `off` in the deck and an empty check slot in a menu. Pick: keep both.
    Answer: keep both
9. Vocabulary in force: `File browser` (rail caption `Files`), `dock`, `Split down`, `Terminal engine (new terminals)` with `ghostty` and `xterm`, `Details`, `This machine`, `Command launcher`, `Flip pane`, `Reload window`, `Search workspace`, `Hybrid Nav`. Pick: as listed.
    Answer: as listed
10. Settings rows whose control needs its caption read `Heading: caption`: `Privacy mode: Also enable terminal secret masking`, `Dashboard carousel: Auto-rotate`, `Pane strip: Auto-hide`, `Keyboard navigation: Vim navigation`. Pick: reword those four headings in Settings so the heading alone names the toggle (`Mask terminal secrets in privacy mode`, `Dashboard auto-rotate`, `Pane strip auto-hide`, `Vim navigation`).
    Answer: yes as you suggest
11. New titles nobody has seen before: `Details (search)`, `Search again` (the search panel's old `Reload`), `Move divider left/right/up/down`, `Equalize panes`, `Present extension` (a toggle), `Select workspace` (graph; `Scope details` until the bring-forward), `Hidden files`, `Keyboard shortcuts (file browser)`, `Broadcast targets`, `Shown slides`, `Save draft`. Pick: keep, subject to your eye.
    Answer: keep
12. A draft's menu row reads `Save draft`; the close dialog still asks `Save to Workspace` or `Save to Disk`. Pick: leave the dialog, since it is answering where, and keep `Save draft` on the row.
    Answer: as you suggest
13. The editor tab menu's slider is captioned `Editor page width`, the Settings label, where it said `Page width`. Pick: keep the rule (same words as Settings).
    Answer: keep
14. 43 command ids are gone (the `X: value` rows became settings or single choices, duplicates were dropped), so a chord a user bound to one of them goes inert. Pick: at load, drop overrides for ids that no longer exist and say so once in the status line; no alias commands kept.
    Answer: as you recommend
15. `Secret masking` in Settings is a toggle in the deck, so "use the default" is reachable only in Settings. Pick: make it a choice of On, Off, Default.
    Answer: as you recommend
16. The deck's Recent section holds commands only, not settings rows or Computers rows. Pick: keep.
    Answer: keep
17. With no scope chosen, the end of the list shows every workspace and window of this machine under `Computers`. Pick: cut it to three rows (`New terminal window`, `Workspaces`, `Windows`) as branches; the full list stays in the Computers scope.
    Answer: as you suggest
18. In a window's Computers scope an off workspace is a disabled row saying `Turn the workspace on from the Computers screen`. Pick: keep; hiding it made it look deleted.
    Answer: keep
19. Typing `open` on a file browser tab lists `Open` (the selected file) and `Open...` (a path prompt). Pick: keep both; the dots tell them apart.
    Answer: keep both
20. `Download` and `Export to PDF` are not offered on a draft, in the editor's commands or its inspector. Pick: keep until someone needs it.
    Answer: let's add these
21. Every tab menu now ends with `Flip pane` (where the pane has sides) and `Close tab`, and every body menu ends with `Command launcher`. The dashboard and extension menus gained `Close tab`; the editor, graph, file browser and tree menus gained the launcher row. Pick: keep.
    Answer: keep
22. Toggle rows are a name with a check, so the three terminal body rows lost their icons (the check takes the slot). Pick: keep.
    Answer: keep
23. Terminal `Copy` as a command copies the whole scrollback when nothing is selected, as the menu row does, and the built-in copy and paste chords stay active after a rebind. Pick: an assigned chord copies the selection only; leave the built-ins.
    Answer: sure but i dont want to assign a new chord now.. users could do that if they wish
24. The file browser has no Details command; its toolbar button is still named `Toggle details`. Pick: add `Details` for the file browser, as the terminal and editor have.
    Answer: let's add Details of course
25. The file tree's `Download`, `Upload` and `Copy path` rows carry the command's title and still run their own code paths, which differ slightly from the command's (progress on desktop, the failure wording). Pick: fold each pair into one function before any real merge.
    Answer: fold!
26. Two file browser tabs in one pane no longer share hidden files, multi-select and the key list. Pick: keep; per tab is the less surprising rule.
    Answer: keep
27. Hybrid Nav help: its rows read the registry, its title shows this platform's chord (it said Cmd+. everywhere), and the six `Stage ...` rows keep their own words. Pick: keep, and lower-case the stage rows to match (`Stage file browser`).
    Answer: keep as you suggest
28. Seen in the captures and older than this work: several menu rows are plain buttons with no menu role (the whole editor body menu, six rows of the editor tab menu). Pick: fix in the same pass as item 25.
    Answer: fix!
29. With one machine the root skips the one-row `Computers` section and lists that machine's `Workspaces` and `Windows` directly. That is what you see on the test server, and on a desktop with no devservers. Pick: keep.
    Answer: keep
30. `Recent windows` records what the deck itself focused, showed or opened, in this session; the feed carries no focus time, so windows used from the cards do not count. Pick: keep for the prototype; a focus time in the feed is the real fix.
    Answer: sure
31. `Needs attention` lists every disconnected devserver, degraded or failed workspaces, and windows asking for attention. Pick: keep; drop devservers you disconnected on purpose if it proves noisy.
    Answer: keep
32. Not offered from the deck: editing a window's caption, bulk remove (still only through Select), generating a WireGuard key (inside the gateway form). `Select` is offered on chan-desktop only. Pick: add `Select` on the devserver page; leave the rest.
    Answer: as you suggest
33. The theme row still reads `Switch to light theme` / `Switch to dark theme`. Pick: make it `Theme`, a choice, like the window's.
    Answer: as you recommend
34. `All computers...` at the end of a window's Computers scope is wired for chan-desktop and cannot be seen on the test server. The typed query is not carried into the panel: the desktop's toggle takes no argument. Pick: try it on the Mac first; carry the query only if you miss it.
    Answer: sure
35. `Turn on and open` from a plain browser opens the window after the turn-on answers, outside the click, so a browser may block the popup. Pick: accept on the devserver page; chan-desktop is unaffected.
    Answer: sure
36. Computers page, `Theme`: the launcher's theme state knows light and dark only, so the row offers `Light` and `Dark`, where a window's Settings offers `System`, `Light`, `Dark`. Options: add System; Light and Dark as built (picking one pins it); Light and Dark with the showing theme a no-op.
    Answer: Add System (recommended)
37. chan-desktop, `All computers...`: a fourth row at the end of the unscoped list, or the Computers scope and typed search only.
    Answer: Fourth row on chan-desktop (recommended)
38. Computers page, `Select` from the deck: closes the deck (the checkboxes are on the page behind it), or stays open like other toggles.
    Answer: Closes the deck, as built (recommended)
39. After round three: start the merge-readiness work (shortcut table, browser checks, documents, review, gate) when the round is merged and green, or wait for another look first. Nothing is pushed or merged to main in either case.
    Answer: Start when round three is merged and green (recommended)

## What is owed

Owed before a merge to `main` when this draft was first written, with where each stands at `f791eb5c1`:

- `make shortcuts-check`: done. The table in `crates/chan/src/lib.rs` is regenerated, the `cs` help names rows by their present words, and the target passes in the scoped gate below.
- The small code debts the lanes reported: done, in the merge-readiness round's first lane and the fix round's smaller debts, as listed under "What was built".
- The browser checks: repaired, as listed under "What was built". Check 15 and checks 150 to 223 passed over `f791eb5c1` in the scoped gate: 63 passed, 0 failed, 1 skipped (220, which needs vim in the guest). The checks below 150 passed over the same tree: 66 passed, 0 failed, 0 skipped. 65 are in `int-gate-scoped-3.log`, where check 122 failed because the echo extension example it loads had never been built in that guest, and 122 passed in `int-gate-scoped-4.log` once it was. All 130 checks therefore ran on the tip, with 129 passed and 1 skipped. `scripts/e2e/desktop-observations/focus-open*` cannot run without chan-desktop and was not run.
- The documents: merged. `docs/extensions.md` now says where the launcher lists an extension (`361c59b6b`). Still for the owner: three hand-captured manual screenshots that show the earlier interface (`command-launcher-terminal.png`, `command-launcher-workspace.png`, `slides-editing.png`) and the manual's seven videos, which were not inspected.
- The review's findings: fixed, as listed under "What was built". The two rated high were each seen in headless Chrome in an isolated guest: M1 by browser check 93, red before its fix and green after (`int-check93-fx1.log`), and R1 by a screenshot harness that reads where focus is after each key, with focus outside the deck before the fix and inside throughout after. The others rest on the unit tests their commits name; R9 changed a comment alone. One finding is left as built for the owner: a theme pinned only in the Computers page's own storage is dropped when the desktop's config holds none, because the feed's null means System (D7).
- The gate: a scoped one passed over `f791eb5c1` in an isolated guest on 2026-11-12, with its logs under `dev/command-launcher-revamp/logs/`. `int-gate-scoped-1.log` has `make web-check` (svelte-check with 0 errors and 0 warnings in each package; vitest with 480 tests in web-shared, 915 in launcher, 9962 in workspace-app and 35 in profile; the launcher bundle at 75.1 KiB, 2.9 KiB under its 78 KiB ceiling), `make web-marketing-check`, `make shortcuts-check`, `make e2e-check`, `cargo fmt --check`, clippy and rustdoc with warnings denied for `chan`, `chan-shell`, `chan-server` and `chan-library`, `cargo test -p chan -p chan-shell` (708 passed, 0 failed, 1 ignored) and the browser checks above. `int-gate-scoped-2.log` has `make browser-smoke-lib-test`, with 67 passed. `make shell-check` passed on the host against the worktree (120 scripts; `host-shell-check-1.log`), since the guest's copy has no git metadata. `cargo test -p chan-desktop` ran in a desktop guest: 1025 passed as root (`desk-test-1.log`, where the 6 tests that need an unprivileged user fail), and those 6 passed when rerun unprivileged on the same binary (`desk-test-unpriv-1.log`). That run was at `93d675e7a`; no file under `desktop/` or `crates/` and none of the ten web files the desktop crate reads changed between it and the tip. The branch changes no desktop Rust, only `desktop/design.md`.
- Still owed, none of it run: the whole-tree `make pre-push`, the native desktop package, the Windows VM, and anything on macOS or in chan-desktop.
- The merge: nothing is pushed or merged. The branch merges onto `origin/main` at `8b7a54f18` without conflict. A trial merge into `v0129/int` at `4b752e94e` conflicts in 11 files: the graph panel and its commands and tests, the manual's graph and terminal pages, `crates/chan-shell/src/help.rs`, browser check 112, the workspace app's `design.md` and two launcher tests.

Owed to the owner's own hands, since none of it can be read off a guest:

- `All computers...` on chan-desktop. It is wired through the desktop's launcher toggle and was never seen: the test server is a devserver page. The typed query is not carried into the panel: item 34's pick was "try it on the Mac first; carry the query only if you miss it", and the answer was "sure".
- The deck and the menus in chan-desktop on WebKitGTK, WKWebView and WebView2. The files this draft was written from record readings in headless Chrome and in vitest, and none in chan-desktop.
- A checks brief for the owner's Mac is written at `dev/owner-mac-checks-command-deck.md`. It waits on the branch being pushed.

Left open by the answers, for a later row if wanted:

- Row actions on Alt+Enter (answer 7: not built, no case for them yet).
- A focus time in the window feed, so `Recent windows` counts windows used from the cards (answer 30).
- Dropping devservers disconnected on purpose from `Needs attention`, if it proves noisy (answer 31).
- `Turn on and open` from a plain browser opens its window outside the click and may be blocked (answer 35: accepted on the devserver page).
- A standalone terminal window loading chord overrides, the file browser menu's `Upload` target, a Details row in the file browser's menu, and whether `Open in new file browser` enters a directory: named in `build-spec.md` section 9.1 as not a lane's to decide.

## Unverified in this draft

- The owner's words. The first message and the words of the acceptance are not in `dev/command-launcher-revamp/`; only the phrases quoted above are. The answers are copied from `open-questions.md` by a script, and the four survey answers match the raw files under `/tmp/claude-1000/deck-int/surveys/`, which is a temporary directory.
- The proposal's counts marked (inv), and its three headless Chrome observations, were not repeated.
- "What was built" is read from the commit subjects of `8ded1bda9..bc7956d66` and from the code at that tip, not from the lanes' reports. Which lane wrote which commit is inferred from the merge commits and `build-spec.md`. The merge-readiness round and the fix round are read from the subjects and bodies of the 60 commits of `bc7956d66..f791eb5c1` that are not merges, from the diffs of the ones that change behaviour and from the documents the branch updated; no commit names a finding's id, so which finding a commit answers is matched here from its body against `review-findings.md`, whose own status line stops at the first fix lane's merge.
- "Seen in a browser" claims belong to the lead's captures (`dev/command-launcher-revamp/logs/shots-*.log`); this draft's author ran no browser.
- The gate's figures, the two headless Chrome observations, the desktop tests, the two merge readings and what has not run are the coordinator's, given for the refresh of 2026-11-12T21:34Z, which ran nothing. Of the logs cited, the summary lines of `int-gate-scoped-1.log`, `int-gate-scoped-2.log`, `int-check93-fx1.log` and `desk-test-1.log` were read and agree with the figures, with three limits: `desk-test-1.log` holds the run as root alone, so the unprivileged rerun of its 6 failures has no log cited here; `int-check93-fx1.log` holds the green run alone, not the red one before the fix; and the `make shell-check` step in `int-gate-scoped-1.log` exits 2 in the guest, the host run that passed having no log cited here. No log is cited for the focus harness. After the refresh the coordinator added `desk-test-unpriv-1.log` (the 6 rerun unprivileged, logged), `host-shell-check-1.log` (the host run, logged), and the results of `int-gate-scoped-3.log` and `int-gate-scoped-4.log`, so the first and third limits are closed.
- Item 10 of the desired contract is this draft's wording of what the review asked for and the fix round built, not the proposal's or the owner's.
- The target version, the item's file name and whether this is one row or several are the owner's.

## After the intake: the owner's answers and four changes, 2026-11-13

The lanes left thirteen behaviours as built for the owner to decide, none of them blocking. He answered them on 2026-11-13, after the intake. Each point is the lanes' wording, shortened where it ran long, and each answer is verbatim.

1. A confirmation card answered after another window changed the same setting acts on the row as it now reads.
    Answer: yes
2. An extension's iframe that focuses itself under the open deck is not caught by the deck's focus guard.
    Answer: ok, leave as known gap
3. Whether the `Open in new file browser` command should enter a selected directory as the tree's row does.
    Answer: leave as is
4. The file browser menu's `Upload` and the `Upload` command do not choose their target the same way.
    Answer: let's fix and unify
5. The file browser's own menu has no `Details` row. Its toolbar button and the `Details` command are there.
    Answer: let's add one
6. A standalone terminal window loads no saved shortcut overrides. This is the same on main.
    Answer: it should, let's add an item for next version
7. `Test screen lock` locks on the last loaded state when the read of the current state fails.
    Answer: sure
8. Save-first before `Download` and `Export to PDF` runs for every file tab, not only for drafts. It could be narrowed to drafts.
    Answer: let's narrow
9. The graph's `Open` on a directory node enters the directory.
    Answer: ok
10. `Launcher entry mode` is no longer a term in `CONTEXT.md`.
    Answer: ok
11. Adding `System` to the Computers page's `Theme` drops a theme pinned only in the launcher's own storage when the desktop config holds none (finding D7).
    Answer: let's fix
12. Privacy mode's terminal masking is its own Settings field, `Mask terminal secrets in privacy mode`.
    Answer: ok
13. `All computers...` does not carry the typed query into the panel.
    Answer: ok

The graph command's title `Select workspace` was not among the thirteen and stands as built.

Asked which one rule the file browser menu's `Upload` and the launcher's should share (point 4), he picked "Into a directory" over acting on the selection and over two titles: both upload into the directory in context, as the menu's row did, and replacing a file stays on that file's own row.

Built on those answers, on two branches cut from `ffa6772e3`, each read by an independent reviewer before its merge:

- Point 11, merged as `09d7a4f9e` (`b29a6956d`, with `9db5cffcb`, `36b4f2bca` and `7581ec2dd`). v0.128.0's launcher ignored an empty value from the desktop's theme feed and the rebuilt one reads it as `System`, so a pin held only in the page's storage went at the feed's first frame. The page now keeps its choice under a key of its own and reads v0.128.0's key as a prior pin until it has carried it over once: on chan-desktop into the desktop's store when that holds no theme (a store that holds a theme wins, as it did in v0.128.0), elsewhere into the page's own storage. `System` chosen afterwards stays `System`. A v0.128.0 user whose pin never reached the desktop's store sees one change: after the carry-over, this machine's windows with no workspace follow the pin too.
- Point 5, merged as `ac53b246b` (`279c66790`). A file browser tab's menu has a `Details` row after the key-list row: the command's title, a check that follows the tab's panel, the key the toolbar button shows, and the function the button and the key run. A docked file browser has none: it draws no panel and the command acts on the active tab.
- Point 8, merged as `ac53b246b` (`e052bf8ec`). `Download` and `Export to PDF` commit the editor's input and save first only for a draft (a workspace's draft, or a file under a standalone window's drafts directory), with the refusal when the save fails. Any other file is sent at once as the server holds it, which is what v0.128.0's Details panel did. This narrows the fix of finding M2 under "What was built".
- Point 4, merged as `ac53b246b` (`8d7f321d3`, with `2502850d6`). The launcher's `Upload` keeps its id and title and now reaches the file browser surface the selection commands act on, which runs what its menu's `Upload` row runs: the listed directory in a file browser tab, in a tree the selected directory or the selected file's directory, and with nothing selected the workspace's root, or the home directory in a standalone window. That last case is the one change to the menu's row, which uploaded into the filesystem root there. The command never raises the picker that replaces a file.

What these change in the text above. Under "What was built", `Download` and `Export to PDF` "saving what the editor shows first" now holds for drafts alone. Answer 25's one function per row holds for `Download` and `Copy path`; for `Upload` the launcher's command and the file browser menu's row are one function, while the rows on an entry keep the title and act on that entry: a directory's row and its Details upload into it, Workspace details into the root, and a file's row replaces the file (Details never offered a replace). Under "What is owed", finding D7 is fixed, and of the four things `build-spec.md` left undecided the `Upload` target and the `Details` row are built, `Open in new file browser` stays as it is, and a standalone terminal window loading chord overrides goes to the next version.

Limits recorded with these changes:

- An extension's iframe that focuses itself under the open deck is not caught by the deck's focus guard (point 2, a known gap on the owner's word).
- A pinned Computers theme can come back after `System` when a second storage on the same desktop store still holds a v0.128.0 pin that was never carried: a run that fell back to another port where `System` was chosen, then a run on the saved port again, or a plain browser on the desktop's loopback address. The store's empty value means both "never set" and "`System` chosen". Taken as a known limit for v0.129.0.
- A desktop store that refuses every write keeps the prior pin showing on the Computers page, with this machine's other windows on the system's theme, for as long as it refuses.
- The launcher's file browser commands that act on a selection, `Upload` now among them, follow the file browser surface focused last; pressing another pane's tab label does not move that.
- The file browser's `New` and `Paste` rows and the launcher's commands of those titles still choose different directories in a file browser tab, as `Upload` did.
- No guest can show chan-desktop's real config store or a native picker raised from the launcher; both are in the owner's Mac readings.
