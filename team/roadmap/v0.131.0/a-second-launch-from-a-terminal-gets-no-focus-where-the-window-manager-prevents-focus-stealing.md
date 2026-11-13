# A second launch from a terminal gets no focus where the window manager prevents focus stealing

Status: accepted for v0.131.0 by the owner on 2026-11-13; not started.

Record: found on 2026-11-12 by the worker that built v0.129.0's shared raise, in a Linux guest under metacity, at the base and at the fix's tip, and left unbuilt for the owner's word (`dev/v0129/row-notes.md`, "minraise: questions and follow-ups raised by the worker"; `dev/v0129/status.md`, 2026-11-12; readings `dev/v0129/evidence/minraise/build/readset-base-final.out` and `readset-tip.out`). The review of that change gave the follow-up's shape (`dev/v0129/reviews/review-minraise-1.md`, "Follow-up shape for focus-stealing prevention"). Recorded as not built in the shipped [raise row](../done/coming-forward-to-a-minimized-window-may-not-activate-the-app.md) ("Built") and among v0.129.0's follow-ups. At v0.130.0's planning the owner placed the later group of rows, this one among them, in v0.131.0: "yes v0.131" (`dev/v0130/status.md`).

## What is there now

Read at `342dbe791`; the GTK arm of the raise is unchanged since the readings (`git diff a4ac4a7b9 342dbe791 -- desktop/src-tauri/src/raise.rs` changes comments only).

- A second launch that finds the desktop running sends `Request::Activate` (`crates/chan-server/src/handoff.rs:238`, built by `activate_request`, 1997-2002), which carries a protocol number and a version and nothing of how the launch was started. Nothing in the desktop or the server reads `DESKTOP_STARTUP_ID` or `XDG_ACTIVATION_TOKEN`.
- The desktop answers with `come_forward` (`desktop/src-tauri/src/single_instance.rs:699-730`), which raises through `raise::raise_window` (`desktop/src-tauri/src/raise.rs:57-70`). On Linux tao 0.37.2's focus call presents the window with `GDK_CURRENT_TIME`, which GTK replaces with the time of the last input chan received; the module comment of `raise.rs` says so, and that a window manager that prevents focus stealing weighs that time against the user's last input elsewhere.
- Under metacity 3.58.1 in a guest, a second launch from a shell (no startup id) after the user clicked another window: with the chan window clicked before, restored 10 of 10 and focused 0 of 10, minimized or behind the other window, before and after v0.129.0's raise fix, the window left `_NET_WM_STATE_DEMANDS_ATTENTION`; with the chan window never clicked, focused 10 of 10 after the fix; under openbox, focused 10 of 10. GNOME's mutter on X11 is expected to behave as metacity; not read. Not read either: a second launch from the desktop's menu entry. `chan-desktop.desktop` names no `StartupNotify` and the `chan-term`, `chan-edit` and `chan-files` entries set it false (`packaging/distros/shared/`), so a launcher may give such a launch no id either.

## Desired contract

1. A second launch passes on the activation it was started with, `DESKTOP_STARTUP_ID` or `XDG_ACTIVATION_TOKEN`, in its request, and the desktop presents the raised window with it, so a window manager that prevents focus stealing gives that window the focus.
2. A launch that carries neither, from a terminal or from a menu entry that asks for no startup notification, gets the focus as well: it sends the time it was started at in the form a startup id carries one, which is later than the input that started it.
3. A desktop never presents with a time of its own making, so a raise nobody asked for gets no focus it would not get today; a desktop that predates the field still reads the request.

## Boundaries

- The `Activate` request gains one optional field (the enum has no `deny_unknown_fields`, so an older desktop parses it); the second launch's side in `single_instance.rs` reads its environment, and on X11 the X server's time when it has no id; `come_forward` and the GTK arm of `raise.rs` apply the id to the window before presenting it. The review's shape: an X11 id of the `_TIME<timestamp>` form for a launch with none.
- Rejected when v0.129.0's raise was built, and not here: presenting with the X server's current time from the running desktop, which defeats the window manager's rule.
- Not here: macOS and Windows, which the shipped raise row covers; a launch given paths (`OpenPath`) and `chan-term`'s `OpenTerminal`, which by reading meet the same rule and can take the same field once it exists; Wayland, where the token is the only route and nothing has been read.

## Acceptance

1. Tests: a request with the field and one without it both parse; the second launch puts its environment's id in the request, and a time-only id when it has none; the desktop applies the id it was given and none otherwise. Each red on the code without the change.
2. In an sdme guest, the raise reading of v0.129.0 (`dev/v0129/evidence/minraise/scripts/readset.sh`: openbox, metacity with the chan window clicked, metacity with it never clicked; three control cycles, ten minimized, ten behind) on the code without the change and with it: under metacity with the chan window clicked, focused 10 of 10 in both arms with the change where it is 0 of 10 without; the control cycles still focus nothing; the other sets as in v0.129.0's reading after its fix.
3. The same reading with the second launch given a `DESKTOP_STARTUP_ID`, as a desktop launcher sets one.
