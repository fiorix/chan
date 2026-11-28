import assert from "node:assert/strict";
import test from "node:test";
import { filePath, filesReady, rowWentAway } from "./files.mjs";

test("workspace paths retain literal names and normalize directory separators", () => {
  assert.equal(filePath(""), "");
  assert.equal(filePath("./notes//a [b] #%.md"), "notes/a [b] #%.md");
  assert.equal(filePath("notes/"), "notes");
  for (const invalid of ["/tmp/file", "../file", "notes/../file", "a\0b", null]) {
    assert.throws(() => filePath(invalid));
  }
});

test("an empty directory proves absence only with a visible, unfiltered, successful listing", () => {
  const empty = { visible: true, directory: "", rows: [], filter: "", status: ["No files Create new file Create new directory"] };
  assert.equal(filesReady(empty), true);
  assert.equal(filesReady({ ...empty, visible: false }), false);
  assert.equal(filesReady({ ...empty, directory: null }), false);
  assert.equal(filesReady({ ...empty, filter: "needle" }), false);
  assert.equal(filesReady({ ...empty, rows: [{ name: "cached.md" }], retry: true }), false);
  for (const status of ["Loading files...", "Workspace root unavailable missing", "File listing failed denied"]) {
    assert.equal(filesReady({ ...empty, status: [status] }), false);
  }
});

test("a row click that a re-rendered listing took the row from is retried, and other errors are not", () => {
  for (const message of [
    "Node is detached from document",
    'row "notes/a.md" went before it could be clicked',
    "Node is either not clickable or not an Element",
  ]) {
    assert.equal(rowWentAway(new Error(message)), true, message);
  }
  for (const message of ["the Files tab has no Details toggle", "Waiting failed: 10000ms exceeded"]) {
    assert.equal(rowWentAway(new Error(message)), false, message);
  }
});
