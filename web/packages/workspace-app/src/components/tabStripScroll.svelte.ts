// The scrolling of a pane's tab strip. The strip's tabs sit in a viewport of
// their own, so the actions after it stay at the strip's end while the tabs
// scroll. While the tabs need more room than the viewport has, the strip
// draws a scroll button on each side of it; each pages the tabs toward its
// side and reads as disabled once the tabs reach that end. A vertical wheel
// over the tabs scrolls them sideways, a drag held over a scroll button
// scrolls the tabs that way so a drop can reach a hidden place, and the
// active tab is brought into view by its nearest edge.

/// A tab brought into view keeps this much room from the viewport's edge,
/// the row's own padding, so its ring and hover lift stay clear of the clip.
const REVEAL_MARGIN_PX = 4;

/// A button press pages by this share of the viewport, so the tab cut at
/// the edge stays in view as the first one past it.
const PAGE_SHARE = 0.8;

/// A drag held over a scroll button scrolls the tabs at this speed.
const DRAG_SCROLL_PX_PER_MS = 0.4;

/// One wheel line in CSS px, for a wheel that reports lines.
const WHEEL_LINE_PX = 16;

const DOM_DELTA_LINE = 1;
const DOM_DELTA_PAGE = 2;

type Direction = -1 | 1;

type DragScroll = { direction: Direction; last: number; carry: number; frame: number };

export class TabStripScroll {
  /// The tabs need more room than the viewport offers without the buttons.
  overflow = $state(false);
  /// The tabs can scroll toward the start.
  back = $state(false);
  /// The tabs can scroll toward the end.
  forward = $state(false);

  #view: HTMLElement | null = null;
  #width = -1;
  #activeInView = false;
  #buttons = new Set<HTMLElement>();
  #drag: DragScroll | null = null;

  /// Attachment for the viewport: the element that scrolls, holding the row
  /// of tabs as its one child. Its size and the row's are observed, so a
  /// resize or a tab coming, going or changing width is measured again.
  attach = (view: HTMLElement): (() => void) => {
    this.#view = view;
    this.#width = -1;
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => this.#resized(view));
    observer?.observe(view);
    if (view.firstElementChild) observer?.observe(view.firstElementChild);
    const measure = () => this.measure();
    view.addEventListener("scroll", measure, { passive: true });
    view.addEventListener("wheel", this.#wheel, { passive: false });
    document.addEventListener("dragend", this.stopDragScroll);
    document.addEventListener("drop", this.stopDragScroll, true);
    return () => {
      observer?.disconnect();
      view.removeEventListener("scroll", measure);
      view.removeEventListener("wheel", this.#wheel);
      document.removeEventListener("dragend", this.stopDragScroll);
      document.removeEventListener("drop", this.stopDragScroll, true);
      this.stopDragScroll();
      if (this.#view === view) this.#view = null;
    };
  };

  /// Attachment for a scroll button, whose width is the room the tabs give
  /// up while the buttons show.
  button = (node: HTMLElement): (() => void) => {
    this.#buttons.add(node);
    return () => {
      this.#buttons.delete(node);
    };
  };

  /// Read the viewport into `overflow`, `back` and `forward`.
  measure(): void {
    const view = this.#view;
    if (!view) return;
    // The buttons take their room from the viewport, so with them showing
    // the tabs still overflow only when they would without them.
    const room = view.clientWidth + (this.overflow ? this.#buttonsRoom(view) : 0);
    const overflow = view.scrollWidth > room + 1;
    const end = view.scrollWidth - view.clientWidth;
    this.overflow = overflow;
    this.back = overflow && view.scrollLeft > 1;
    this.forward = overflow && view.scrollLeft < end - 1;
    this.#activeInView = activeInView(view);
  }

  /// Scroll the active tab into view by its nearest edge; a tab already in
  /// view moves nothing. A tab wider than the viewport shows its start.
  reveal(): void {
    const view = this.#view;
    if (!view || view.clientWidth === 0) {
      this.measure();
      return;
    }
    const tab = view.querySelector<HTMLElement>(".tab.active");
    if (tab) {
      const box = view.getBoundingClientRect();
      const rect = tab.getBoundingClientRect();
      const start = box.left + REVEAL_MARGIN_PX;
      const end = box.left + view.clientWidth - REVEAL_MARGIN_PX;
      if (rect.left < start) view.scrollLeft -= start - rect.left;
      else if (rect.right > end) view.scrollLeft += Math.min(rect.right - end, rect.left - start);
    }
    this.measure();
  }

  /// Page the tabs toward `direction`.
  page(direction: Direction): void {
    const view = this.#view;
    if (!view) return;
    const reduce = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    view.scrollBy({ left: direction * view.clientWidth * PAGE_SHARE, behavior: reduce ? "auto" : "smooth" });
  }

  /// Scroll toward `direction` every frame until the tabs reach that end,
  /// the drag leaves the button, or the drag ends.
  startDragScroll(direction: Direction): void {
    if (this.#drag?.direction === direction) return;
    this.stopDragScroll();
    const drag: DragScroll = { direction, last: performance.now(), carry: 0, frame: 0 };
    const step = () => {
      const view = this.#view;
      if (this.#drag !== drag || !view) return;
      // A frame that comes late (a busy main thread, a hidden page) moves
      // no further than a short one would.
      const now = performance.now();
      drag.carry += direction * DRAG_SCROLL_PX_PER_MS * Math.min(Math.max(now - drag.last, 0), 64);
      drag.last = now;
      const whole = Math.trunc(drag.carry);
      if (whole !== 0) {
        view.scrollLeft += whole;
        drag.carry -= whole;
      }
      const end = view.scrollWidth - view.clientWidth;
      if (direction < 0 ? view.scrollLeft <= 0 : view.scrollLeft >= end - 0.5) {
        this.#drag = null;
        return;
      }
      drag.frame = requestAnimationFrame(step);
    };
    this.#drag = drag;
    drag.frame = requestAnimationFrame(step);
  }

  stopDragScroll = (): void => {
    if (this.#drag) cancelAnimationFrame(this.#drag.frame);
    this.#drag = null;
  };

  // The viewport's own width changes when the strip shows, moves into the
  // window tab bar, resizes or gains its buttons, and the active tab is
  // brought back into view then. Inside a viewport of the same width a tab
  // that grows (a terminal's title arriving, a long label's fade) keeps the
  // active tab in view only when it was in view, so tabs the user scrolled
  // to stay put.
  #resized(view: HTMLElement): void {
    const keep = this.#activeInView;
    const widthChanged = view.clientWidth !== this.#width;
    this.#width = view.clientWidth;
    if (widthChanged || keep) this.reveal();
    else this.measure();
  }

  /// The span the buttons cover, less the viewport between them.
  #buttonsRoom(view: HTMLElement): number {
    let left = Infinity;
    let right = -Infinity;
    for (const button of this.#buttons) {
      const rect = button.getBoundingClientRect();
      left = Math.min(left, rect.left);
      right = Math.max(right, rect.right);
    }
    if (right < left) return 0;
    return Math.max(0, right - left - view.getBoundingClientRect().width);
  }

  // Trackpads report a sideways swipe as deltaX and scroll the viewport
  // natively; a wheel that turns vertically is sent sideways here, while the
  // tabs overflow. A pinch arrives with ctrlKey and is left to the page.
  #wheel = (e: WheelEvent): void => {
    const view = this.#view;
    if (!view || e.ctrlKey || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    if (view.scrollWidth <= view.clientWidth) return;
    e.preventDefault();
    const unit =
      e.deltaMode === DOM_DELTA_LINE ? WHEEL_LINE_PX : e.deltaMode === DOM_DELTA_PAGE ? view.clientWidth : 1;
    view.scrollLeft += e.deltaY * unit;
  };
}

/// Whether the viewport shows the whole of its active tab.
function activeInView(view: HTMLElement): boolean {
  const tab = view.querySelector<HTMLElement>(".tab.active");
  if (!tab || view.clientWidth === 0) return false;
  const box = view.getBoundingClientRect();
  const rect = tab.getBoundingClientRect();
  return rect.left >= box.left - 0.5 && rect.right <= box.left + view.clientWidth + 0.5;
}
