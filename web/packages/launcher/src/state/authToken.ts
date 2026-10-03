// The launcher's loopback bearer. Headless callers have no location, and an
// empty value leaves the desktop side channels on same-origin auth.
export function authToken(): string {
  try {
    return new URLSearchParams(location.search).get("t") ?? "";
  } catch {
    return "";
  }
}
