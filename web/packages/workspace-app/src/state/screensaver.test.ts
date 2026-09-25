// @vitest-environment jsdom
//
// The screen lock's client surface: the /api/screensaver requests, the PIN
// hash the server stores and compares byte for byte, and the timeout range.

import { afterEach, describe, expect, test } from "vitest";
import { api } from "../api/client";
import {
  SCREENSAVER_DEFAULT_TIMEOUT_SECS,
  SCREENSAVER_MAX_TIMEOUT_SECS,
  SCREENSAVER_MIN_TIMEOUT_SECS,
  hashPin,
  type ScreensaverTheme,
} from "./screensaver";
import { json, recordRequests, stopRecordingRequests } from "../__tests__/fetch";

afterEach(stopRecordingRequests);

const STATE = { enabled: true, timeout_secs: 300, theme: "plain", pin_set: false };

describe("the screensaver requests", () => {
  test("state is read with GET /api/screensaver/state", async () => {
    const requests = recordRequests(() => json(STATE));

    await expect(api.screensaverState()).resolves.toEqual(STATE);
    expect(requests).toMatchObject([{ method: "GET", path: "/api/screensaver/state" }]);
  });

  test("a partial change, theme included, is a PATCH of just those fields", async () => {
    const requests = recordRequests(() => json({ ...STATE, theme: "matrix" }));
    await api.screensaverPatch({ theme: "matrix" });

    expect(requests).toMatchObject([
      { method: "PATCH", path: "/api/screensaver/state", body: { theme: "matrix" } },
    ]);
  });

  test("a PIN is set by POSTing its hash and cleared with DELETE", async () => {
    const requests = recordRequests(() => json(STATE));
    await api.screensaverSetPin("aGFzaA==");
    await api.screensaverClearPin();

    expect(requests).toMatchObject([
      { method: "POST", path: "/api/screensaver/pin", body: { hash: "aGFzaA==" } },
      { method: "DELETE", path: "/api/screensaver/pin" },
    ]);
  });

  test("verification POSTs the candidate hash and returns the server's verdict", async () => {
    const requests = recordRequests(() => json({ verified: true }));

    await expect(api.screensaverVerify("aGFzaA==")).resolves.toEqual({ verified: true });
    expect(requests).toMatchObject([
      { method: "POST", path: "/api/screensaver/verify", body: { hash: "aGFzaA==" } },
    ]);
  });
});

describe("the PIN hash", () => {
  test("is PBKDF2-SHA-256 over 100,000 iterations, salted with the workspace's SHA-256", async () => {
    // The server stores this digest and compares it byte for byte on every
    // unlock, so any change to the derivation locks out every PIN already set.
    const encoder = new TextEncoder();
    const salt = await crypto.subtle.digest("SHA-256", encoder.encode("/tmp/workspace-a"));
    const key = await crypto.subtle.importKey("raw", encoder.encode("1234"), "PBKDF2", false, [
      "deriveBits",
    ]);
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt, iterations: 100_000, hash: "SHA-256" },
      key,
      256,
    );
    const expected = btoa(String.fromCharCode(...new Uint8Array(bits)));

    await expect(hashPin("1234", "/tmp/workspace-a")).resolves.toBe(expected);
  });

  test("is deterministic for the same PIN and workspace", async () => {
    const a = await hashPin("1234", "/tmp/workspace-a");
    const b = await hashPin("1234", "/tmp/workspace-a");
    expect(a).toBe(b);
    // Base64 of 32 bytes = 44 chars including padding.
    expect(a).toHaveLength(44);
  });

  test("differs across workspaces for the same PIN", async () => {
    const a = await hashPin("1234", "/tmp/workspace-a");
    const b = await hashPin("1234", "/tmp/workspace-b");
    expect(a).not.toBe(b);
  });

  test("differs across PINs for the same workspace", async () => {
    const a = await hashPin("1234", "/tmp/workspace-a");
    const b = await hashPin("1235", "/tmp/workspace-a");
    expect(a).not.toBe(b);
  });

  test("still hashes with no workspace, on a fixed default salt", async () => {
    const hash = await hashPin("1234", "");
    expect(hash).toHaveLength(44);
  });
});

describe("the screensaver settings", () => {
  test("the timeout defaults to chan-workspace's 300 s", () => {
    expect(SCREENSAVER_DEFAULT_TIMEOUT_SECS).toBe(300);
  });

  test("the timeout ranges from 10 s to an hour", () => {
    expect(SCREENSAVER_MIN_TIMEOUT_SECS).toBe(10);
    expect(SCREENSAVER_MAX_TIMEOUT_SECS).toBe(60 * 60);
  });

  test("the theme is plain or matrix, the two the server stores", () => {
    const themes: ScreensaverTheme[] = ["plain", "matrix"];
    // @ts-expect-error a theme the server does not store
    const other: ScreensaverTheme = "neon";
    expect(themes).not.toContain(other);
  });
});
