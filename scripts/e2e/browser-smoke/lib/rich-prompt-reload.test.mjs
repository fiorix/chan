import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { waitComposerDraft } from "../checks/344-rich-prompt-reload-focus.mjs";

const TEXT = "focus reload draft";
const row = (name) => ({ name, primary: { root: "draft", path: `${name}/draft.md`, draft_id: `v1:${name}` }, has_attachments: false, busy: false });
const OLDER = row("untitled"), COMPOSER = row("untitled-3");
const known = new Set([OLDER.primary.draft_id]);

// The server as a window with an open composer leaves it before a reload:
// the drafts list has the composer's draft after an older one, and each
// draft's store holds its text. The saved session is not served at all,
// since before the page unloads it names the terminal and no composer.
function server(t, { texts = { untitled: TEXT, "untitled-3": TEXT }, drafts = [OLDER, COMPOSER], expire = false } = {}) {
  const chanHome = mkdtempSync(join(tmpdir(), "chan-reload-barrier-"));
  t.after(() => rmSync(chanHome, { recursive: true, force: true }));
  const file = (name) => join(chanHome, "workspaces", "key", "Drafts", name, "draft.md");
  for (const [name, text] of Object.entries(texts)) {
    mkdirSync(join(file(name), ".."), { recursive: true });
    writeFileSync(file(name), text);
  }
  const lists = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const { pathname } = new URL(url);
    assert.equal(pathname, "/api/drafts", "the barrier asks the server for its drafts and nothing else");
    assert.equal(options.headers.Authorization, "Bearer token");
    lists.push(pathname);
    return Response.json({ drafts, warnings: [] });
  });
  // Every look at the clock is 30 s after the last, so a wait that is not
  // met by its first probe expires there, without a 20 s sleep.
  if (expire) {
    let reads = 0;
    t.mock.method(Date, "now", () => reads++ * 30_000);
  }
  return { ctx: { serverUrl: "http://test.invalid/?t=token", chanHome }, file, lists };
}

test("the reload barrier is met by the composer's stored draft while the saved session names no composer", async (t) => {
  const f = server(t);
  assert.deepEqual(await waitComposerDraft(f.ctx, known, TEXT), COMPOSER);
});

test("a draft listed before the composer opened cannot meet the barrier, whatever it holds", async (t) => {
  const f = server(t, { drafts: [OLDER], expire: true });
  await assert.rejects(waitComposerDraft(f.ctx, known, TEXT), { message: "timed out waiting for the composer's draft in the server's list" });
});

test("the barrier waits for the typed text, not for the draft alone", async (t) => {
  const f = server(t, { texts: { untitled: TEXT, "untitled-3": "" } });
  let met = false;
  const waiting = waitComposerDraft(f.ctx, known, TEXT).then((draft) => { met = true; return draft; });
  while (f.lists.length === 0) await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(met, false, "an empty draft is not the composer's saved text");
  writeFileSync(f.file("untitled-3"), `${TEXT}\n`);
  assert.deepEqual(await waiting, COMPOSER);
});

test("a composer draft that never takes the text fails the barrier by name", async (t) => {
  const f = server(t, { texts: { untitled: TEXT, "untitled-3": "" }, expire: true });
  await assert.rejects(waitComposerDraft(f.ctx, known, TEXT), { message: "timed out waiting for the typed text in the composer's draft" });
});
