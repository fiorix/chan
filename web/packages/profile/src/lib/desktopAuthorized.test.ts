import { describe, expect, it } from "vitest";

import { takeDesktopAuthorized } from "./desktopAuthorized";

describe("takeDesktopAuthorized", () => {
  it("reports the marker and strips it from the URL", () => {
    expect(
      takeDesktopAuthorized("https://gw.chan.app/profile?desktop_authorized=1"),
    ).toEqual({ authorized: true, href: "/profile" });
  });

  it("leaves a URL without the marker untouched", () => {
    const href = "https://gw.chan.app/profile";
    expect(takeDesktopAuthorized(href)).toEqual({ authorized: false, href });
  });

  it("keeps the other query params and the hash", () => {
    expect(
      takeDesktopAuthorized(
        "https://gw.chan.app/profile?desktop_authorized=1&d=abc#tokens",
      ),
    ).toEqual({ authorized: true, href: "/profile?d=abc#tokens" });
  });

  it("ignores a marker that is not exactly 1", () => {
    // The desktop only ever sends `=1`; anything else is someone else's
    // query param and must not raise the notification.
    for (const raw of ["0", "", "true", "11"]) {
      const href = `https://gw.chan.app/profile?desktop_authorized=${raw}`;
      expect(takeDesktopAuthorized(href).authorized, raw).toBe(false);
    }
  });
});
