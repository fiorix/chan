/// The screen a reconciling replay starts on, as the session frame names it
/// in `replay_screen`: the screen the program had at the replay's first
/// byte.
export type ReplayScreen = "normal" | "alternate";

/// A session frame's `replay_screen`, or null when it names none (an attach
/// that does not reconcile, an older server, or a value this page does not
/// know).
export function replayScreenOf(value: unknown): ReplayScreen | null {
  return value === "normal" || value === "alternate" ? value : null;
}

/// What the switch reads of the view: its screen, and whether it entered the
/// alternate screen by mode 1049, which saved its cursor on the way in.
export type ViewScreen = { alternate: boolean; mode1049: boolean };

/// The bytes that take a view on `view` to the screen `to` before a replay
/// is written, or "" when the view is already there, so a redundant switch
/// is never written. Each starts with CAN, which ends any sequence the view
/// was left inside. Neither saves a cursor: the view's saved cursors are
/// the program's, and a replay may restore one.
///
/// To the normal screen, a view that entered by 1049 leaves by 1049, which
/// restores the cursor its own entry saved, as the program's exit would.
/// Any other view leaves by 1047 and 47, which restore none: a 1049 exit
/// there would move the cursor to whatever the normal screen saved last.
/// To the alternate screen, 1047 switches without saving and the erase
/// clears what an earlier program left there, as an entry by 1049 would.
export function replayScreenSwitch(view: ViewScreen, to: ReplayScreen): string {
  if (view.alternate === (to === "alternate")) return "";
  if (to === "alternate") return "\x18\x1b[?1047h\x1b[2J";
  return `\x18${view.mode1049 ? "\x1b[?1049l" : ""}\x1b[?1047;47l`;
}
