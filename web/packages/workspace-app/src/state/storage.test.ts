// localStorage's two shared answers. The probe says whether the store takes
// a write, with the caller's own key and leaving nothing behind. The flag
// reader maps the on and off words to a boolean, falls back for anything
// else, and reads false when there is no store to read.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { isStorageAvailable, readStorageFlag } from "./storage";

const PROBE = "__storage_test_probe__";
const FLAG = "storage.test.flag";

beforeEach(() => {
  localStorage.removeItem(PROBE);
  localStorage.removeItem(FLAG);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/// The store's method table, whichever Storage the environment installed.
function storageMethods(): Storage {
  return Object.getPrototypeOf(localStorage) as Storage;
}

describe("isStorageAvailable", () => {
  test("a working store answers true and keeps no probe key", () => {
    expect(isStorageAvailable(PROBE)).toBe(true);
    expect(localStorage.getItem(PROBE)).toBeNull();
  });

  test("probes with the caller's own key", () => {
    const setItem = vi.spyOn(storageMethods(), "setItem");
    const removeItem = vi.spyOn(storageMethods(), "removeItem");

    isStorageAvailable(PROBE);

    expect(setItem).toHaveBeenCalledExactlyOnceWith(PROBE, "1");
    expect(removeItem).toHaveBeenCalledExactlyOnceWith(PROBE);
  });

  test("no store answers false", () => {
    vi.stubGlobal("localStorage", undefined);

    expect(isStorageAvailable(PROBE)).toBe(false);
  });

  test("a store that refuses the write answers false", () => {
    vi.spyOn(storageMethods(), "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });

    expect(isStorageAvailable(PROBE)).toBe(false);
  });
});

describe("readStorageFlag", () => {
  test.each(["0", "off", "false"])("%s reads false over a true fallback", (word) => {
    localStorage.setItem(FLAG, word);

    expect(readStorageFlag(FLAG, true)).toBe(false);
  });

  test.each(["1", "on", "true"])("%s reads true over a false fallback", (word) => {
    localStorage.setItem(FLAG, word);

    expect(readStorageFlag(FLAG, false)).toBe(true);
  });

  test.each([true, false])("an unset key reads the fallback %s", (fallback) => {
    expect(readStorageFlag(FLAG, fallback)).toBe(fallback);
  });

  test.each([true, false])("any other word reads the fallback %s", (fallback) => {
    localStorage.setItem(FLAG, "yes");

    expect(readStorageFlag(FLAG, fallback)).toBe(fallback);
  });

  test("no store reads false, whatever the fallback", () => {
    vi.stubGlobal("localStorage", undefined);

    expect(readStorageFlag(FLAG, true)).toBe(false);
  });

  test("a read that throws reads false, whatever the fallback", () => {
    vi.spyOn(storageMethods(), "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });

    expect(readStorageFlag(FLAG, true)).toBe(false);
  });
});
