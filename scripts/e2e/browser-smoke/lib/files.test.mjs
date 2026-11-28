import assert from "node:assert/strict";
import test from "node:test";
import { filePath, filesReady, openFileTab, rowWentAway } from "./files.mjs";

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

const SCOPE = '[role="region"][data-pane-id="p1"]';
const NO_BOX = "Node is either not clickable or not an Element";

// A page whose Files tab shows a ready root listing with the row `a.md`, as
// `openFile` reads it. Each double click on the row takes the next of
// `outcomes`: an error it throws, or null for a click that is delivered and
// opens the file's tab. The tab is active only after a delivered click.
function filesPage(outcomes) {
  const page = { clicks: 0, opened: false };
  const tab = {
    evaluate: async () => ({ title: "File Browser", active: true, focused: true }),
    click: async () => {},
    dispose: async () => {},
  };
  const row = {
    click: async (options) => {
      assert.deepEqual(options, { count: 2 });
      const outcome = outcomes[page.clicks++];
      if (outcome === undefined) throw new Error("the stub has no outcome for this click");
      if (outcome) throw outcome;
      page.opened = true;
    },
  };
  return Object.assign(page, {
    bringToFront: async () => {},
    $$: async () => [tab],
    $: async () => null,
    waitForSelector: async () => ({}),
    evaluate: async () => ({
      visible: true, directory: "", filter: "", retry: false, status: [],
      rows: [{ name: "a.md", path: "a.md", selected: false, directory: false }],
    }),
    evaluateHandle: async () => ({ asElement: () => row, dispose: async () => {} }),
    waitForFunction: async () => {
      if (!page.opened) throw new Error("Waiting failed: 5000ms exceeded");
    },
  });
}

test("a try whose row the listing left with no box is retried, and the open answers the try that opened", async () => {
  const page = filesPage([new Error(NO_BOX), null]);
  assert.equal(await openFileTab(page, "a.md", SCOPE), 2);
  assert.equal(page.clicks, 2);
});

test("an error that is not a re-rendered row is rethrown at its first try", async () => {
  const page = filesPage([new Error("the Files tab has no Details toggle"), null]);
  await assert.rejects(openFileTab(page, "a.md", SCOPE), { message: "the Files tab has no Details toggle" });
  assert.equal(page.clicks, 1);
});

test("a row with no box in every try fails after the tries, naming the last reason", async () => {
  const page = filesPage([new Error(NO_BOX), new Error(NO_BOX), new Error(NO_BOX)]);
  await assert.rejects(openFileTab(page, "a.md", SCOPE, 3), {
    message: `a.md did not open from the Files tab in 3 tries; the last: ${NO_BOX}`,
  });
  assert.equal(page.clicks, 3);
});
