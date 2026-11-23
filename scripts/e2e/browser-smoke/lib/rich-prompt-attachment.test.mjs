import assert from "node:assert/strict";
import { test } from "node:test";
import { waitRestoredTerminal } from "../checks/290-rich-prompt-disconnected.mjs";
import { openAttachedTerminal, readTerminalAttachment } from "./terminal-attach.mjs";

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

test(`ghostty: resolve the original session under regenerated coordinates`, async (t) => {
  const f = fixture(t, "ghostty", [restored]);
  const result = await waitRestoredTerminal(f.page, f.cs, original.window, original, "ghostty", 0);
  assert.equal(result.session_id, original.session_id);
  assert.equal(result.pane, restored.pane);
  assert.equal(result.tab, restored.tab);
  assert.equal(result.selector, selector(restored));
  assert.deepEqual(f.commands, [["list", "--json"]]);
});

test(`ghostty: stale coordinates cannot satisfy attachment`, async (t) => {
  const f = fixture(t, "ghostty", [original]);
  await assert.rejects(waitRestoredTerminal(f.page, f.cs, original.window, original, "ghostty", 0), /not attached/);
});

test(`ghostty: retry a stale roster until the current coordinates are visible`, async (t) => {
  let reads = 0;
  const f = fixture(t, "ghostty", () => [reads++ === 0 ? original : restored]);
  const result = await waitRestoredTerminal(f.page, f.cs, original.window, original, "ghostty");
  assert.equal(result.selector, selector(restored));
  assert.equal(reads, 2);
  assert.equal(f.queries.length, 2);
});

test(`ghostty: another session reusing the old coordinates cannot satisfy attachment`, async (t) => {
  const impostor = { ...original, session_id: "different-session" };
  const f = fixture(t, "ghostty", [impostor], impostor);
  await assert.rejects(waitRestoredTerminal(f.page, f.cs, original.window, original, "ghostty", 0), /not attached/);
});

test(`ghostty: the original session in another window cannot satisfy attachment`, async (t) => {
  const elsewhere = { ...restored, window: "another-window" };
  const f = fixture(t, "ghostty", [elsewhere]);
  await assert.rejects(waitRestoredTerminal(f.page, f.cs, original.window, original, "ghostty", 0), /not attached/);
});

test(`ghostty: an unassigned pane or tab cannot satisfy attachment`, async (t) => {
  for (const field of ["pane", "tab"]) {
    const incomplete = { ...restored, [field]: "" };
    const f = fixture(t, "ghostty", [incomplete], incomplete);
    await assert.rejects(waitRestoredTerminal(f.page, f.cs, original.window, original, "ghostty", 0), /not attached/);
  }
});

test(`ghostty: another backend cannot satisfy attachment`, async (t) => {
  const other = "xterm";
  const f = fixture(t, other, [restored]);
  await assert.rejects(waitRestoredTerminal(f.page, f.cs, original.window, original, "ghostty", 0), /not attached/);
});

for (const dimension of ["width", "height"]) {
  test(`ghostty: a backend with zero ${dimension} cannot satisfy attachment`, async (t) => {
    const f = fixture(t, "ghostty", [restored], restored, { width: 800, height: 600, [dimension]: 0 });
    await assert.rejects(waitRestoredTerminal(f.page, f.cs, original.window, original, "ghostty", 0), /not attached/);
  });
}

function openingFixture(t, backend, row, requestedBackend = backend) {
  const f = fixture(t, backend, [row], row);
  const evaluate = f.page.evaluate;
  f.page.evaluate = (fn, arg) => arg === "" ? Promise.resolve({ ghostty: requestedBackend === "ghostty" }) : evaluate(fn, arg);
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

test("opening ghostty refuses xterm's nested WebGL canvas", async (t) => {
  const row = { ...restored, name: "requested-ghostty", window_status: "alive" };
  const { ctx, page, cs, commands, shots } = openingFixture(t, "xterm", row, "ghostty");
  await assert.rejects(openAttachedTerminal(ctx, page, cs, original.window, row.name, "ghostty"), /terminal not attached/);
  assert.deepEqual(commands, [["new", "--tab-name", row.name], ["list", "--json"]]);
  assert.deepEqual(shots, [`${row.name}-attach-failure`]);
});

for (const mismatch of [{ window: "another-window" }, { window_status: "offline" }]) {
  test(`opening reports the name-matched row when ${Object.keys(mismatch)[0]} prevents attachment`, async (t) => {
    const row = { ...restored, name: "requested-ghostty", window_status: "alive", ...mismatch };
    const { ctx, page, cs } = openingFixture(t, "ghostty", row);
    await assert.rejects(openAttachedTerminal(ctx, page, cs, original.window, row.name, "ghostty"), (error) => {
      assert.match(error.message, /terminal not attached/);
      assert.ok(error.message.includes(`row=${JSON.stringify(row)}`), error.message);
      return true;
    });
  });
}

test("a malformed roster fails instead of satisfying attachment", async () => {
  const cs = async () => ({ stdout: "{" });
  await assert.rejects(waitRestoredTerminal({}, cs, original.window, original, "ghostty", 0), SyntaxError);
});

test("opening Ghostty requires its visible direct-child canvas and attached row", async (t) => {
  const row = { ...restored, name: "requested-ghostty", window_status: "alive" };
  const { ctx, page, cs, commands } = openingFixture(t, "ghostty", row);
  assert.deepEqual(await openAttachedTerminal(ctx, page, cs, original.window, row.name, "ghostty"), row);
  assert.deepEqual(commands, [["new", "--tab-name", row.name], ["list", "--json"]]);
});

const retiredBackend = /retired or unsupported terminal backend/;

// Observe attempted reads independently from the returned error: a fixture's
// missing browser method must never masquerade as the backend refusal.
function refusingFixture(config) {
  const reads = [], commands = [];
  return {
    reads, commands,
    ctx: { serverUrl: "http://test.invalid" },
    page: { evaluate: async (...args) => { reads.push(args); return config; } },
    cs: async (args) => { commands.push(args); throw new Error("unexpected terminal command"); },
  };
}

function synchronousRefusal(call, f) {
  assert.throws(() => {
    const result = call();
    // A broken async boundary is a failure, without an unhandled rejection
    // obscuring the assertion that diagnosed it.
    result?.catch(() => {});
  }, retiredBackend);
  assert.deepEqual(f.reads, [], "refusal precedes every preference or DOM read");
  assert.deepEqual(f.commands, [], "refusal precedes list and spawn commands");
}

for (const config of [{}, { ghostty: true }]) {
  test(`requesting xterm refuses before reads/spawn with response ${JSON.stringify(config)}`, () => {
    const f = refusingFixture(config);
    synchronousRefusal(() => openAttachedTerminal(f.ctx, f.page, f.cs, original.window, "retired", "xterm"), f);
  });
}

for (const backend of ["xterm", "unknown", "Ghostty", false, true, undefined, null, ["xterm", "ghostty"]]) {
  test(`attachment boundaries synchronously refuse ${JSON.stringify(backend)}`, () => {
    const f = refusingFixture({ ghostty: true });
    synchronousRefusal(() => readTerminalAttachment(f.page, f.cs, backend, () => true), f);
    synchronousRefusal(() => openAttachedTerminal(f.ctx, f.page, f.cs, original.window, "retired", backend), f);
  });
}

test("a leftover two-backend caller fails before spawning either arm", async () => {
  const f = refusingFixture({});
  await assert.rejects(async () => {
    for (const backend of ["xterm", "ghostty"]) {
      await openAttachedTerminal(f.ctx, f.page, f.cs, original.window, "leftover", backend);
    }
  }, retiredBackend);
  assert.deepEqual(f.reads, []);
  assert.deepEqual(f.commands, []);
});

test("non-JSON backend values still get the explicit refusal without coercion", () => {
  const cyclic = {};
  cyclic.self = cyclic;
  for (const backend of [1n, Symbol("ghostty"), cyclic]) {
    const f = refusingFixture({});
    synchronousRefusal(() => openAttachedTerminal(f.ctx, f.page, f.cs, original.window, "invalid", backend), f);
  }
});

test("restoration refuses the retired backend before any roster read", async () => {
  const f = refusingFixture({});
  await assert.rejects(waitRestoredTerminal(f.page, f.cs, original.window, original, "xterm", 0), retiredBackend);
  assert.deepEqual(f.reads, []);
  assert.deepEqual(f.commands, []);
});
