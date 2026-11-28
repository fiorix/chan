import assert from "node:assert/strict";
import test from "node:test";
import { HEADERS, LABEL, MARKER, TABLE_TEXT, TYPED, cellReading, exitCode, judge, status } from "./wikilink-labels-verdict.mjs";

// Offline verdict test for wikilink-labels.mjs: made observations in the
// shapes the driver records, as a run reads where the table widget shows
// labels, as it reads where the widget rendered a cell's link as typed, and
// with the instrument's misses that must stay inconclusive. No desktop, no
// page.

const W = "w-0123456789abcdef";
const cell = (text, over = {}) => ({ text, html: text, links: 0, pills: 0, code: [], ...over });
const span = cell(LABEL, { html: `<span>${LABEL}</span>` });
const code = cell(TYPED, { html: `<code>${TYPED}</code>`, code: [TYPED] });
const doc = (over = {}) => ({ w: W, editors: 1, active: true, mode: "rendered", wraps: 0, headers: null, rows: null, ...over });
const drawn = (row, over = {}) => doc({ wraps: 1, headers: HEADERS, rows: [row], ...over });
const reading = (row, over = {}) => ({ window: W, opened: doc(), grid: drawn(row), ...over });

// The reading where the contract holds, and the reading before the table
// widget rendered labels.
const HELD = reading([span, code]);
const AS_TYPED = reading([cell(TYPED), code]);

const failed = (judged) => judged.lines.filter((l) => l.pass === false).map((l) => l.name);
const unread = (judged) => judged.lines.filter((l) => l.pass === null).map((l) => l.name);

test("the fixture's table puts the link and its code twin in one body row under the header", () => {
  const rows = TABLE_TEXT.split("\n").filter((line) => line.startsWith("|"));
  assert.deepEqual(rows, ["| Name | Code |", "|------|------|", `| ${TYPED} | \`${TYPED}\` |`]);
  assert.equal(HEADERS.join(), "Name,Code");
  // The marker is the first line, so a fresh open's caret sits outside the
  // table and the widget draws.
  assert.equal(TABLE_TEXT.split("\n")[0], MARKER);
});

test("the label shown as text, with the code cell as typed, holds", () => {
  const judged = judge(HELD);
  assert.equal(judged.status, "pass", JSON.stringify(failed(judged)));
  assert.equal(judged.reading, "label");
  assert.ok(judged.lines.every((l) => l.pass === true));
  assert.equal(exitCode(judged), 0);
});

test("the link as typed in the link cell is the fault, and the only failed line", () => {
  const judged = judge(AS_TYPED);
  assert.equal(judged.status, "fail");
  assert.equal(judged.reading, "as typed");
  assert.deepEqual(failed(judged), ["the link cell shows the link's label"]);
  assert.equal(exitCode(judged), 10);
});

test("a label drawn as a link or a pill is a fault", () => {
  for (const over of [{ links: 1, html: `<a href="note.md">${LABEL}</a>` }, { pills: 1 }]) {
    const judged = judge(reading([cell(LABEL, over), code]));
    assert.equal(judged.status, "fail", JSON.stringify(over));
    assert.deepEqual(failed(judged), ["the link cell holds the label as text: no link and no pill"]);
  }
});

test("a code cell that loses its brackets or its code element is a fault", () => {
  for (const twin of [cell(LABEL, { code: [LABEL] }), cell(TYPED), cell(`see ${TYPED}`, { code: [TYPED] })]) {
    const judged = judge(reading([span, twin]));
    assert.equal(judged.status, "fail", JSON.stringify(twin));
    assert.deepEqual(failed(judged), ["the code cell keeps the link as typed, in code"]);
  }
});

test("any other text in the link cell is a fault read as other", () => {
  const judged = judge(reading([cell(""), code]));
  assert.equal(judged.status, "fail");
  assert.equal(judged.reading, "other");
});

test("a page from another window is inconclusive, whatever its cells read", () => {
  for (const base of [HELD, AS_TYPED]) {
    const judged = judge({ ...base, opened: doc({ w: "w-other" }) });
    assert.equal(judged.status, "inconclusive");
    assert.equal(exitCode(judged), 3);
  }
});

test("a fixture that never opened, opened twice or opened in source mode is inconclusive", () => {
  const cases = [
    { window: W },
    { window: W, opened: { w: W, editors: 0 } },
    { window: W, opened: { w: W, editors: 2 } },
    { window: W, opened: doc({ mode: "source" }) },
    { ...AS_TYPED, opened: doc({ mode: "source" }) },
    // The driver reads no more than the count when it is not one; a
    // reading that carried more is still not one editor's.
    { ...HELD, opened: doc({ editors: 2 }) },
  ];
  for (const obs of cases) {
    const judged = judge(obs);
    assert.equal(judged.status, "inconclusive", JSON.stringify(obs));
    assert.equal(exitCode(judged), 3);
  }
});

test("a grid that never drew, or is not the fixture's, is inconclusive even over a fault's cells", () => {
  const cases = [
    reading([span, code], { grid: undefined }),
    reading([span, code], { grid: doc() }),
    reading([cell(TYPED), code], { grid: drawn([cell(TYPED), code], { wraps: 2 }) }),
    reading([cell(TYPED), code], { grid: drawn([cell(TYPED), code], { headers: ["Name"] }) }),
    reading([cell(TYPED)]),
    { ...AS_TYPED, grid: { ...AS_TYPED.grid, rows: [[cell(TYPED), code], [cell(TYPED), code]] } },
  ];
  for (const obs of cases) {
    const judged = judge(obs);
    assert.equal(judged.status, "inconclusive", JSON.stringify(obs.grid));
    assert.ok(failed(judged).length + unread(judged).length > 0);
  }
});

test("an instrument error leaves a held reading inconclusive", () => {
  const judged = judge({ ...HELD, error: "inspector did not answer in 8s" });
  assert.equal(judged.status, "inconclusive");
});

test("an unread property never passes, and an unread line is named as unread", () => {
  const lines = [
    { kind: "precondition", name: "p", pass: true },
    { kind: "property", name: "q", pass: null, actual: "unread" },
  ];
  assert.equal(status(lines), "inconclusive");
  const judged = judge({ window: W });
  assert.ok(judged.lines.some((l) => l.actual === "unread" && l.pass === null));
});

test("a failed property before a failed precondition is a fault; after one it is not", () => {
  const property = { kind: "property", name: "q", pass: false };
  const precondition = { kind: "precondition", name: "p", pass: false };
  assert.equal(status([property, precondition]), "fail");
  assert.equal(status([precondition, property]), "inconclusive");
});

test("the link cell's reading names the label, the link as typed, and anything else", () => {
  assert.equal(cellReading(LABEL), "label");
  assert.equal(cellReading(TYPED), "as typed");
  assert.equal(cellReading("[[note|note]]"), "other");
  assert.equal(cellReading(undefined), "unread");
});
