// The date catalog's scan: which spans of a line read as dates and in which
// format, and that a scan builds no pattern of its own.

import { describe, expect, test } from "vitest";

import { findDateMatches, type DateMatch } from "./dateFormats";

function day(year: number, month: number, date: number): Date {
  return new Date(year, month - 1, date);
}

/// The match `text` gives where it first stands in `line`.
function at(line: string, text: string, formatId: DateMatch["formatId"], date: Date): DateMatch {
  const start = line.indexOf(text);
  return { start, end: start + text.length, text, formatId, date };
}

describe("findDateMatches", () => {
  test.each([
    ["iso", "2026-05-05", day(2026, 5, 5)],
    ["medium", "02 Jan 2029", day(2029, 1, 2)],
    ["british-long", "13 April 2024", day(2024, 4, 13)],
    ["british-ord", "13th April 2024", day(2024, 4, 13)],
    ["american-long", "April 13, 2024", day(2024, 4, 13)],
    ["dmy-slash", "13/04/2024", day(2024, 4, 13)],
    ["mdy-slash", "04/13/2024", day(2024, 4, 13)],
  ] as const)("a %s date in a sentence: %s", (formatId, text, date) => {
    const line = `we met on ${text} and left`;

    expect(findDateMatches(line)).toEqual([at(line, text, formatId, date)]);
  });

  test("a slash date both readings fit follows the preferred format", () => {
    const line = "due 04/05/2024";

    expect(findDateMatches(line, "dmy-slash")).toEqual([at(line, "04/05/2024", "dmy-slash", day(2024, 5, 4))]);
    expect(findDateMatches(line, "mdy-slash")).toEqual([at(line, "04/05/2024", "mdy-slash", day(2024, 4, 5))]);
    expect(findDateMatches(line)).toEqual([at(line, "04/05/2024", "dmy-slash", day(2024, 5, 4))]);
  });

  test("a slash date only one reading fits keeps it against the preference", () => {
    const line = "due 13/04/2024";

    expect(findDateMatches(line, "mdy-slash")).toEqual([at(line, "13/04/2024", "dmy-slash", day(2024, 4, 13))]);
  });

  test("two dates one character apart both match", () => {
    expect(findDateMatches("2026-05-05 2026-05-06")).toEqual([
      { start: 0, end: 10, text: "2026-05-05", formatId: "iso", date: day(2026, 5, 5) },
      { start: 11, end: 21, text: "2026-05-06", formatId: "iso", date: day(2026, 5, 6) },
    ]);
  });

  test.each(["v2026-05-05", "2026-05-05x", "build-2026-05-05-rc1", "/path/04/05/2024.txt"])(
    "a date inside a longer token is no date: %s",
    (line) => {
      expect(findDateMatches(line)).toEqual([]);
    },
  );

  test("a second scan of a line gives what the first gave", () => {
    const line = "from 2026-05-05 to 13/04/2024, then April 13, 2024";
    const first = findDateMatches(line);

    expect(first.map((match) => match.formatId)).toEqual(["iso", "dmy-slash", "american-long"]);
    expect(findDateMatches(line)).toEqual(first);
  });

  test("a scan constructs no RegExp", () => {
    const line = "2026-05-05, 02 Jan 2029, 13 April 2024, 13th April 2024, April 13, 2024, 13/04/2024, 04/13/2024";
    const native = globalThis.RegExp;
    let constructed = 0;
    let duringScan = -1;
    let formats: string[] = [];
    globalThis.RegExp = new Proxy(native, {
      construct(target, args, newTarget) {
        constructed += 1;
        return Reflect.construct(target, args, newTarget);
      },
    });
    try {
      formats = findDateMatches(line).map((match) => match.formatId);
      duringScan = constructed;
      new RegExp("x");
    } finally {
      globalThis.RegExp = native;
    }

    expect(formats).toEqual([
      "iso",
      "medium",
      "british-long",
      "british-ord",
      "american-long",
      "dmy-slash",
      "mdy-slash",
    ]);
    // The stand-in counts a construction: the one made after the scan.
    expect(constructed - duringScan).toBe(1);
    expect(duringScan).toBe(0);
  });
});
