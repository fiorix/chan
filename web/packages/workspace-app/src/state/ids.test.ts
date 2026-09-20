import { afterEach, describe, expect, test, vi } from "vitest";

import { newUuid } from "./ids";

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/// What a page served over plain http actually gets: `getRandomValues` in any
/// context, `randomUUID` and `subtle` only in a secure one.
function insecureContextCrypto(): Crypto {
  const real = globalThis.crypto;
  return {
    getRandomValues: (array: ArrayBufferView) =>
      real.getRandomValues(array as never),
  } as unknown as Crypto;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("newUuid", () => {
  test("mints a v4 UUID where the platform offers one", () => {
    expect(newUuid()).toMatch(UUID_V4);
  });

  test("mints a v4 UUID in a context without randomUUID", () => {
    vi.stubGlobal("crypto", insecureContextCrypto());
    expect(newUuid()).toMatch(UUID_V4);
  });

  test("mints a v4 UUID with no Web Crypto at all", () => {
    vi.stubGlobal("crypto", undefined);
    expect(newUuid()).toMatch(UUID_V4);
  });

  test("draws a fresh id per call on every path", () => {
    // Two windows of one session mint ids independently and must not collide,
    // so nothing here may seed from the clock: a thousand ids from one path
    // are a thousand distinct ids.
    for (const stub of [null, insecureContextCrypto(), undefined]) {
      if (stub !== null) vi.stubGlobal("crypto", stub);
      const ids = new Set<string>();
      for (let i = 0; i < 1000; i += 1) ids.add(newUuid());
      expect(ids.size).toBe(1000);
      vi.unstubAllGlobals();
    }
  });
});
