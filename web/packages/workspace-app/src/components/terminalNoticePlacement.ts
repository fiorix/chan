type Box = Pick<DOMRect, "left" | "right" | "top" | "bottom">;

export const APP_STATUS_PILL_SELECTOR = "[data-app-status-pill]";

/** Right padding a full-width notice row needs so its right end stays clear
 * of the status pill. Zero when there is no pill or the boxes do not
 * intersect; otherwise the horizontal overlap plus `gap`. */
export function noticePillPad(notice: Box, pill: Box | null, gap = 8): number {
  if (pill === null) return 0;
  const overlapX = Math.min(notice.right, pill.right) - Math.max(notice.left, pill.left);
  const overlapY = Math.min(notice.bottom, pill.bottom) - Math.max(notice.top, pill.top);
  if (overlapX <= 0 || overlapY <= 0) return 0;
  return overlapX + gap;
}

/** Return the pane-relative top for a notice measured at its default position. */
export function terminalNoticeTop(notice: Box, status: Box | null, defaultTop: number): number {
  if (
    status === null ||
    notice.right <= status.left ||
    status.right <= notice.left ||
    notice.bottom <= status.top ||
    status.bottom <= notice.top
  ) return defaultTop;

  return defaultTop + status.bottom - notice.top + 5;
}
