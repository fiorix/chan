import { afterEach, describe, expect, test, vi } from "vitest";
import {
  holderTagOf,
  openerHolderTag,
  pageHoldsWindow,
  readWindowHolder,
  type HolderReading,
} from "./window-holder";

const PAGE = "https://chan.test/project/index.html";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the tag a URL names", () => {
  test.each([
    [`${PAGE}?w=w-1&h=tag_1`, "tag_1"],
    [`${PAGE}?h=AZaz09_-`, "AZaz09_-"],
    [`${PAGE}?h=${"a".repeat(64)}&w=w-1`, "a".repeat(64)],
    [`${PAGE}?h=a%2Db`, "a-b"],
    [`${PAGE}?h=mine#h=theirs`, "mine"],
  ])("reads %s", (url, tag) => {
    expect(holderTagOf(url)).toBe(tag);
  });

  test.each([
    ["no h", `${PAGE}?w=w-1`],
    ["an empty h", `${PAGE}?h=&w=w-1`],
    ["an h of 65 characters", `${PAGE}?h=${"a".repeat(65)}`],
    ["a dot", `${PAGE}?h=a.b`],
    ["a space", `${PAGE}?h=a%20b`],
    ["a plus, which reads as a space", `${PAGE}?h=a+b`],
    ["a letter outside ASCII", `${PAGE}?h=caf%C3%A9`],
    ["two tags", `${PAGE}?h=mine&h=theirs`],
    ["one tag twice", `${PAGE}?h=mine&h=mine`],
    ["a tag beside an empty one", `${PAGE}?h=mine&h=`],
    ["an h in the fragment alone", `${PAGE}#h=mine`],
    ["a blank page", "about:blank"],
    ["an empty location", ""],
    ["a path that is no URL", "/project/index.html?h=mine"],
  ])("names no holder with %s", (_what, url) => {
    expect(holderTagOf(url)).toBeNull();
  });
});

describe("the tag of the page a window shows", () => {
  function handle(href: () => string): Window {
    return { location: { get href() { return href(); } } } as unknown as Window;
  }

  test("reads the tag of a page it can read", () => {
    expect(readWindowHolder(handle(() => `${PAGE}?w=w-1&h=mine`))).toEqual({ readable: true, tag: "mine" });
  });

  test.each([`${PAGE}?w=w-1`, "about:blank", ""])("reads a page with no tag as readable and untagged: %j", (href) => {
    expect(readWindowHolder(handle(() => href))).toEqual({ readable: true, tag: null });
  });

  test("reads a location that refuses the read as unreadable", () => {
    const refused = handle(() => { throw new DOMException("cross-origin", "SecurityError"); });
    expect(readWindowHolder(refused)).toEqual({ readable: false });
    const noLocation = {
      get location(): Location { throw new DOMException("cross-origin", "SecurityError"); },
    } as unknown as Window;
    expect(readWindowHolder(noLocation)).toEqual({ readable: false });
  });
});

describe("whether a page is on a window", () => {
  const tagged: HolderReading = { readable: true, tag: "mine" };
  const untagged: HolderReading = { readable: true, tag: null };
  const unreadable: HolderReading = { readable: false };

  test.each([
    ["its tag among the holders", { connected: true, holders: ["mine", "theirs"] }, tagged, true],
    ["its tag the only holder", { connected: true, holders: ["mine"] }, tagged, true],
    ["another tag holding the window", { connected: true, holders: ["theirs"] }, tagged, false],
    ["an untagged socket holding the window", { connected: true, holders: [] }, tagged, false],
    ["no socket at all", { connected: false, holders: [] }, tagged, false],
    ["a page that cannot be read, on a window others hold", { connected: true, holders: ["theirs"] }, unreadable, false],
    ["a page that cannot be read, on a window nobody tagged", { connected: true, holders: [] }, unreadable, false],
    ["a page with no tag, on a connected window", { connected: true, holders: ["theirs"] }, untagged, true],
    ["a page with no tag, on a window with no socket", { connected: false, holders: [] }, untagged, false],
  ] as const)("a record that lists holders: %s", (_what, record, reading, held) => {
    expect(pageHoldsWindow(record, reading)).toBe(held);
  });

  test.each([
    ["a tagged page", tagged],
    ["a page with no tag", untagged],
    ["a page that cannot be read", unreadable],
  ] as const)("a record without the list answers by connected alone: %s", (_what, reading) => {
    expect(pageHoldsWindow({ connected: true }, reading)).toBe(true);
    expect(pageHoldsWindow({ connected: false }, reading)).toBe(false);
  });
});

describe("the tag an opener gives the windows it opens", () => {
  test("is a tag the server counts, of 32 hex digits", () => {
    expect(openerHolderTag()).toMatch(/^[0-9a-f]{32}$/);
    expect(holderTagOf(`${PAGE}?h=${openerHolderTag()}`)).toBe(openerHolderTag());
  });

  test("is one for a page load and another for the next", async () => {
    expect(openerHolderTag()).toBe(openerHolderTag());
    vi.resetModules();
    const next = await import("./window-holder");
    expect(next.openerHolderTag()).toMatch(/^[0-9a-f]{32}$/);
    expect(next.openerHolderTag()).not.toBe(openerHolderTag());
  });

  test("is minted where there is no Web Crypto", async () => {
    vi.stubGlobal("crypto", undefined);
    vi.resetModules();
    const bare = await import("./window-holder");
    expect(bare.openerHolderTag()).toMatch(/^[0-9a-f]{32}$/);
    expect(bare.openerHolderTag()).not.toBe("0".repeat(32));
  });
});
