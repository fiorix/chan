// Hybrid Nav collaboration boundary. Two browser clients share one window
// session: conflicting layout writes stale and freeze the local transaction,
// transient terminal/editor activity does not, and authoritative terminal
// metadata arriving through the roster does.

const WINDOW_ID = "hybrid-nav-stale-smoke";
const DOC = "doc.md";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function rendered(value) {
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return value == null ? "" : String(value);
}

function check(condition, message) {
  if (!condition) throw new Error(message);
}

async function dispatchCommand(page, name) {
  await page.evaluate((command) => {
    window.dispatchEvent(
      new CustomEvent("chan:command", { detail: { name: command } }),
    );
  }, name);
}

async function enterHybridNav(page) {
  await page.bringToFront();
  await dispatchCommand(page, "app.pane.mode");
  await page.waitForSelector(".app.pane-mode", { timeout: 10_000 });
}

async function paneCount(page) {
  return page.$$eval(".pane", (panes) => panes.length);
}

async function waitForPaneCount(page, count) {
  await page.bringToFront();
  await page.waitForFunction(
    (wanted) => document.querySelectorAll(".pane").length === wanted,
    { timeout: 20_000, polling: 100 },
    count,
  );
}

async function waitForStale(page) {
  await page.bringToFront();
  await page.waitForFunction(
    () =>
      document
        .querySelector(".pane-mode-stale-warning")
        ?.textContent?.trim() === "Layout changed. Esc to discard.",
    { timeout: 20_000, polling: 100 },
  );
}

async function splitAndCommit(page, expectedPanes) {
  await enterHybridNav(page);
  await page.keyboard.press("/");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".app.pane-mode", {
    hidden: true,
    timeout: 10_000,
  });
  await waitForPaneCount(page, expectedPanes);
}

async function openDoc(page) {
  await page.bringToFront();
  if (!(await page.$(".file-tree, [role=tree]"))) {
    await dispatchCommand(page, "app.files.toggle");
    await page.waitForSelector('[role="treeitem"]', { timeout: 15_000 });
  }
  const selected = await page.evaluate((filename) => {
    const row = [
      ...document.querySelectorAll('[role="treeitem"] button.name'),
    ].find((button) => button.textContent?.trim() === filename);
    if (!row) return false;
    row.click();
    return true;
  }, DOC);
  if (!selected) throw new Error(`tree row not found: ${DOC}`);
  const opened = await page.evaluate(() => {
    const button = [...document.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === "Open",
    );
    if (!button) return false;
    button.click();
    return true;
  });
  if (!opened) throw new Error("file inspector Open button not found");
  await page.waitForSelector(".cm-content", { timeout: 30_000 });
}

async function selectTab(page, label) {
  await page.bringToFront();
  await page.waitForFunction(
    (wanted) =>
      [...document.querySelectorAll(".tab .path")].some(
        (node) => node.textContent?.trim() === wanted,
      ),
    { timeout: 20_000, polling: 100 },
    label,
  );
  const clicked = await page.evaluate((wanted) => {
    const labelNode = [...document.querySelectorAll(".tab .path")].find(
      (node) => node.textContent?.trim() === wanted,
    );
    const tab = labelNode?.closest(".tab");
    if (!(tab instanceof HTMLElement)) return false;
    tab.click();
    return true;
  }, label);
  if (!clicked) throw new Error(`tab not clickable: ${label}`);
}

function terminalRows(payload) {
  return Object.entries(payload.groups ?? {}).flatMap(([group, rows]) =>
    (Array.isArray(rows) ? rows : []).map((row) => ({ group, ...row })),
  );
}

async function poll(read, accept, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  let lastError;
  while (Date.now() < deadline) {
    try {
      last = await read();
      if (accept(last)) return last;
    } catch (error) {
      lastError = error;
    }
    await sleep(200);
  }
  throw new Error(
    `${label} did not settle; last=${JSON.stringify(last)} ` +
      `error=${lastError?.message ?? "none"}`,
  );
}

async function renameTerminalSession(page, sessionId, oldName, newName, group) {
  return page.evaluate(
    ({ sessionId, oldName, newName, group, windowId }) =>
      new Promise((resolve, reject) => {
        const token =
          sessionStorage.getItem("chan.token") ??
          new URLSearchParams(location.search).get("t") ??
          "";
        const url = new URL("/api/terminal/ws", location.origin);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        url.searchParams.set("cols", "80");
        url.searchParams.set("rows", "24");
        url.searchParams.set("tab_name", oldName);
        url.searchParams.set("window_id", windowId);
        url.searchParams.set("session", sessionId);
        url.searchParams.set("since", "0");
        url.searchParams.set("agent_echo_since", "0");
        if (token) url.searchParams.set("t", token);

        const socket = new WebSocket(url);
        const timer = setTimeout(() => {
          socket.close();
          reject(new Error("terminal metadata rename timed out"));
        }, 20_000);
        let proposed = false;
        socket.addEventListener("message", (event) => {
          if (typeof event.data !== "string") return;
          const frame = JSON.parse(event.data);
          if (frame.type === "session" && !proposed) {
            proposed = true;
            socket.send(
              JSON.stringify({ type: "rename", name: newName, group }),
            );
          } else if (frame.type === "renamed") {
            clearTimeout(timer);
            socket.close();
            resolve(frame);
          } else if (frame.type === "rename_failed") {
            clearTimeout(timer);
            socket.close();
            reject(
              new Error(frame.message ?? "terminal metadata rename failed"),
            );
          }
        });
        socket.addEventListener("error", () => {
          clearTimeout(timer);
          reject(new Error("terminal metadata socket failed"));
        });
      }),
    { sessionId, oldName, newName, group, windowId: WINDOW_ID },
  );
}

export default {
  name: "Hybrid Nav staged chips and stale collaboration boundary",
  async run(ctx) {
    const sharedUrl = new URL(ctx.serverUrl);
    sharedUrl.searchParams.set("w", WINDOW_ID);
    const pageA = await ctx.browser.newPage();
    const pageB = await ctx.browser.newPage();
    const createRequests = [];
    pageA.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (
        request.method() === "POST" &&
        (path.endsWith("/api/drafts/new") || path.endsWith("/api/diagrams/new"))
      ) {
        createRequests.push(path);
      }
    });

    const cli = (args) =>
      ctx.exec(ctx.chanBin, ["shell", "terminal", ...args], {
        cwd: ctx.workspaceDir,
        env: {
          ...process.env,
          CHAN_CONTROL_SOCKET: ctx.controlSocket,
          CHAN_WINDOW_ID: WINDOW_ID,
          CHAN_WORKSPACE_PATH: ctx.workspaceDir,
        },
        timeout: 90_000,
      });

    let terminalName = null;
    try {
      for (const page of [pageA, pageB]) {
        await page.goto(sharedUrl.href, {
          waitUntil: "domcontentloaded",
          timeout: 60_000,
        });
        await page.waitForSelector(".pane", { timeout: 30_000 });
      }
      // The panes are mounted; the server does not necessarily know the window
      // yet, and the `cs` calls below address it by id.
      await ctx.waitWindowLive(WINDOW_ID);

      // A owns a local transaction with two path-less editor intents.
      await enterHybridNav(pageA);
      await pageA.keyboard.press("n");
      await pageA.keyboard.press("i");
      await pageA.waitForFunction(
        () => document.querySelectorAll(".staged-editor").length === 2,
        { timeout: 10_000 },
      );
      const stagedLabels = await pageA.$$eval(".staged-editor .path", (nodes) =>
        nodes.map((node) => node.textContent?.trim()),
      );
      check(
        JSON.stringify(stagedLabels) ===
          JSON.stringify(["New draft", "New diagram"]),
        `unexpected staged labels: ${JSON.stringify(stagedLabels)}`,
      );

      // B writes two successive shared layouts. A retains its one-pane draft
      // and queues only the newest remote tree.
      await splitAndCommit(pageB, 2);
      await waitForStale(pageA);
      await splitAndCommit(pageB, 3);
      await sleep(2_000);
      await pageA.bringToFront();
      check(
        (await paneCount(pageA)) === 1,
        "stale transaction reconciled early",
      );
      check(
        (await pageA.$$(".staged-editor.stale")).length === 2,
        "staged editor chips were not dimmed while stale",
      );
      check(
        await pageA.$$eval(".staged-editor .close", (buttons) =>
          buttons.every((button) => button.disabled),
        ),
        "stale staged editor removal remained enabled",
      );

      // Enter plus two mutation keys are inert and cannot allocate files.
      await pageA.keyboard.press("Enter");
      await pageA.keyboard.press("/");
      await pageA.keyboard.press("n");
      await sleep(500);
      check(await pageA.$(".app.pane-mode"), "stale Enter exited Hybrid Nav");
      check(
        (await paneCount(pageA)) === 1,
        "stale split mutation changed the draft",
      );
      check(
        (await pageA.$$(".staged-editor")).length === 2,
        "stale editor staging changed the queue",
      );
      check(
        createRequests.length === 0,
        "stale Enter created a draft or diagram",
      );

      await pageA.keyboard.press("Escape");
      await pageA.waitForSelector(".app.pane-mode", {
        hidden: true,
        timeout: 10_000,
      });
      await waitForPaneCount(pageA, 3);
      await ctx.shot("hybrid-nav-newest-layout-after-escape", pageA);

      // Establish a terminal and a shared editor before opening the next
      // transaction. Their output/content updates are explicitly excluded.
      await dispatchCommand(pageA, "app.terminal.toggle");
      await pageA.waitForSelector(".terminal-tab", { timeout: 30_000 });
      const terminalPayload = await poll(
        async () =>
          JSON.parse(rendered((await cli(["list", "--json"])).stdout)),
        (payload) =>
          terminalRows(payload).some((row) => row.window === WINDOW_ID),
        "terminal registration",
      );
      const terminal = terminalRows(terminalPayload).find(
        (row) => row.window === WINDOW_ID,
      );
      terminalName = terminal?.name ?? null;
      check(
        terminalName && terminal?.session_id,
        "registered terminal lacks identity",
      );

      await openDoc(pageA);
      await selectTab(pageB, DOC);
      await pageB.waitForSelector(".cm-content", { timeout: 30_000 });
      await selectTab(pageA, DOC);
      await sleep(1_500);

      await enterHybridNav(pageA);
      const outputMarker = `HYBRID-OUTPUT-${Date.now()}`;
      await cli([
        "write",
        "--tab-name",
        terminalName,
        `printf '${outputMarker}\\n'\n`,
      ]);
      await poll(
        async () =>
          rendered(
            (await cli(["scrollback", "--tab-name", terminalName])).stdout,
          ),
        (scrollback) => scrollback.includes(outputMarker),
        "terminal output",
      );

      const editMarker = `HYBRID-EDIT-${Date.now()}`;
      await pageB.bringToFront();
      await pageB.click(".cm-content");
      await pageB.keyboard.down("Control");
      await pageB.keyboard.press("Home");
      await pageB.keyboard.up("Control");
      await pageB.keyboard.type(`${editMarker} `, { delay: 10 });
      check(
        await pageB.$eval(
          ".cm-content",
          (editor, marker) => editor.textContent?.includes(marker),
          editMarker,
        ),
        "collaborator editor did not accept the content update",
      );
      await sleep(1_000);
      await pageA.bringToFront();
      check(
        !(await pageA.$(".pane-mode-stale-warning")),
        "terminal output or file content made Hybrid Nav stale",
      );
      await pageA.keyboard.press("Escape");
      await pageA.waitForSelector(".app.pane-mode", {
        hidden: true,
        timeout: 10_000,
      });

      // A server-settled name/group pair arrives through the terminal roster.
      // It updates the live tab first, then stales the open transaction.
      await enterHybridNav(pageA);
      const renamed = `${terminalName}-renamed`;
      const renamedFrame = await renameTerminalSession(
        pageB,
        terminal.session_id,
        terminalName,
        renamed,
        "hybrid-smoke",
      );
      check(
        renamedFrame.name === renamed && renamedFrame.group === "hybrid-smoke",
        `unexpected settled metadata: ${JSON.stringify(renamedFrame)}`,
      );
      terminalName = renamed;
      await waitForStale(pageA);
      const renamedPayload = await poll(
        async () =>
          JSON.parse(rendered((await cli(["list", "--json"])).stdout)),
        (payload) =>
          terminalRows(payload).some(
            (row) => row.name === renamed && row.group === "hybrid-smoke",
          ),
        "settled terminal metadata",
      );
      check(
        terminalRows(renamedPayload).length > 0,
        "terminal roster disappeared",
      );
      await pageA.keyboard.press("Escape");
      await pageA.waitForSelector(".app.pane-mode", {
        hidden: true,
        timeout: 10_000,
      });
      await pageA.waitForFunction(
        (label) =>
          [...document.querySelectorAll(".tab .path")].some(
            (node) => node.textContent?.trim() === label,
          ),
        { timeout: 20_000, polling: 100 },
        renamed,
      );
      await ctx.shot("hybrid-nav-roster-metadata-stale", pageA);

      return {
        stagedLabels,
        newestPaneCount: await paneCount(pageA),
        createRequests,
        outputMarker,
        editMarker,
        renamed,
      };
    } finally {
      if (terminalName) {
        await cli(["close", "--tab-name", terminalName]).catch(() => {});
      }
      if (!pageB.isClosed()) await pageB.close().catch(() => {});
      if (!pageA.isClosed()) await pageA.close().catch(() => {});
    }
  },
};
