# The File Browser shows a tree with no directory navigation or keyboard model

Status: shipped in [v0.117.0](../../release/release-v0.117.0.md); built on `v0117/file-browser-ui` by the owner's agent, read in Chromium by its builder, `make web-check` green, and the gate of the GA commit green over it. The browser suite's file-browser checks still drive the tree the Files tab no longer shows and fail on their selectors (the v0.118.0 row [filesel](browser-checks-drive-the-files-tree-the-directory-view-replaced.md)); native macOS and Windows shortcuts and screen-reader announcements are not read.

Record before the release: built on `v0117/file-browser-ui` by the owner's agent on 2026-10-31 as `520ee28b5`, off the `v0117/terminal-opacity` tip, and merged into the release for v0.117.0 by the owner's word of 2026-10-31 ("i want to include v0117/file-browser-ui in this release as well"); recorded as an item at the cut, since the work was built without one. Read in Chromium by its builder; `make web-check` green on the branch and the GA commit's gate green over the merged tree. The browser suite's file-browser checks still drive the tree the Files tab no longer shows (see Verification).

## What was asked

The owner's agent built, on the owner's direction, a Files tab that shows one directory at a time instead of one expandable tree: breadcrumbs, back and forward history, an editable path, a filename filter, folder-first sorting, a locations rail in wide panes, and a keyboard model with desktop keys and an optional Vim map. Docked File Browser surfaces keep their compact tree.

## Evidence

Before the change a Files tab rendered the workspace as one expandable tree with the selection and expansion state shared across surfaces, no history and no path entry, and keyboard navigation limited to what the tree offered. The agent's commit message records the ask and the shape built.

## Desired contract

- A Files tab shows the current directory with breadcrumbs, back and forward navigation (Alt+Left, Alt+Right, Alt+Up to the parent), a path field and a filename filter; directories sort first; sort by Name, Kind, Size or Modified. A double-click on a directory enters it and on a file opens it. Details is explicit: selecting another row keeps a closed inspector closed. A locations rail appears in wide panes; docked browsers retain the expandable tree.
- Each Files surface owns its cursor, selected set, range anchor and expansion state. The last focused surface supplies existing commands through the browser selection facade. A browser tab serializes its directory, sort, selected paths, scroll position and inspector settings with the layout; history and directory filters last for the mounted surface.
- Keyboard: one composite-widget Tab stop with active-descendant focus; arrows, Home, End, Page Up and Page Down move; Enter opens; Left goes to the parent (or collapses a tree branch), Right enters (or expands); Shift extends the selection; F8 enters independent marks toggled with Space, Escape leaves the mode and a second Escape clears the selection; Mod+A selects all; Mod+C, Mod+X and Mod+V copy, cut and paste files; F2 renames; Delete asks to delete; Shift+F10 opens the entry's action menu, worked with arrows, Home and End, Escape returning focus to its opener; Mod+Y toggles Details; `/` or Mod+F focuses the filter; typing a filename prefix moves to it.
- The optional Vim map (h/j/k/l, gg/G, y/x/p, v for selection mode) is a local browser preference kept in localStorage, enabled from the browser menu or Settings > Keyboard navigation, applied only while the file list or tree has focus; text fields and terminals keep their own bindings. A Standard keys or Vim keys button shows the shortcut reference.

## Boundaries

`web/packages/workspace-app/src/components/FileBrowserSurface.svelte`, `FileTree.svelte`, `HamburgerMenu.svelte` (keyboard menus), `settings/BrowserSection.svelte`, the state modules `state/browserEntries.ts`, `state/browserKeymap.ts`, `state/browserKeys.svelte.ts`, `state/store.svelte.ts` and `state/tabs.svelte.ts`, the workspace app's `design.md`, and the manual's Files page. No server change.

## Acceptance

1. A Files tab opened in a workspace shows the root directory as a list with breadcrumbs and the filter; entering a directory and going back restores the previous listing; the path field accepts a path under the root.
2. The keyboard model above works in a Files tab and in a docked tree; the Vim toggle changes the map for the window's browser and survives a reload of that browser.
3. The browser suite's file-browser checks pass against the Files tab, or are migrated to the directory view where they drove the tree.

## Verification

By the builder, recorded in the commit message of `520ee28b5`: `make web-check`; focused tests after the final reveal and reload fixes; a typecheck and the production build; Chromium checks of navigation, ranges, menus, clipboard, rename, responsive layouts, media, dock coexistence, the Vim preference and a fresh-window restoration. Tests cover directory loading and reloads, selection, keyboard dispatch, menus, operations, tab cloning and layout state. Known gaps the builder recorded: native macOS and Windows shortcuts and screen-reader announcements are not read, and the browser suite's tree selectors were not migrated for Files tabs, so the full browser suite was not run on the branch.

At the cut, 2026-10-31: the whole browser suite ran in the Linux sdme guest against the merged release tree; its result and the attribution of each red are in the v0.117.0 release report. Acceptance 3 is open and carried as the v0.118.0 row [filesel](browser-checks-drive-the-files-tree-the-directory-view-replaced.md).
