// chan-desktop's loopback listener redirects the browser back to this
// origin once it holds the authorization code, marking the landing URL so
// the dashboard can say the sign-in worked.
//
// Reading the marker is one-shot: it is stripped from the URL right away,
// because App.svelte writes tab changes with `history.replaceState` and
// that preserves the query, so an unstripped marker would ride every tab
// click, every reload, and any URL the user copies out of the bar.

export const DESKTOP_AUTHORIZED_PARAM = "desktop_authorized";

export type DesktopAuthorizedMarker = {
  /// True when this load came from a completed desktop authorization.
  authorized: boolean;
  /// What to replace the current history entry with. Identical to the
  /// input when there was no marker to strip.
  href: string;
};

/// Read the marker out of an absolute URL and return the URL without it.
/// Pure, so the caller owns the single `history.replaceState` call.
export function takeDesktopAuthorized(href: string): DesktopAuthorizedMarker {
  const url = new URL(href);
  if (url.searchParams.get(DESKTOP_AUTHORIZED_PARAM) !== "1") {
    return { authorized: false, href };
  }
  url.searchParams.delete(DESKTOP_AUTHORIZED_PARAM);
  return { authorized: true, href: url.pathname + url.search + url.hash };
}
