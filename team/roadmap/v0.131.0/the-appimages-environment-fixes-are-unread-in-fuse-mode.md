# The AppImage's environment fixes are unread in FUSE mode

Status: accepted for v0.130.0 by the owner on 2026-11-13 and moved by him to v0.131.0 the same day, at v0.130.0's planning; not started. Its first step is the reading below, on a host that can mount FUSE.

Record: the reading was owed before v0.129.0's release by [the chan-term row](../done/the-default-terminal-is-chan-desktop-under-flags-of-its-own.md), its last section, "Not read: FUSE mode". On the list of what stood before the v0.129.0 tag, which named the AppImage under FUSE, the owner moved it to the next version: "appimage: move to next version yes".

## What is there now

v0.129.0 changed what chan's AppImage hands the processes it starts: the desktop's re-exec onto the system GTK and WebKit and the marker that says it was made, the search paths a terminal gets back, the environment from which a desktop, a New Window sibling, a devserver and the relaunch after an update start, the `PATH` a devserver unit records, and the boot dropping an older parent's blocks (the chan-term row, from the section "Readings after the merge" on). Every AppImage-level run of that work was in extract-and-run mode, since the round's guests have no `/dev/fuse`. In that mode every process of one file shares one directory, and another mount cannot be told from this one by its path, so what the row says of separate mounts is read from the code and from AppRun's shapes.

## Evidence

- `dev/v0129/reviews/chan-term-runs-2.md`, `dev/v0129/reviews/chan-term-runs-3.md` and the review of the last fix round, `dev/v0129/reviews/review-termfix-7.md`: every AppImage-level run in extract-and-run mode, in guests without FUSE.
- The chan-term row's release notes say of the FUSE case "read from the code, not run".
- Tauri's AppImage detection only warns in extract-and-run mode, so `chan upgrade` and the in-app update's relaunch have not run as a FUSE AppImage runs them, and the v0.128.0 to v0.129.0 update's relaunch was read from the code (the chan-term row, "An older release starting this one").

## Desired contract

1. Every item of the list below is read on a host with FUSE, against the AppImage of the release under test, with what it printed recorded in this row.
2. An item that fails is a defect of the AppImage's environment: it gets a fix with a test, or a row of its own if it is larger.

## The list, as the chan-term row left it

- A desktop started from the AppImage file: its executable under `$APPDIR`, `~/.local/bin/chan` naming the AppImage, the system GTK and WebKit mapped, `chan upgrade --check` not refused (Tauri's AppImage detection only warns in extract-and-run mode), `chan serve .` from another directory serving that directory, and a cold start and a New Window each starting the `.AppImage` file with a mount of its own and none of its parent's.
- A terminal: none of `PATH`, `LD_LIBRARY_PATH` (unset when the user had none), `XDG_DATA_DIRS`, `PYTHONPATH`, `PYTHONHOME`, the GStreamer paths, `PYTHONDONTWRITEBYTECODE`, `GTK_THEME`, `GDK_BACKEND`, `APPDIR`, `APPIMAGE`, `ARGV0` or `OWD` names a `/tmp/.mount_` directory.
- Mount lifetime: the children of a quit desktop do not search its vanished mount, and the runtime's keepalive outlives chan's descendants.
- An older parent: a v0.128.0 desktop running, the file replaced, a sibling or a cold start from it, and the relaunch of the in-app update and of `chan upgrade`, which no run has made; the new desktop's own `PATH`, `LD_LIBRARY_PATH`, `QT_PLUGIN_PATH` and `GST_PLUGIN_SYSTEM_PATH_1_0` hold only its own mount.
- A devserver unit v0.128.0 wrote from the AppImage loses its block at the first start without a terminal.
- A chan-desktop from a deb started from a real FUSE AppImage's shell: its `~/.local/bin` shims are symlinks, the foreign file is unchanged, nothing re-execs and the upgrade is refused.
- How the runtime spells `$APPDIR` for a FUSE mount under a link-named `TMPDIR` or one that ends in a separator, with a terminal's `LD_LIBRARY_PATH` unset and no `PYTHONHOME` there; and `OWD`, which only the FUSE runtime sets.

## Boundaries

- A reading first: nothing is built for this row before an item fails.
- The Linux x86_64 AppImage run as a user runs it, mounted through FUSE. Extract-and-run mode is what the v0.129.0 runs read and is not repeated here.

## Acceptance

1. Each item of the list read on a host with FUSE against the AppImage of the release under test, with the v0.128.0 AppImage as the older parent where an item names one, and the output recorded.
2. Every failure fixed with a test that fails without the fix, or carried as a row of its own, before this row closes.
