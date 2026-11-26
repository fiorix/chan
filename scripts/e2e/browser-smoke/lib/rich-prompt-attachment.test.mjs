import assert from "node:assert/strict";
import { test } from "node:test";
import { waitRestoredTerminal } from "../checks/290-rich-prompt-disconnected.mjs";
import { openAttachedTerminal } from "./terminal-attach.mjs";

const original = { session_id: "original-session", window: "check-window", pane: "pane-1", tab: "term-2" };
const restored = { ...original, pane: "pane-2", tab: "term-3" };
const selector = (row) => `.pane[data-pane-id="${row.pane}"] .terminal-tab.active[data-terminal-tab-id="${row.tab}"]`;

// The selectors the stand-in DOM answers under the visible tab. The widget's
// canvas is a direct child of the host, so it also answers a descendant
// query; a canvas nested deeper answers only the descendant query.
const DIRECT_CANVAS = [".terminal-host canvas", ".terminal-host > canvas"];
const NESTED_CANVAS = [".terminal-host canvas"];

function fixture(t, rows, visible = restored, box = { width: 800, height: 600 }, surfaces = DIRECT_CANVAS) {
  const queries = [], commands = [];
  const matches = (query) => surfaces.some((surface) => query === `${selector(visible)} ${surface}`);
  // The roster and DOM are controlled independently so a stale row cannot
  // manufacture evidence that its canvas is visible.
  const document = Object.getOwnPropertyDescriptor(globalThis, "document");
  t.after(() => {
    if (document) Object.defineProperty(globalThis, "document", document);
    else delete globalThis.document;
  });
  return {
    queries, commands,
    cs: async (args) => {
      commands.push(args);
      assert.deepEqual(args, ["list", "--json"], "attachment must not spawn or mutate a terminal");
      return { stdout: JSON.stringify({ groups: { Default: typeof rows === "function" ? rows() : rows } }) };
    },
    page: {
      evaluate: async (fn, query) => {
        queries.push(query);
        const previous = globalThis.document;
        globalThis.document = {
          querySelector: (q) => matches(q) ? { getBoundingClientRect: () => box } : null,
          querySelectorAll: () => [],
        };
        try { return await fn(query); } finally { globalThis.document = previous; }
      },
    },
  };
}

test("resolve the original session under regenerated coordinates", async (t) => {
  const f = fixture(t, [restored]);
  const result = await waitRestoredTerminal(f.page, f.cs, original.window, original, 0);
  assert.equal(result.session_id, original.session_id);
  assert.equal(result.pane, restored.pane);
  assert.equal(result.tab, restored.tab);
  assert.equal(result.selector, selector(restored));
  assert.deepEqual(f.commands, [["list", "--json"]]);
});

test("stale coordinates cannot satisfy attachment", async (t) => {
  const f = fixture(t, [original]);
  await assert.rejects(waitRestoredTerminal(f.page, f.cs, original.window, original, 0), /not attached/);
});

test("retry a stale roster until the current coordinates are visible", async (t) => {
  let reads = 0;
  const f = fixture(t, () => [reads++ === 0 ? original : restored]);
  const result = await waitRestoredTerminal(f.page, f.cs, original.window, original);
  assert.equal(result.selector, selector(restored));
  assert.equal(reads, 2);
  assert.equal(f.queries.length, 2);
});

test("another session reusing the old coordinates cannot satisfy attachment", async (t) => {
  const impostor = { ...original, session_id: "different-session" };
  const f = fixture(t, [impostor], impostor);
  await assert.rejects(waitRestoredTerminal(f.page, f.cs, original.window, original, 0), /not attached/);
});

test("the original session in another window cannot satisfy attachment", async (t) => {
  const elsewhere = { ...restored, window: "another-window" };
  const f = fixture(t, [elsewhere]);
  await assert.rejects(waitRestoredTerminal(f.page, f.cs, original.window, original, 0), /not attached/);
});

test("an unassigned pane or tab cannot satisfy attachment", async (t) => {
  for (const field of ["pane", "tab"]) {
    const incomplete = { ...restored, [field]: "" };
    const f = fixture(t, [incomplete], incomplete);
    await assert.rejects(waitRestoredTerminal(f.page, f.cs, original.window, original, 0), /not attached/);
  }
});

test("a canvas nested below the host's child cannot satisfy attachment", async (t) => {
  const f = fixture(t, [restored], restored, undefined, NESTED_CANVAS);
  await assert.rejects(waitRestoredTerminal(f.page, f.cs, original.window, original, 0), /not attached/);
});

for (const dimension of ["width", "height"]) {
  test(`a canvas with zero ${dimension} cannot satisfy attachment`, async (t) => {
    const f = fixture(t, [restored], restored, { width: 800, height: 600, [dimension]: 0 });
    await assert.rejects(waitRestoredTerminal(f.page, f.cs, original.window, original, 0), /not attached/);
  });
}

function openingFixture(t, row, surfaces = DIRECT_CANVAS) {
  const f = fixture(t, [row], row, undefined, surfaces);
  const commands = [], shots = [];
  const cs = async (args) => {
    commands.push(args);
    if (args[0] === "new") return { stdout: "" };
    return f.cs(args);
  };
  let clockReads = 0;
  t.mock.method(Date, "now", () => clockReads++ === 0 ? 0 : 60_001);
  const ctx = { serverUrl: "http://test.invalid", shot: async (name) => { shots.push(name); } };
  return { ...f, cs, ctx, commands, shots };
}

test("opening refuses a canvas nested below the host's child", async (t) => {
  const row = { ...restored, name: "requested", window_status: "alive" };
  const { ctx, page, cs, commands, shots } = openingFixture(t, row, NESTED_CANVAS);
  await assert.rejects(openAttachedTerminal(ctx, page, cs, original.window, row.name), /terminal not attached/);
  assert.deepEqual(commands, [["new", "--tab-name", row.name], ["list", "--json"]]);
  assert.deepEqual(shots, [`${row.name}-attach-failure`]);
});

for (const mismatch of [{ window: "another-window" }, { window_status: "offline" }]) {
  test(`opening reports the name-matched row when ${Object.keys(mismatch)[0]} prevents attachment`, async (t) => {
    const row = { ...restored, name: "requested", window_status: "alive", ...mismatch };
    const { ctx, page, cs } = openingFixture(t, row);
    await assert.rejects(openAttachedTerminal(ctx, page, cs, original.window, row.name), (error) => {
      assert.match(error.message, /terminal not attached/);
      assert.ok(error.message.includes(`row=${JSON.stringify(row)}`), error.message);
      return true;
    });
  });
}

test("a malformed roster fails instead of satisfying attachment", async () => {
  const cs = async () => ({ stdout: "{" });
  await assert.rejects(waitRestoredTerminal({}, cs, original.window, original, 0), SyntaxError);
});

test("opening requires the visible direct-child canvas and attached row", async (t) => {
  const row = { ...restored, name: "requested", window_status: "alive" };
  const { ctx, page, cs, commands } = openingFixture(t, row);
  assert.deepEqual(await openAttachedTerminal(ctx, page, cs, original.window, row.name), row);
  assert.deepEqual(commands, [["new", "--tab-name", row.name], ["list", "--json"]]);
});
