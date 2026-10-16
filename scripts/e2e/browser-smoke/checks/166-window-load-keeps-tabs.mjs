// A page that loads into a window keeps the window's tabs. Each arm runs on a
// window of its own and reads the terminals the pages show, the layout the
// server holds and the window's live sessions:
//
// - co-view: a second page loads while the first page's save of a new
//   terminal is held, and the second page's own save, if it sends one, is held
//   until the first page's has answered, so a write of what the second page
//   read would land last;
// - reload: the first page reloads with every session save refused, so the
//   server's layout lacks the newest terminal while the page's own reload
//   snapshot holds its id;
// - copied URL: a second page opens the first page's URL, hash included, after
//   the window gained two terminals and closed one the copy names.
//
// A loading page writes nothing until it changes something. Its session PUTs
// are counted while its terminals attach and over two save debounces after
// the last attach. The count ends before the arm closes its pages, so it
// leaves out the exit flush at pagehide, which writes only a layout the page
// does not hold as saved. The runner keeps one server for every check, so each
// arm closes the terminals of its window before its pages close.

import assert from "node:assert/strict";

const SESSION_DEBOUNCE_MS = 750;
const SETTLE_MS = 2 * SESSION_DEBOUNCE_MS + 1_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function windowUrl(ctx, windowId) {
  const url = new URL(ctx.serverUrl);
  url.searchParams.set("w", windowId);
  return url.href;
}

function shell(ctx, windowId, args) {
  return ctx.exec(ctx.chanBin, ["shell", ...args], {
    cwd: ctx.workspaceDir,
    env: {
      ...process.env,
      CHAN_CONTROL_SOCKET: ctx.controlSocket,
      CHAN_WINDOW_ID: windowId,
      CHAN_WORKSPACE_PATH: ctx.workspaceDir,
    },
  });
}

/// The terminal tabs of a serialized layout in tree order, both sides of
/// every pane.
export function layoutTerminals(node) {
  if (!node) return [];
  if (node.k === "s") return [...layoutTerminals(node.a), ...layoutTerminals(node.b)];
  return [...(node.t ?? []), ...(node.bt ?? [])]
    .filter((tab) => tab.k === "t")
    .map((tab) => ({ name: tab.n, id: tab.tsid ?? null }));
}

/// The live sessions `chan shell terminal list --json` binds to `windowId`.
export function windowSessions(list, windowId) {
  return Object.values(list.groups ?? {}).flat()
    .filter((row) => row.window === windowId)
    .map((row) => ({ name: row.name, id: row.session_id }));
}

async function savedTerminals(ctx, windowId) {
  const url = new URL("/api/session", ctx.serverUrl);
  url.search = "";
  url.searchParams.set("w", windowId);
  const token = new URL(ctx.serverUrl).searchParams.get("t");
  const response = await fetch(url, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  if (response.status === 204) return [];
  assert.ok(response.ok, `GET /api/session: ${response.status}`);
  return layoutTerminals((await response.json()).layout);
}

async function liveSessions(ctx, windowId) {
  const { stdout } = await shell(ctx, windowId, ["terminal", "list", "--json"]);
  return windowSessions(JSON.parse(stdout), windowId);
}

async function until(read, accept, label, timeoutMs = 20_000) {
  const start = Date.now();
  let last;
  for (;;) {
    last = await read();
    if (accept(last)) return last;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timeout: ${label}; last ${JSON.stringify(last)}`);
    }
    await sleep(100);
  }
}

/// A page whose session PUTs for `windowId` are recorded, and held or refused
/// on request. Its terminal sockets' session frames are recorded from the
/// first document on, reloads included.
async function openTrackedPage(ctx, windowId, label) {
  const page = await ctx.browser.newPage();
  const writes = { puts: [], held: [], hold: false, refuse: false };
  const rows = new Map();
  page.on("request", (request) => {
    if (request.isInterceptResolutionHandled()) return;
    let url;
    try { url = new URL(request.url()); } catch { void request.continue(); return; }
    if (request.method() !== "PUT" || url.pathname !== "/api/session" || url.searchParams.get("w") !== windowId) {
      void request.continue().catch(() => {});
      return;
    }
    let terminals = null;
    try { terminals = layoutTerminals(JSON.parse(request.postData() ?? "{}").layout); } catch { terminals = "unreadable"; }
    const row = { page: label, terminals, status: null };
    writes.puts.push(row);
    rows.set(request, row);
    if (writes.refuse) {
      row.status = "refused";
      void request.abort().catch(() => {});
    } else if (writes.hold) {
      row.status = "held";
      writes.held.push(request);
    } else {
      void request.continue().catch(() => {});
    }
  });
  page.on("response", (response) => {
    const row = rows.get(response.request());
    if (row) row.status = response.status();
  });
  page.on("requestfailed", (request) => {
    const row = rows.get(request);
    if (row && row.status !== "refused") row.status = "failed";
  });
  await page.setRequestInterception(true);
  await page.evaluateOnNewDocument(() => {
    const NativeWebSocket = window.WebSocket;
    const frames = [];
    Object.defineProperty(window, "__smoke166Frames", { value: frames });
    window.WebSocket = new Proxy(NativeWebSocket, {
      construct(target, args) {
        const socket = Reflect.construct(target, args);
        const url = new URL(String(args[0]), window.location.href);
        if (url.pathname === "/api/terminal/ws") {
          socket.addEventListener("message", (event) => {
            if (typeof event.data !== "string") return;
            try {
              const frame = JSON.parse(event.data);
              if (frame.type === "session") frames.push({ id: frame.id, name: frame.name ?? null, asked: url.searchParams.get("session") });
            } catch { /* PTY bytes are not control frames. */ }
          });
        }
        return socket;
      },
    });
  });
  const release = async () => {
    writes.hold = false;
    for (const request of writes.held.splice(0)) {
      rows.get(request).status = "released";
      await request.continue().catch(() => {});
    }
  };
  const labels = () => page.evaluate(() => [...document.querySelectorAll(".tab .path")].map((tab) => tab.textContent?.trim() ?? ""));
  const frames = () => page.evaluate(() => window.__smoke166Frames ?? []);
  const goto = async (href) => {
    await page.goto(href, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForSelector(".pane", { timeout: 30_000 });
  };
  return { page, writes, release, labels, frames, goto };
}

/// Wait until the page shows each of `names` and every tab it shows has had a
/// session frame under its name, then for two save debounces with margin, so a
/// save the attaches cause has gone out. Each arm names the terminals its
/// loading page shows with and without the repair, so a red falls on the arm's
/// own assertion.
async function settleAttached(tracked, label, names) {
  await until(async () => ({ labels: await tracked.labels(), frames: await tracked.frames() }),
    ({ labels, frames }) => names.every((name) => labels.includes(name)) &&
      labels.every((shown) => frames.some((frame) => frame.name === shown)), `${label}: its terminals attached`);
  await sleep(SETTLE_MS);
}

async function addTerminal(ctx, windowId, pane, name) {
  await shell(ctx, windowId, ["terminal", "new", "--window", windowId, "--pane", pane, "--side", "a", "--tab-name", name]);
}

async function activePane(ctx, windowId) {
  const { stdout } = await shell(ctx, windowId, ["pane", "list", "--window", windowId, "--json"]);
  return JSON.parse(stdout).activePaneId;
}

const hasIds = (names) => (saved) => names.every((name) => saved.some((tab) => tab.name === name && tab.id));

async function coView(ctx, pages, windowId) {
  const names = { one: `${windowId}-one`, two: `${windowId}-two`, cover: `${windowId}-cover` };
  const first = await openTrackedPage(ctx, windowId, "first");
  pages.push(["first", first]);
  let second = null;
  try {
    await first.goto(windowUrl(ctx, windowId));
    await ctx.waitWindowLive(windowId);
    const pane = await activePane(ctx, windowId);
    await addTerminal(ctx, windowId, pane, names.one);
    await addTerminal(ctx, windowId, pane, names.two);
    await until(() => savedTerminals(ctx, windowId), hasIds([names.one, names.two]), "co-view: two terminals saved");

    first.writes.hold = true;
    await addTerminal(ctx, windowId, pane, names.cover);
    await until(first.labels, (labels) => labels.includes(names.cover), "co-view: the new terminal on the first page");
    await until(async () => first.writes.puts, (puts) => puts.some((row) => row.status === "held" &&
      Array.isArray(row.terminals) && row.terminals.some((tab) => tab.name === names.cover)), "co-view: the first page's save of it held");
    const cover = (await until(() => liveSessions(ctx, windowId), (rows) => rows.some((row) => row.name === names.cover),
      "co-view: its live session")).find((row) => row.name === names.cover);

    second = await openTrackedPage(ctx, windowId, "second");
    pages.push(["second", second]);
    second.writes.hold = true;
    await second.goto(windowUrl(ctx, windowId));
    // The server holds two terminals while the first page's save is held.
    await settleAttached(second, "co-view second page", [names.one, names.two]);
    const heldBeforeRelease = second.writes.puts.length;

    // Page 1's saves land first, the one that carries the new terminal's id
    // included; a save page 2 holds then lands last.
    await first.release();
    await until(() => savedTerminals(ctx, windowId), hasIds([names.cover]), "co-view: the first page's save of the new terminal landed");
    await until(async () => first.writes.puts, (puts) => puts.every((row) => typeof row.status === "number"),
      "co-view: every save of the first page answered");
    await second.release();
    await until(async () => second.writes.puts, (puts) => puts.every((row) => typeof row.status === "number"),
      "co-view: the second page's released save answered");
    await sleep(SETTLE_MS);

    const outcome = {
      secondPagePuts: second.writes.puts,
      heldBeforeRelease,
      saved: await savedTerminals(ctx, windowId),
      first: await first.labels(),
      second: await second.labels(),
      live: await liveSessions(ctx, windowId),
      coverId: cover.id,
    };
    await ctx.shot("coview-first", first.page);
    await ctx.shot("coview-second", second.page);
    assert.deepEqual(outcome.secondPagePuts, [], `co-view: the loading page writes nothing; ${JSON.stringify(outcome)}`);
    assert.ok(outcome.saved.some((tab) => tab.name === names.cover && tab.id === cover.id), `co-view: the server keeps the new terminal; ${JSON.stringify(outcome)}`);
    assert.ok(outcome.first.includes(names.cover), "co-view: the first page shows it");
    assert.ok(outcome.second.includes(names.cover), "co-view: the loading page shows it");
    assert.ok(outcome.live.some((row) => row.id === cover.id), "co-view: its session is alive");
    return outcome;
  } finally {
    await first.release().catch(() => {});
    await second?.release().catch(() => {});
  }
}

async function reload(ctx, pages, windowId) {
  const names = { one: `${windowId}-one`, two: `${windowId}-two`, cover: `${windowId}-cover` };
  const first = await openTrackedPage(ctx, windowId, "first");
  pages.push(["first", first]);
  try {
    await first.goto(windowUrl(ctx, windowId));
    await ctx.waitWindowLive(windowId);
    const pane = await activePane(ctx, windowId);
    await addTerminal(ctx, windowId, pane, names.one);
    await addTerminal(ctx, windowId, pane, names.two);
    await until(() => savedTerminals(ctx, windowId), hasIds([names.one, names.two]), "reload: two terminals saved");

    first.writes.refuse = true;
    await addTerminal(ctx, windowId, pane, names.cover);
    const original = (await until(first.frames, (frames) => frames.some((frame) => frame.name === names.cover),
      "reload: the new terminal's session on the page")).find((frame) => frame.name === names.cover);
    // A save that carries the id has been asked for, so the tab's reload
    // snapshot holds it; the server never gets it.
    await until(async () => first.writes.puts, (puts) => puts.some((row) => row.status === "refused" &&
      Array.isArray(row.terminals) && row.terminals.some((tab) => tab.name === names.cover && tab.id === original.id)),
      "reload: a save carrying the new terminal's id refused");
    assert.ok(!hasIds([names.cover])(await savedTerminals(ctx, windowId)), "reload: setup: the server's layout lacks the new terminal");

    await first.page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
    await first.page.waitForSelector(".pane", { timeout: 30_000 });
    // The new terminal's tab attaches under its name or, as a new shell, under
    // a suffixed one; either has its frame before the settle.
    await settleAttached(first, "reload", [names.one, names.two]);
    const frames = await first.frames();
    const outcome = {
      frames,
      labels: await first.labels(),
      live: await liveSessions(ctx, windowId),
      originalId: original.id,
    };
    await ctx.shot("reload", first.page);
    const reattached = frames.find((frame) => frame.name === names.cover || frame.name === `${names.cover}-2`);
    assert.equal(reattached?.id, original.id, `reload: the new terminal re-attaches its session; ${JSON.stringify(outcome)}`);
    assert.ok(!outcome.live.some((row) => row.name === `${names.cover}-2`), "reload: no second shell under its name");
    assert.ok(outcome.labels.includes(names.cover), "reload: the page shows it");
    return outcome;
  } finally {
    first.writes.refuse = false;
  }
}

async function copiedUrl(ctx, pages, windowId) {
  const names = { one: `${windowId}-one`, two: `${windowId}-two`, cover: `${windowId}-cover`, four: `${windowId}-four` };
  const first = await openTrackedPage(ctx, windowId, "first");
  pages.push(["first", first]);
  await first.goto(windowUrl(ctx, windowId));
  await ctx.waitWindowLive(windowId);
  const pane = await activePane(ctx, windowId);
  for (const name of [names.one, names.two]) await addTerminal(ctx, windowId, pane, name);
  await until(() => savedTerminals(ctx, windowId), hasIds([names.one, names.two]), "copy: two terminals saved");
  const copied = await until(async () => first.page.url(), (href) => decodeURIComponent(new URL(href).hash).includes(names.two),
    "copy: the first page's hash names the second terminal");

  // After the copy the window gains two terminals and closes one the copy
  // names, so it holds one terminal more than the copy.
  await addTerminal(ctx, windowId, pane, names.cover);
  await addTerminal(ctx, windowId, pane, names.four);
  await shell(ctx, windowId, ["terminal", "close", "--tab-name", names.two]);
  const window = await until(() => savedTerminals(ctx, windowId), (saved) => hasIds([names.one, names.cover, names.four])(saved) &&
    !saved.some((tab) => tab.name === names.two), "copy: the window gained one terminal and closed one");

  // The page keeps its bearer in session storage and drops it from the
  // address bar, so the copy is opened with the token added, as a gateway's
  // sign-in authenticates a copied URL.
  const copy = new URL(copied);
  copy.searchParams.set("t", new URL(ctx.serverUrl).searchParams.get("t") ?? "");
  const second = await openTrackedPage(ctx, windowId, "second");
  pages.push(["second", second]);
  await second.goto(copy.href);
  // The window's first two terminals, which a copy restored over it shows too.
  await settleAttached(second, "copy second page", [names.one, names.cover]);
  const outcome = {
    secondPagePuts: second.writes.puts,
    window,
    saved: await savedTerminals(ctx, windowId),
    second: await second.labels(),
    live: await liveSessions(ctx, windowId),
  };
  await ctx.shot("copy-second", second.page);
  assert.deepEqual(outcome.secondPagePuts, [], `copy: the copied page writes nothing; ${JSON.stringify(outcome)}`);
  assert.deepEqual(outcome.saved, window, "copy: the server keeps the window's layout");
  for (const name of [names.one, names.cover, names.four]) {
    assert.ok(outcome.second.includes(name), `copy: the copied page shows the window's ${name}`);
  }
  assert.ok(!outcome.second.includes(names.two), "copy: no tab for the terminal the window closed");
  assert.ok(!outcome.live.some((row) => row.name === names.two || row.name === `${names.two}-2`), "copy: no shell spawned for it");
  return outcome;
}

/// Close every terminal the arm's window holds, while its pages are open so they
/// take the layout change, and wait until the window lists none. Answers the
/// names closed and the window's sessions after.
async function closeWindowTerminals(ctx, windowId, label) {
  const closed = (await liveSessions(ctx, windowId)).map((row) => row.name);
  for (const name of closed) {
    await shell(ctx, windowId, ["terminal", "close", "--tab-name", name]).catch(() => {});
  }
  const after = await until(() => liveSessions(ctx, windowId), (rows) => rows.length === 0, `${label}: the window lists no session`);
  return { closed, after };
}

/// Run one arm on its window; a failure carries what each of its pages showed,
/// wrote and attached, with a screenshot of each. The arm then closes its
/// window's terminals before its pages; a pass that leaves a session fails.
async function arm(ctx, label, windowId, body) {
  const pages = [];
  try {
    let outcome;
    try {
      outcome = await body(pages, windowId);
    } catch (error) {
      await describeFailure(ctx, label, pages, error);
      await closeWindowTerminals(ctx, windowId, label).catch(() => {});
      throw error;
    }
    return { ...outcome, cleanup: await closeWindowTerminals(ctx, windowId, label) };
  } finally {
    for (const [, tracked] of pages) await tracked.page.close().catch(() => {});
  }
}

async function describeFailure(ctx, label, pages, error) {
  const seen = [];
  for (const [name, tracked] of pages) {
    const state = { page: name, url: null, labels: null, frames: null, puts: tracked.writes.puts };
    try {
      const url = new URL(tracked.page.url());
      url.searchParams.delete("t");
      state.url = url.href;
      state.labels = await tracked.labels();
      state.frames = await tracked.frames();
      await ctx.shot(`${label}-${name}-failure`, tracked.page);
    } catch (inner) {
      state.unreadable = String(inner?.message ?? inner);
    }
    seen.push(state);
  }
  error.smokeDetails = { arm: label, pages: seen };
  error.message = `${error.message}; pages ${JSON.stringify(seen)}`;
}

export default {
  name: "a page loading into a window keeps the window's tabs",
  async run(ctx) {
    if (!ctx.controlSocket) ctx.skip("no control socket to create terminals in a window");
    const arms = (process.env.SMOKE_166_ARMS ?? "coview,reload,copy").split(",");
    const details = {};
    if (arms.includes("coview")) details.coView = await arm(ctx, "coview", "smoke-166-coview", (pages, id) => coView(ctx, pages, id));
    if (arms.includes("reload")) details.reload = await arm(ctx, "reload", "smoke-166-reload", (pages, id) => reload(ctx, pages, id));
    if (arms.includes("copy")) details.copiedUrl = await arm(ctx, "copy", "smoke-166-copy", (pages, id) => copiedUrl(ctx, pages, id));
    return details;
  },
};
