type Box = Pick<DOMRect, "left" | "right" | "top" | "bottom">;

export const APP_STATUS_PILL_SELECTOR = "[data-app-status-pill]";

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
