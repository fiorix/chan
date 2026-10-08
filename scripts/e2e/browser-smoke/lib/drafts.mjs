// Helpers for the checks that drive a workspace's drafts.
//
// A workspace's drafts are kept outside it, in the workspace's sidecar under
// the server's CHAN_HOME, so a check reads three places: the page, the
// server's drafts list, and the two directory trees on disk (the workspace
// root, which must not change, and the sidecar store).

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/// A 1x1 red PNG.
export const RED_DOT_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const MARK = String.fromCharCode(0);

export function token(ctx) {
  return new URL(ctx.serverUrl).searchParams.get("t");
}

/// A request to the server from the runner, with the suite's bearer.
/// Answers `{ status, text, json }`; `json` is null when the body is not JSON.
export async function request(ctx, path, init = {}) {
  const url = new URL(path, ctx.serverUrl);
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token(ctx)}`, ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status, text, json };
}

/// The server's drafts list: `{ drafts: [{name, primary, has_attachments, busy}], warnings }`.
export async function listDrafts(ctx) {
  const res = await request(ctx, "/api/drafts");
  if (res.status !== 200 || !res.json) {
    throw new Error(`GET /api/drafts answered ${res.status}: ${res.text.slice(0, 200)}`);
  }
  return res.json;
}

export async function waitFor(label, timeoutMs, probe) {
  const t0 = Date.now();
  let last;
  for (;;) {
    try {
      last = await probe();
    } catch (e) {
      last = null;
      if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${label}: ${e.message}`);
    }
    if (last) return last;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

/// Run the app's New draft command in `page` and answer the row the server
/// lists for the draft it made: one that was not listed before.
export async function newDraft(ctx, page) {
  const before = new Set((await listDrafts(ctx)).drafts.map((d) => d.primary.draft_id));
  await page.bringToFront();
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: "app.draft.new" } }));
  });
  const row = await waitFor("the new draft in the server's list", 20_000, async () =>
    (await listDrafts(ctx)).drafts.find((d) => !before.has(d.primary.draft_id)),
  );
  await waitActiveTab(page, `Drafts/${row.primary.path}`, "the new draft's tab");
  await page.waitForSelector(".editor-tab.active .cm-content", { timeout: 20_000 });
  return { name: row.name, id: row.primary.draft_id, path: row.primary.path };
}

/// Wait until the active tab is the one whose tooltip is `title`. A tab's
/// tooltip is its path as a person reads it (`Drafts/<name>/<file>` for a
/// draft), which stays unique where two tabs share a file name and their
/// labels grow directory segments.
export async function waitActiveTab(page, title, label) {
  await page
    .waitForFunction(
      (wanted) => document.querySelector(".tabs .tab.active")?.getAttribute("title") === wanted,
      { timeout: 20_000 },
      title,
    )
    .catch(async () => {
      const seen = await page.evaluate(() =>
        [...document.querySelectorAll(".tabs .tab")].map(
          (t) => `${t.classList.contains("active") ? "*" : ""}${t.getAttribute("title")}`,
        ),
      );
      throw new Error(`${label}: no active tab titled ${title}; tabs: ${seen.join(" | ")}`);
    });
}

/// Bring forward the tab whose tooltip is `title`. The strip selects a tab
/// on mousedown, so this is a real pointer click, not a dispatched one.
export async function activateTab(page, title) {
  await page.bringToFront();
  for (const tab of await page.$$(".tabs .tab")) {
    if ((await tab.evaluate((el) => el.getAttribute("title"))) !== title) continue;
    await tab.click();
    await waitActiveTab(page, title, "the tab brought forward");
    return;
  }
  throw new Error(`no tab titled ${title}`);
}

/// The sidecar store that holds the draft `name`: the `Drafts` directory
/// under the server's CHAN_HOME with a directory of that name in it.
export function draftsStore(ctx, name) {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 6) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const path = join(dir, entry.name);
      if (entry.name === "Drafts" && existsSync(join(path, name))) found.push(path);
      else walk(path, depth + 1);
    }
  };
  walk(ctx.chanHome, 0);
  if (found.length !== 1) {
    throw new Error(`expected one Drafts store holding ${name} under CHAN_HOME, found ${found.length}`);
  }
  return found[0];
}

/// Every file under `dir`, as sorted paths relative to it.
export function filesUnder(dir) {
  const out = [];
  const walk = (at, rel) => {
    for (const name of readdirSync(at)) {
      const path = join(at, name);
      const relPath = rel ? `${rel}/${name}` : name;
      if (statSync(path).isDirectory()) walk(path, relPath);
      else out.push(relPath);
    }
  };
  if (existsSync(dir)) walk(dir, "");
  return out.sort();
}

/// Everything a person can read or hear in the page: its text, titles and
/// aria labels. Not its URLs: an image's address rightly carries the id of
/// its draft's lifetime.
export async function readable(page) {
  return page.evaluate(() => {
    const parts = [document.body.innerText ?? "", document.body.textContent ?? ""];
    for (const el of document.body.querySelectorAll("[title], [aria-label]")) {
      parts.push(el.getAttribute("title") ?? "", el.getAttribute("aria-label") ?? "");
    }
    return parts.join("\n");
  });
}

/// What `assertNothingMarkedShown` refuses, by the search that found it.
const SHOWN = {
  mark: "the page shows the draft path mark",
  id: "the page shows a draft's lifetime id",
  payload: "the page shows the payload of a draft's lifetime id",
};

/// Throws when what the page shows holds a draft path's mark or the id of a
/// draft's lifetime. The id is searched for as the server lists it and by
/// its payload, the part after its last colon. A client path spells the id
/// percent-encoded, and a marked path that reached the page through an HTML
/// parse has lost its mark, so the payload is what every spelling keeps.
export async function assertNothingMarkedShown(page, ids, where) {
  const shown = await readable(page);
  if (shown.includes(MARK)) throw new Error(`${where}: ${SHOWN.mark}`);
  for (const id of ids) {
    if (!id) continue;
    if (shown.includes(id)) throw new Error(`${where}: ${SHOWN.id}`);
    const payload = id.split(":").pop();
    if (payload && shown.includes(payload)) throw new Error(`${where}: ${SHOWN.payload}`);
  }
}

/// The client's spelling of a draft file's path, for a check that sends the
/// form where it must be refused.
export function markedPath(id, path) {
  return `${MARK}${encodeURIComponent(id)}:${path}`;
}

/// The positive control of `assertNothingMarkedShown`: its zero means
/// something only while each of its searches finds what it looks for. This
/// plants, one at a time, the draft's marked path in a `title`, its id as
/// the server lists it and its id as a client path spells it, requires the
/// search that owns each to refuse it, takes it out again, and ends on a
/// page the helper passes.
export async function assertMarkedShownIsRefused(page, id, path, where) {
  const encoded = encodeURIComponent(id);
  const plants = [
    { what: "a marked path in a title", title: markedPath(id, path), text: "", refusal: SHOWN.mark },
    { what: "the id as text", title: null, text: id, refusal: SHOWN.id },
    { what: "the percent-encoded id as text", title: null, text: encoded, refusal: SHOWN.payload },
  ];
  for (const plant of plants) {
    await page.evaluate(({ title, text }) => {
      const el = document.createElement("span");
      el.id = "smoke-marked-plant";
      el.hidden = true;
      if (title !== null) el.setAttribute("title", title);
      el.textContent = text;
      document.body.append(el);
    }, plant);
    let answer = null;
    try {
      await assertNothingMarkedShown(page, [id], where);
    } catch (e) {
      answer = e.message;
    } finally {
      await page.evaluate(() => document.getElementById("smoke-marked-plant")?.remove());
    }
    if (answer !== `${where}: ${plant.refusal}`) {
      const got = answer ?? "nothing";
      throw new Error(`${where}: the search answered "${got}" to ${plant.what}, not "${plant.refusal}"`);
    }
  }
  await assertNothingMarkedShown(page, [id], `${where}, the plants removed`);
}

/// What a marked path reads as once it has been through the clipboard, or
/// through an HTML parse into an attribute: the mark replaced by U+FFFD.
export function markedPathReadBack(id, path) {
  return `${String.fromCharCode(0xfffd)}${markedPath(id, path).slice(1)}`;
}

/// The origin a rich copy's wrapper names, read as the paste side reads it:
/// the root, the path and the draft id on the element that carries the
/// markdown. Null when `html` holds no wrapper.
export async function wrapperOrigin(page, html) {
  return page.evaluate((payload) => {
    const doc = new DOMParser().parseFromString(payload, "text/html");
    const root = doc.querySelector("[data-chan-markdown]");
    if (!root) return null;
    return {
      root: root.getAttribute("data-chan-root"),
      path: root.getAttribute("data-chan-path"),
      id: root.getAttribute("data-chan-draft-id"),
    };
  }, html);
}

/// What is wrong with `origin` as the wrapper of a copy from `draft`, or
/// null. A draft's copy names the drafts root, the draft's path inside the
/// drafts and the id of its lifetime, each exactly.
export function wrapperOriginFault(origin, draft) {
  const wanted = { root: "draft", path: draft.path, id: draft.id };
  const same = origin != null && Object.keys(wanted).every((key) => origin[key] === wanted[key]);
  return same ? null : `names its origin as ${JSON.stringify(origin)}, not ${JSON.stringify(wanted)}`;
}

/// Paste an image file into the active editor, as a clipboard paste of a
/// file does. The handler reads `clipboardData.items`, so a synthetic event
/// carrying a DataTransfer file is faithful.
export async function pasteImageFile(page, name = "red-dot.png", b64 = RED_DOT_PNG_B64) {
  await page.evaluate(
    (data, fileName) => {
      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      const file = new File([bytes], fileName, { type: "image/png" });
      const dt = new DataTransfer();
      dt.items.add(file);
      document
        .querySelector(".editor-tab.active .cm-content")
        ?.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    },
    b64,
    name,
  );
}

/// Wait until the active editor shows `count` images that have loaded.
export async function waitImagesRendered(page, count, label) {
  await page.waitForFunction(
    (wanted) => {
      const imgs = [...document.querySelectorAll(".editor-tab.active .cm-md-image-wrap img")];
      return imgs.length === wanted && imgs.every((img) => img.complete && img.naturalWidth > 0);
    },
    { timeout: 20_000 },
    count,
  ).catch(async () => {
    const seen = await page.evaluate(() => ({
      wraps: document.querySelectorAll(".editor-tab.active .cm-md-image-wrap").length,
      imgs: [...document.querySelectorAll(".editor-tab.active .cm-content img")].map((img) => ({
        complete: img.complete,
        width: img.naturalWidth,
        src: (img.getAttribute("src") ?? "").replace(/([?&]t=)[^&]+/, "$1...").slice(0, 160),
      })),
      text: (document.querySelector(".editor-tab.active .cm-content")?.textContent ?? "").slice(-160),
    }));
    throw new Error(`${label}: the editor does not show ${count} loaded image(s): ${JSON.stringify(seen)}`);
  });
}

/// Close the active tab, which for a draft raises the Close Draft dialog,
/// and take `action` there: "discard", or "save" to the file `target`.
export async function closeDraft(page, action, target = null) {
  await page.bringToFront();
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: "app.tab.close" } }));
  });
  await page.waitForSelector(".draft-close", { timeout: 15_000 });
  if (action === "save") {
    const input = await page.waitForSelector(".draft-close input", { timeout: 5_000 });
    await input.click({ clickCount: 3 });
    await page.keyboard.press("Backspace");
    await input.type(target);
    await page.click(".draft-close button.primary");
  } else {
    await page.click(".draft-close button.danger");
  }
  await page.waitForFunction(() => !document.querySelector(".draft-close"), { timeout: 20_000 });
}

/// Save the active draft tab to the workspace file `target` through its tab
/// menu, which leaves the tab open on the file the draft became. The menu
/// is the one a right-click on the tab in the strip opens; a right-click in
/// the editor's body opens the editing menu, which has no such row.
export async function saveDraftToWorkspace(page, target) {
  await page.bringToFront();
  const tab = await page.$(".tabs .tab.active");
  if (!tab) throw new Error("no active tab to open the menu of");
  await tab.click({ button: "right" });
  await page.waitForSelector(".tab-menu-bubble", { timeout: 5_000 });
  const clicked = await page.evaluate(() => {
    const row = [...document.querySelectorAll(".tab-menu-bubble .mbtn")].find(
      (b) => b.querySelector(".mbtn-label")?.textContent?.trim() === "Save to Workspace",
    );
    row?.click();
    return !!row;
  });
  if (!clicked) {
    const rows = await page.evaluate(() =>
      [...document.querySelectorAll(".tab-menu-bubble .mbtn-label")].map((l) => l.textContent?.trim()),
    );
    throw new Error(`the draft tab's menu has no Save to Workspace row; it offers: ${rows.join(" | ")}`);
  }
  const input = await page.waitForSelector("#path-prompt-title ~ input", { timeout: 15_000 });
  await input.click({ clickCount: 3 });
  await page.keyboard.press("Backspace");
  await input.type(target);
  await page.waitForFunction(() => !document.querySelector("button.ok")?.disabled, { timeout: 10_000 });
  await page.click("button.ok");
  await page.waitForFunction(() => !document.querySelector("#path-prompt-title"), { timeout: 20_000 });
}

/// The File Browser's tab: the one whose label is a directory's.
export async function browserTab(page) {
  for (const tab of await page.$$(".tabs .tab")) {
    const label = await tab.$eval(".path", (node) => node.textContent?.trim() ?? "").catch(() => "");
    if (label.endsWith("/")) return tab;
  }
  return null;
}

/// Bring the file tree forward, opening a File Browser tab when there is
/// none. Answers whether this call opened it. The tab becomes the active
/// one: a caller that goes back to an editor brings that tab forward again.
export async function showFileTree(page) {
  await page.bringToFront();
  let tab = await browserTab(page);
  const opened = tab === null;
  if (opened) {
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: "app.files.toggle" } }));
    });
    tab = await waitFor("a File Browser tab", 15_000, () => browserTab(page));
  }
  await tab.click();
  await page.waitForSelector("[role=tree]", { timeout: 15_000 });
  return opened;
}

/// The tree's row for the entry `name`, or null. A file's name is a button
/// and a directory's a span, both of class `name`.
export async function treeItem(page, name) {
  for (const item of await page.$$("[role=tree] [role=treeitem]")) {
    const text = await item.$eval(".name", (node) => node.textContent?.trim() ?? "").catch(() => "");
    if (text === name || text === `${name}/`) return item;
  }
  return null;
}

/// Show the Drafts group, which sits above the file tree of a File Browser
/// tab. Call it while at least one draft is listed: the group is not drawn
/// for none.
export async function openTree(page) {
  await showFileTree(page);
  await page.waitForSelector(".drafts-group", { timeout: 15_000 }).catch(() => {
    throw new Error("the Drafts group did not appear above the file tree");
  });
}

/// Wait until the Drafts group lists `name` (`present`) or does not. The
/// file tree is brought forward first: a File Browser tab that is not the
/// active one is not in the page, and a group that is not there lists
/// nothing, which would pass an absence without showing it.
export async function waitGroup(page, name, present) {
  await showFileTree(page);
  await waitFor(`the Drafts group ${present ? "to list" : "to lose"} ${name}`, 20_000, async () =>
    (await groupNames(page)).includes(name) === present,
  );
}

/// The names the Drafts group lists, in order; empty when it is not shown.
export async function groupNames(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll(".drafts-group .draft-row .draft-name")].map((el) => el.textContent ?? ""),
  );
}
