import assert from "node:assert/strict";
import { test } from "node:test";
import { waitRestoredTerminal } from "../checks/290-rich-prompt-disconnected.mjs";
import { openAttachedTerminal } from "./terminal-attach.mjs";

const original = { session_id: "original-session", window: "check-window", pane: "pane-1", tab: "term-2" };
const restored = { ...original, pane: "pane-2", tab: "term-3" };
const selector = (row) => `.pane[data-pane-id="${row.pane}"] .terminal-tab.active[data-terminal-tab-id="${row.tab}"]`;

function fixture(t, backend, rows, visible = restored, box = { width: 800, height: 600 }) {
  const queries = [], commands = [];
  // Xterm's WebGL canvas is nested inside its screen; Ghostty's canvas is
  // a direct child of the host. Both satisfy a descendant-canvas query.
  const surfaces = backend === "ghostty"
    ? [".terminal-host canvas", ".terminal-host > canvas"]
    : [".terminal-host canvas", ".terminal.xterm .xterm-screen"];
  const matches = (query) => surfaces.some((surface) => query === `${selector(visible)} ${surface}`);
  // The roster and DOM are controlled independently so a stale row cannot
  // manufacture evidence that its backend is visible.
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

for (const backend of ["xterm", "ghostty"]) {
  test(`${backend}: resolve the original session under regenerated coordinates`, async (t) => {
    const f = fixture(t, backend, [restored]);
    const result = await waitRestoredTerminal(f.page, f.cs, original.window, original, backend, 0);
    assert.equal(result.session_id, original.session_id);
    assert.equal(result.pane, restored.pane);
    assert.equal(result.tab, restored.tab);
    assert.equal(result.selector, selector(restored));
    assert.deepEqual(f.commands, [["list", "--json"]]);
  });

  test(`${backend}: stale coordinates cannot satisfy attachment`, async (t) => {
    const f = fixture(t, backend, [original]);
    await assert.rejects(waitRestoredTerminal(f.page, f.cs, original.window, original, backend, 0), /not attached/);
  });

  test(`${backend}: retry a stale roster until the current coordinates are visible`, async (t) => {
    let reads = 0;
    const f = fixture(t, backend, () => [reads++ === 0 ? original : restored]);
    const result = await waitRestoredTerminal(f.page, f.cs, original.window, original, backend);
    assert.equal(result.selector, selector(restored));
    assert.equal(reads, 2);
    assert.equal(f.queries.length, 2);
  });

  test(`${backend}: another session reusing the old coordinates cannot satisfy attachment`, async (t) => {
    const impostor = { ...original, session_id: "different-session" };
    const f = fixture(t, backend, [impostor], impostor);
    await assert.rejects(waitRestoredTerminal(f.page, f.cs, original.window, original, backend, 0), /not attached/);
  });

  test(`${backend}: the original session in another window cannot satisfy attachment`, async (t) => {
    const elsewhere = { ...restored, window: "another-window" };
    const f = fixture(t, backend, [elsewhere]);
    await assert.rejects(waitRestoredTerminal(f.page, f.cs, original.window, original, backend, 0), /not attached/);
  });

  test(`${backend}: an unassigned pane or tab cannot satisfy attachment`, async (t) => {
    for (const field of ["pane", "tab"]) {
      const incomplete = { ...restored, [field]: "" };
      const f = fixture(t, backend, [incomplete], incomplete);
      await assert.rejects(waitRestoredTerminal(f.page, f.cs, original.window, original, backend, 0), /not attached/);
    }
  });

  test(`${backend}: another backend cannot satisfy attachment`, async (t) => {
    const other = backend === "xterm" ? "ghostty" : "xterm";
    const f = fixture(t, other, [restored]);
    await assert.rejects(waitRestoredTerminal(f.page, f.cs, original.window, original, backend, 0), /not attached/);
  });

  for (const dimension of ["width", "height"]) {
    test(`${backend}: a backend with zero ${dimension} cannot satisfy attachment`, async (t) => {
      const f = fixture(t, backend, [restored], restored, { width: 800, height: 600, [dimension]: 0 });
      await assert.rejects(waitRestoredTerminal(f.page, f.cs, original.window, original, backend, 0), /not attached/);
    });
  }
}

test("opening ghostty refuses xterm's nested WebGL canvas", async (t) => {
  const row = { ...restored, name: "requested-ghostty", window_status: "alive" };
  const f = fixture(t, "xterm", [row]);
  const evaluate = f.page.evaluate;
  f.page.evaluate = (fn, arg) => arg === "" ? Promise.resolve({ ghostty: true }) : evaluate(fn, arg);
  const commands = [], shots = [];
  const cs = async (args) => {
    commands.push(args);
    if (args[0] === "new") return { stdout: "" };
    return f.cs(args);
  };
  let clockReads = 0;
  t.mock.method(Date, "now", () => clockReads++ === 0 ? 0 : 60_001);
  const ctx = { serverUrl: "http://test.invalid", shot: async (name) => { shots.push(name); } };
  await assert.rejects(openAttachedTerminal(ctx, f.page, cs, original.window, row.name, "ghostty"), /terminal not attached/);
  assert.deepEqual(commands, [["new", "--tab-name", row.name], ["list", "--json"]]);
  assert.deepEqual(shots, [`${row.name}-attach-failure`]);
});

test("a malformed roster fails instead of satisfying attachment", async () => {
  const cs = async () => ({ stdout: "{" });
  await assert.rejects(waitRestoredTerminal({}, cs, original.window, original, "xterm", 0), SyntaxError);
});
