# The desktop's New Window and Open in Browser copy the path a window stores, so a copy of a window stored outside its row stays outside it

Status: raised for a decision on 2026-09-28 by the lead, at the landing of the desktop's half of [a-relinked-root-window-nests-outside-its-row](a-relinked-root-window-nests-outside-its-row.md), whose order left the two menu commands out by the lead's ruling on its plan, with what that leaves to be raised at the landing (`dev/v0101-team/followups/followup-Lead-Services-29.md` in the development tree, approved 3; the plan's reading, `dev/v0101-team/followups/followup-Services-Lead-21.md`, leaning 4; the report's, `dev/v0101-team/reports/report-Services-36.md`, "Residuals"). Read at `d440ab656`; not run. Recommendation, the lead's: accept for v0.101.0 as a small order: the two commands store the root of the registry row that the window's path goes by, as the owner's ruling of 2026-09-26 has every mint site do. The lead's reason for leaving the two commands out of that order is below.

## What was seen

- **Both commands mint with the path of the window they start from.** New Window, Cmd or Ctrl+Shift+N, on a workspace window mints another window with the path that window's record stores (`open_new_window_for_label`, `desktop/src-tauri/src/main.rs:6454-6481`, the mint at `:6474-6478`), and Open in Browser mints a record for a browser tab with that path (`open_window_in_browser`, `:6399-6424`, the mint at `:6418-6419`). Neither looks the registry row up.
- **For a window this build opened, the copy nests.** The desktop's handoff, `serve::start` and `cs window new` mint a workspace window through the host's method, which stores the root the workspace's runtime was opened at, its registry row's (`crates/chan-library/src/host.rs:2571-2591`), and the command deck stores the row's root by a lookup of its own (`create_library_window`, `main.rs:4388-4408`; `local_workspace_path`, `:4336-4347`), so a copy of such a window stores the row's root as well.
- **For a window an earlier build stored under the path its root resolves to, the copy does not.** The desktop's handoff stored the key it resolved until this landing (`desktop/src-tauri/src/main.rs:2889`, `:2904` and `serve.rs:112` at `v0.100.0`). Such a window is not rewritten, by the lead's ruling of 2026-09-27 on the item above, and the launcher nests a window under a row by the equality of the two paths (`samePath`, `web/packages/launcher/src/lib/machineTree.ts:52-55`, `:103-112`), so it stays outside its row until it is closed, and a copy of it made by either command stores the same path and sits outside the row beside it (`crates/chan-library/design.md:48`). A copy numbers among the windows stored under that path (`next_ordinal`, `crates/chan-library/src/windows.rs:792-812`).
- **The owner's ruling of 2026-09-26 on the item above has every mint site store the registry row's root.** The lead ruled the two commands out of the order that built the desktop's sites, the owner's to overrule, because a copy of a window is what a user who duplicates a window asks for. To take them, the plan read, needs their mint lifted out of the two handlers first, since both take a concrete app handle and look the focused native window up (`followup-Services-Lead-21.md`, leaning 4).

## Desired contract

The owner's to choose: either a copy of a workspace window nests under its workspace's row whatever path its source stores, or a copy stores its source's path, and this item is withdrawn with that written in the design document.

## What to do

If the first: both commands mint through the host's method for a workspace window with the path their source stores, which stores the root of the workspace runtime or the registry row that goes by that path (`host.rs:2571-2591`), each with the origin it stamps today, after a refactor that lifts their mint into one function a test can call. Red first: New Window from a window stored under the canonical path of a relinked root opens a window stored under the row's root; today it stores the canonical path.

## Boundaries

`desktop/src-tauri/src/main.rs` (`open_new_window_for_label`, `open_window_in_browser`), the wrappers of `desktop/src-tauri/src/embedded.rs` that they mint through, their tests, and `desktop/design.md`. Windows that an earlier build stored are not rewritten.

## Acceptance

1. New Window and Open in Browser from a window stored under a relinked root's canonical path mint a record stored under the row's root, pinned red first.
2. A copy of a window stored under the row's root is unchanged, pinned.
