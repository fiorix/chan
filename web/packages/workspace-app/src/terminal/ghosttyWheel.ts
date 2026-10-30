/// Wheel input for a terminal app that owns the wheel under the Ghostty
/// backend: one with mouse tracking on (wheel reports), or one on the
/// alternate screen without it (up/down arrows). Paced like xterm.js 6, which
/// the xterm.js backend uses for the same two cases. ghostty-web's own
/// alternate-screen path sends up to five arrows per wheel event
/// (|deltaY| / 33, nothing carried), so a trackpad swipe, dozens of events,
/// floods the app. xterm.js turns pixel deltas into rows, scales a trackpad's
/// small deltas down, carries the fraction to the next event, and sends at
/// most one report or arrow per event once a whole row has built up.

// WheelEvent.DOM_DELTA_PIXEL / DOM_DELTA_PAGE; literals so the module never
// touches the WheelEvent global (absent in some test environments).
const DOM_DELTA_PIXEL = 0;
const DOM_DELTA_PAGE = 2;

/// xterm.js reads a pixel delta under this magnitude as a trackpad's and
/// scales it by TRACKPAD_SCALE.
const TRACKPAD_DELTA = 50;
const TRACKPAD_SCALE = 0.3;

export type GhosttyWheelInput = Pick<WheelEvent, "deltaY" | "deltaMode" | "shiftKey">;

/// The row arithmetic of xterm.js's CoreMouseService.consumeWheelEvent at
/// the default scroll sensitivity. One per terminal: the carried fraction
/// belongs to that terminal's gesture.
export class GhosttyWheelRows {
  private partial = 0;

  /// Whole rows this event scrolls, negative upward, with the fraction left
  /// by earlier pixel events carried in. 0 means the event sends nothing.
  /// `cellHeight` is in CSS pixels; `rows` sizes a page delta.
  consume(e: GhosttyWheelInput, cellHeight: number, rows: number): number {
    if (e.deltaY === 0 || e.shiftKey) return 0;
    if (!(cellHeight > 0)) return 0;
    let amount = e.deltaY;
    if (e.deltaMode === DOM_DELTA_PIXEL) {
      amount /= cellHeight;
      if (Math.abs(e.deltaY) < TRACKPAD_DELTA) amount *= TRACKPAD_SCALE;
      this.partial += amount;
      amount = Math.trunc(this.partial);
      this.partial %= 1;
    } else if (e.deltaMode === DOM_DELTA_PAGE) {
      amount *= rows;
    }
    return amount;
  }
}

/// The arrow a wheel step sends to an alternate-screen app without mouse
/// tracking: SS3 under application cursor keys (DECCKM), CSI otherwise.
export function ghosttyWheelArrow(up: boolean, applicationCursorKeys: boolean): string {
  return `\x1b${applicationCursorKeys ? "O" : "["}${up ? "A" : "B"}`;
}
