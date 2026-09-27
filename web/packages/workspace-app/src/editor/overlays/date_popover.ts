// Date popover. Click a date pill -> month-grid calendar + format
// dropdown + commit. Replaces the date range in source on commit;
// dismiss without commit is a no-op (the source stays).
//
// UI: a small body-attached popover positioned under the pill DOM.
//   - Header: <prev> Month YYYY <next> + format dropdown.
//   - 7-column grid: Mo Tu We Th Fr Sa Su day-of-week labels (start
//     of week is Monday - adjust if a future preference asks).
//   - Day cells highlight selected and today.
//   - Click a day to commit that date in the chosen format.
//   - Esc / outside click / scroll dismisses without commit.
//   - One popover at a time: opening another dismisses this one.
//
// Keep this surface intentionally small: no time-of-day, no range
// selection, no recurrence - we're a notes app.

import {
  DATE_FORMATS,
  formatDate,
  type DateFormatId,
} from "../dateFormats";

export interface DatePopoverOpts {
  /// The DOM element to anchor the popover under. Typically the date
  /// pill's wrap span.
  anchor: HTMLElement;
  initialDate: Date;
  initialFormatId: DateFormatId;
  /// Called with the formatted text the caller should write to the
  /// source. Caller owns the doc dispatch.
  onCommit: (formatted: string, formatId: DateFormatId) => void;
  /// Called when the user dismisses without committing.
  onDismiss: () => void;
  /// When true, the popover renders as a pure visualization: the
  /// format-row controls are omitted, day cells aren't clickable,
  /// keyboard navigation is disabled, and Enter / day-click never
  /// fire `onCommit`. Used by read-only surfaces (fs-locked file,
  /// user "read" toggle) where the date pill is informational only.
  readonly?: boolean;
}

const DOW_LABELS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
const ARROW_DELTAS: Record<string, number> = {
  ArrowLeft: -1,
  ArrowRight: 1,
  ArrowUp: -7,
  ArrowDown: 7,
};
const MONTH_LABELS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// The popover on screen. Each popover takes its keys from a capture
// listener on the document, where the one added first runs first and
// stops the event, so a second popover opened over this one would
// leave the covered calendar taking the arrows, Enter and Escape meant
// for the visible one.
let dismissCurrent: (() => void) | null = null;

export function openDatePopover(opts: DatePopoverOpts): { dismiss: () => void } {
  dismissCurrent?.();
  let selected = new Date(opts.initialDate);
  selected.setHours(0, 0, 0, 0);
  let viewMonth = new Date(selected.getFullYear(), selected.getMonth(), 1);
  let formatId = opts.initialFormatId;
  let alive = true;

  const wrap = document.createElement("div");
  wrap.className = "md-date-popover";
  wrap.style.position = "absolute";
  wrap.style.zIndex = "30000";
  document.body.appendChild(wrap);
  positionUnderAnchor();

  function positionUnderAnchor(): void {
    const rect = opts.anchor.getBoundingClientRect();
    const popH = wrap.offsetHeight; // 0 on first call (before render)
    const popW = wrap.offsetWidth;
    const viewH = window.innerHeight;
    const viewW = window.innerWidth;
    const GAP = 4;
    // Vertical: prefer below; flip above when below would overflow
    // and there's more room above.
    const spaceBelow = viewH - rect.bottom;
    const spaceAbove = rect.top;
    let top: number;
    if (popH > 0 && spaceBelow < popH + GAP && spaceAbove > spaceBelow) {
      // Flip above: anchor the popover's bottom to the pill's top.
      top = rect.top + window.scrollY - popH - GAP;
    } else {
      top = rect.bottom + window.scrollY + GAP;
    }
    // Horizontal: keep left-aligned with the pill, but clamp so the
    // popover stays inside the viewport.
    let left = rect.left + window.scrollX;
    if (popW > 0) {
      const maxLeft = window.scrollX + viewW - popW - GAP;
      if (left > maxLeft) left = Math.max(window.scrollX + GAP, maxLeft);
    }
    wrap.style.left = `${Math.round(left)}px`;
    wrap.style.top = `${Math.round(top)}px`;
  }

  function render(): void {
    wrap.innerHTML = "";
    // Header.
    const header = document.createElement("div");
    header.className = "md-date-header";
    const prev = makeIconBtn("‹", () => {
      viewMonth = new Date(viewMonth.getFullYear(), viewMonth.getMonth() - 1, 1);
      render();
    });
    const next = makeIconBtn("›", () => {
      viewMonth = new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 1);
      render();
    });
    const title = document.createElement("span");
    title.className = "md-date-title";
    title.textContent = `${MONTH_LABELS[viewMonth.getMonth()]} ${viewMonth.getFullYear()}`;
    header.appendChild(prev);
    header.appendChild(title);
    header.appendChild(next);
    wrap.appendChild(header);

    // Grid.
    const grid = document.createElement("div");
    grid.className = "md-date-grid";
    for (const dow of DOW_LABELS) {
      const cell = document.createElement("div");
      cell.className = "md-date-dow";
      cell.textContent = dow;
      grid.appendChild(cell);
    }
    // Compute leading blanks: getDay() returns 0=Sun..6=Sat. We start
    // weeks on Monday, so shift: (jsDay + 6) % 7.
    const firstDow = (viewMonth.getDay() + 6) % 7;
    for (let i = 0; i < firstDow; i++) {
      const blank = document.createElement("div");
      blank.className = "md-date-blank";
      grid.appendChild(blank);
    }
    const daysInMonth = new Date(
      viewMonth.getFullYear(),
      viewMonth.getMonth() + 1,
      0,
    ).getDate();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    for (let d = 1; d <= daysInMonth; d++) {
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = "md-date-day";
      cell.textContent = String(d);
      cell.tabIndex = -1;
      const cellDate = new Date(viewMonth.getFullYear(), viewMonth.getMonth(), d);
      cell.dataset.ts = String(cellDate.getTime());
      if (cellDate.getTime() === today.getTime()) {
        cell.classList.add("md-date-day-today");
      }
      if (cellDate.getTime() === selected.getTime()) {
        cell.classList.add("md-date-day-selected");
      }
      if (opts.readonly) {
        // Visual-only: disable the button so it doesn't capture
        // mousedown, and de-emphasize it visually (the .md-date-day
        // CSS already dims `:disabled` cells).
        cell.disabled = true;
      } else {
        cell.addEventListener("mousedown", (e) => {
          e.preventDefault();
          e.stopPropagation();
          selected = cellDate;
          commit();
        });
      }
      grid.appendChild(cell);
    }
    wrap.appendChild(grid);

    // Focus the currently-selected day so keyboard navigation has
    // a starting point. tabIndex was -1 on every cell; we promote
    // the focused one to 0 so it accepts focus + can be Tab'd in
    // when needed. setTimeout(0) pushes past CM6's own post-dispatch
    // focus-restore so the popover actually wins the focus race
    // - requestAnimationFrame wasn't late enough (the editor's
    // contentDOM was re-focused inside that frame).
    const focusCell = grid.querySelector<HTMLButtonElement>(
      `button.md-date-day[data-ts="${selected.getTime()}"]`,
    );
    if (focusCell) {
      focusCell.tabIndex = 0;
      setTimeout(() => {
        if (!alive) return;
        focusCell.focus({ preventScroll: true });
      }, 0);
    }

    // Format dropdown. Only relevant when committing back to the
    // doc; the read-only view (chat reply, fs-locked file, user
    // "read" toggle) hides this row since picking a format here
    // can't take effect.
    if (opts.readonly) {
      positionUnderAnchor();
      return;
    }

    const formatRow = document.createElement("div");
    formatRow.className = "md-date-format-row";
    const label = document.createElement("span");
    label.className = "md-date-format-label";
    label.textContent = "Format";
    formatRow.appendChild(label);
    const select = document.createElement("select");
    select.className = "md-date-format-select";
    for (const f of DATE_FORMATS) {
      const opt = document.createElement("option");
      opt.value = f.id;
      // Show the actual rendering for the currently-selected date
      // so users see exactly what they'd commit.
      opt.textContent = formatDate(selected, f.id);
      if (f.id === formatId) opt.selected = true;
      select.appendChild(opt);
    }
    select.addEventListener("change", () => {
      formatId = select.value as DateFormatId;
      // Picking a format commits immediately - the user just told us
      // how they want the date written. Without this, changing the
      // dropdown was a silent no-op until the user also clicked a
      // day, which most users didn't expect.
      commit();
    });
    formatRow.appendChild(select);

    // US ↔ rest-of-world flip for the numeric slash format. Only
    // active when the current format is one of the two slash
    // variants; otherwise the button is disabled so the layout
    // doesn't reflow as the user clicks through the dropdown.
    const flip = document.createElement("button");
    flip.type = "button";
    flip.className = "md-date-region-flip";
    flip.title = "Swap day/month order (DD/MM ↔ MM/DD)";
    const isSlash = formatId === "dmy-slash" || formatId === "mdy-slash";
    flip.textContent = formatId === "mdy-slash" ? "MM/DD" : "DD/MM";
    flip.disabled = !isSlash;
    flip.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!isSlash) return;
      formatId = formatId === "dmy-slash" ? "mdy-slash" : "dmy-slash";
      commit();
    });
    formatRow.appendChild(flip);

    wrap.appendChild(formatRow);
    positionUnderAnchor();
  }

  function commit(): void {
    if (!alive) return;
    const formatted = formatDate(selected, formatId);
    dismiss();
    opts.onCommit(formatted, formatId);
  }

  function dismiss(): void {
    if (!alive) return;
    alive = false;
    if (dismissCurrent === dismiss) dismissCurrent = null;
    document.removeEventListener("mousedown", outsideClick, true);
    document.removeEventListener("keydown", escListener, true);
    window.removeEventListener("scroll", dismiss, true);
    wrap.remove();
    opts.onDismiss();
  }

  function outsideClick(e: MouseEvent): void {
    if (wrap.contains(e.target as Node)) return;
    dismiss();
  }

  function escListener(e: KeyboardEvent): void {
    if (!alive) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopImmediatePropagation();
      dismiss();
      return;
    }
    // Read-only mode: keyboard nav and Enter-commit are off (the
    // popover is purely visual). Esc above still closes.
    if (opts.readonly) return;
    // Arrow-key navigation: shift the selected date by a day / week.
    // Crossing month boundaries jumps the view-month to the new
    // date's month and re-renders. Enter commits whichever cell is
    // selected.
    // stopImmediatePropagation is required: this listener lives in
    // the capture phase (see addEventListener below), so CM6 still
    // sees the event by default - and CM6's keymap would move the
    // editor cursor on ArrowDown / insert a newline on Enter even
    // after we preventDefault'd. stopping propagation here keeps
    // the keys exclusively for the popover.
    const delta = ARROW_DELTAS[e.key];
    if (delta !== undefined) {
      e.preventDefault();
      e.stopImmediatePropagation();
      const next = new Date(
        selected.getFullYear(),
        selected.getMonth(),
        selected.getDate() + delta,
      );
      selected = next;
      if (
        next.getFullYear() !== viewMonth.getFullYear() ||
        next.getMonth() !== viewMonth.getMonth()
      ) {
        viewMonth = new Date(next.getFullYear(), next.getMonth(), 1);
      }
      render();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopImmediatePropagation();
      commit();
    }
  }

  // Defer outside-click wiring so the click that opened the popover
  // doesn't immediately count as outside.
  window.setTimeout(() => {
    if (!alive) return;
    document.addEventListener("mousedown", outsideClick, true);
    document.addEventListener("keydown", escListener, true);
    window.addEventListener("scroll", dismiss, true);
  }, 0);

  render();
  dismissCurrent = dismiss;
  return { dismiss };
}

function makeIconBtn(label: string, onClick: () => void): HTMLElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "md-date-nav";
  btn.textContent = label;
  btn.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    onClick();
  });
  return btn;
}
