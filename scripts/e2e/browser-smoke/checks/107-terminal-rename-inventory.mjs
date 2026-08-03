// Server-authoritative terminal metadata, end to end.
//
// Browsers A and B co-view one window while C owns another. The check drives
// real terminal WebSockets and the real `cs terminal` client to prove that a
// settled name/group pair converges through acknowledgements, roster updates,
// reload, Hybrid Nav staleness, inventory, and every by-name operation.

const WINDOW_AB = "terminal-rename-shared-107";
const WINDOW_C = "terminal-rename-other-107";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function rendered(value) {
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return value == null ? "" : String(value);
}

function check(condition, message) {
  if (!condition) throw new Error(message);
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

function terminalRows(payload) {
  return Object.entries(payload.groups ?? {}).flatMap(([group, rows]) =>
    (Array.isArray(rows) ? rows : []).map((row) => ({ group, ...row })),
  );
}

function terminalWsUrl(serverUrl, sessionId, windowId, queryName, queryGroup) {
  const server = new URL(serverUrl);
  const token = server.searchParams.get("t") ?? "";
  const url = new URL("/api/terminal/ws", server);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("cols", "80");
  url.searchParams.set("rows", "24");
  url.searchParams.set("tab_name", queryName);
  url.searchParams.set("tab_group", queryGroup);
  url.searchParams.set("window_id", windowId);
  url.searchParams.set("session", sessionId);
  url.searchParams.set("since", "0");
  url.searchParams.set("agent_echo_since", "0");
  if (token) url.searchParams.set("t", token);
  return url.toString();
}

async function dispatchCommand(page, name) {
  await page.evaluate((command) => {
    window.dispatchEvent(
      new CustomEvent("chan:command", { detail: { name: command } }),
    );
  }, name);
}

async function openWindow(page, serverUrl, windowId, waitUntil = "domcontentloaded") {
  const url = new URL(serverUrl);
  url.searchParams.set("w", windowId);
  await page.goto(url.href, { waitUntil, timeout: 60_000 });
  await page.waitForSelector(".pane", { timeout: 30_000 });
}

async function waitForTab(page, label) {
  await page.bringToFront();
  await poll(
    () =>
      page.$$eval(".tab .path", (nodes) =>
        nodes.map((node) => node.textContent?.trim() ?? ""),
      ),
    (labels) => labels.includes(label),
    `tab ${JSON.stringify(label)}`,
  );
}

async function openTerminalMenu(page, label) {
  await waitForTab(page, label);
  const tabs = await page.$$(".tab");
  for (const tab of tabs) {
    const text = await tab.$eval(".path", (node) => node.textContent?.trim() ?? "");
    if (text !== label) continue;
    await tab.click({ button: "right" });
    await page.waitForSelector(".terminal-tab-menu-bubble", { timeout: 10_000 });
    return;
  }
  throw new Error(`terminal tab not clickable: ${label}`);
}

async function closeTerminalMenu(page) {
  await page.evaluate(() => {
    document
      .querySelector(".terminal-tab")
      ?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  });
  await page.waitForSelector(".terminal-tab-menu-bubble", {
    hidden: true,
    timeout: 10_000,
  });
}

async function terminalMenuSnapshot(page) {
  return page.$eval(".terminal-tab-menu-bubble", (menu) => ({
    drafts: [...menu.querySelectorAll(".rename-input")].map((input) => input.value),
    targets: [...menu.querySelectorAll(".target-name")].map(
      (node) => node.textContent?.trim() ?? "",
    ),
    hasOtherWindows: !!menu.querySelector(".broadcast-other-windows-label"),
  }));
}

// Keep a raw attach socket in the page so two browser clients can prepare
// first, then send their proposals back-to-back while both connections live.
async function prepareRename(page, { key, sessionId, queryName, queryGroup, windowId }) {
  return page.evaluate(
    ({ key, sessionId, queryName, queryGroup, windowId }) =>
      new Promise((resolve, reject) => {
        const states = (globalThis.__chanTerminalRenameSmoke107 ??= {});
        states[key]?.socket?.close();
        const state = {
          socket: null,
          prelude: null,
          result: null,
          error: null,
        };
        states[key] = state;

        const token =
          sessionStorage.getItem("chan.token") ??
          new URLSearchParams(location.search).get("t") ??
          "";
        const url = new URL("/api/terminal/ws", location.origin);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        url.searchParams.set("cols", "80");
        url.searchParams.set("rows", "24");
        url.searchParams.set("tab_name", queryName);
        url.searchParams.set("tab_group", queryGroup);
        url.searchParams.set("window_id", windowId);
        url.searchParams.set("session", sessionId);
        url.searchParams.set("since", "0");
        url.searchParams.set("agent_echo_since", "0");
        if (token) url.searchParams.set("t", token);

        const socket = new WebSocket(url);
        state.socket = socket;
        const timer = setTimeout(() => {
          state.error = "terminal metadata attach timed out";
          socket.close();
          reject(new Error(state.error));
        }, 20_000);
        socket.addEventListener("message", (event) => {
          if (typeof event.data !== "string") return;
          const frame = JSON.parse(event.data);
          if (frame.type === "session" && !state.prelude) {
            state.prelude = frame;
            clearTimeout(timer);
            resolve(frame);
          } else if (frame.type === "renamed") {
            state.result = frame;
            socket.close();
          } else if (frame.type === "rename_failed") {
            state.error = frame.message ?? "terminal metadata rename failed";
            socket.close();
          }
        });
        socket.addEventListener("error", () => {
          state.error ??= "terminal metadata socket failed";
          clearTimeout(timer);
          if (!state.prelude) reject(new Error(state.error));
        });
      }),
    { key, sessionId, queryName, queryGroup, windowId },
  );
}

async function sendPreparedRename(page, key, name, group) {
  await page.evaluate(
    ({ key, name, group }) => {
      const state = globalThis.__chanTerminalRenameSmoke107?.[key];
      if (!state?.socket || state.socket.readyState !== WebSocket.OPEN) {
        throw new Error(`prepared terminal socket is not open: ${key}`);
      }
      state.socket.send(JSON.stringify({ type: "rename", name, group }));
    },
    { key, name, group },
  );
}

async function waitPreparedRename(page, key) {
  await page.waitForFunction(
    (stateKey) => {
      const state = globalThis.__chanTerminalRenameSmoke107?.[stateKey];
      return !!state?.result || !!state?.error;
    },
    { timeout: 20_000, polling: 100 },
    key,
  );
  const outcome = await page.evaluate((stateKey) => {
    const state = globalThis.__chanTerminalRenameSmoke107?.[stateKey];
    return { result: state?.result ?? null, error: state?.error ?? null };
  }, key);
  if (outcome.error) throw new Error(outcome.error);
  return outcome.result;
}

async function closePreparedRename(page, key) {
  await page
    .evaluate((stateKey) => {
      const states = globalThis.__chanTerminalRenameSmoke107;
      states?.[stateKey]?.socket?.close();
      if (states) delete states[stateKey];
    }, key)
    .catch(() => {});
}

async function renameOnce(page, options, name, group) {
  await prepareRename(page, options);
  await sendPreparedRename(page, options.key, name, group);
  return waitPreparedRename(page, options.key);
}

async function expectSelectorFailure(cli, args, label) {
  let failure = null;
  try {
    await cli(args);
  } catch (error) {
    failure = error;
  }
  check(failure, `${label} unexpectedly matched a terminal`);
  const text = `${rendered(failure.stdout)}${rendered(failure.stderr)}${failure.message}`;
  check(/no live terminal session matched/i.test(text), `${label} failed unexpectedly: ${text}`);
  return text;
}

export default {
  name: "terminal rename reaches inventory",
  async run(ctx) {
    if (!ctx.controlSocket) ctx.skip("control socket not found for the server pid");
    const pageA = await ctx.browser.newPage();
    const pageB = await ctx.browser.newPage();
    const pageC = await ctx.browser.newPage();
    const suffix = Date.now().toString(36).slice(-6);
    const collisionName = `r107${suffix}`;
    const finalName = `r107${suffix}f`;
    const finalGroup = `r107g${suffix}`;

    const cli = (args) =>
      ctx.exec(ctx.chanBin, ["shell", "terminal", ...args], {
        cwd: ctx.workspaceDir,
        env: {
          ...process.env,
          CHAN_CONTROL_SOCKET: ctx.controlSocket,
          CHAN_WINDOW_ID: WINDOW_AB,
          CHAN_WORKSPACE_PATH: ctx.workspaceDir,
        },
        timeout: 90_000,
      });
    const list = async () => JSON.parse(rendered((await cli(["list", "--json"])).stdout));

    let sessionA = null;
    let sessionC = null;
    let liveNameA = null;
    let liveNameC = null;
    try {
      // Let both views of the shared window finish their initial empty-layout
      // reconciliation before either view creates a terminal.
      await openWindow(pageA, ctx.serverUrl, WINDOW_AB, "networkidle2");
      await openWindow(pageB, ctx.serverUrl, WINDOW_AB, "networkidle2");
      await openWindow(pageC, ctx.serverUrl, WINDOW_C);

      await pageA.bringToFront();
      await dispatchCommand(pageA, "app.terminal.toggle");
      await pageA.waitForSelector(".terminal-tab", { timeout: 30_000 });
      await pageC.bringToFront();
      await dispatchCommand(pageC, "app.terminal.toggle");
      await pageC.waitForSelector(".terminal-tab", { timeout: 30_000 });

      const initial = await poll(
        list,
        (payload) => {
          const rows = terminalRows(payload);
          return (
            rows.some((row) => row.window === WINDOW_AB) &&
            rows.some((row) => row.window === WINDOW_C)
          );
        },
        "terminal registration in both windows",
      );
      const initialA = terminalRows(initial).find((row) => row.window === WINDOW_AB);
      const initialC = terminalRows(initial).find((row) => row.window === WINDOW_C);
      check(initialA?.session_id && initialA?.name, "browser A terminal lacks identity");
      check(initialC?.session_id && initialC?.name, "browser C terminal lacks identity");
      sessionA = initialA.session_id;
      sessionC = initialC.session_id;
      liveNameA = initialA.name;
      liveNameC = initialC.name;
      const spawnNameA = initialA.name;
      const spawnNameC = initialC.name;
      await Promise.all([
        waitForTab(pageA, liveNameA),
        waitForTab(pageB, liveNameA),
        waitForTab(pageC, liveNameC),
      ]);

      // Both clients attach first, then send back-to-back without awaiting
      // either acknowledgement. The registry settles the shared collision.
      await Promise.all([
        prepareRename(pageA, {
          key: "collision-a",
          sessionId: sessionA,
          queryName: liveNameA,
          queryGroup: "default",
          windowId: WINDOW_AB,
        }),
        prepareRename(pageC, {
          key: "collision-c",
          sessionId: sessionC,
          queryName: liveNameC,
          queryGroup: "default",
          windowId: WINDOW_C,
        }),
      ]);
      await sendPreparedRename(pageA, "collision-a", collisionName, "default");
      await sendPreparedRename(pageC, "collision-c", collisionName, "default");
      const [settledA, settledC] = await Promise.all([
        waitPreparedRename(pageA, "collision-a"),
        waitPreparedRename(pageC, "collision-c"),
      ]);
      check(
        settledA?.name === collisionName && settledA?.group === "default",
        `browser A settled unexpectedly: ${JSON.stringify(settledA)}`,
      );
      check(
        settledC?.name === `${collisionName}-2` && settledC?.group === "default",
        `browser C settled unexpectedly: ${JSON.stringify(settledC)}`,
      );
      liveNameA = settledA.name;
      liveNameC = settledC.name;

      await Promise.all([
        waitForTab(pageA, liveNameA),
        waitForTab(pageB, liveNameA),
        waitForTab(pageC, liveNameC),
      ]);
      const collidedInventory = await poll(
        list,
        (payload) => {
          const rows = terminalRows(payload);
          return (
            rows.some(
              (row) =>
                row.session_id === sessionA &&
                row.name === liveNameA &&
                row.spawn_name === spawnNameA,
            ) &&
            rows.some(
              (row) =>
                row.session_id === sessionC &&
                row.name === liveNameC &&
                row.spawn_name === spawnNameC,
            )
          );
        },
        "settled collision inventory",
      );
      check(
        terminalRows(collidedInventory).every((row) =>
          Object.prototype.hasOwnProperty.call(row, "spawn_name"),
        ),
        "terminal JSON omitted a spawn_name key",
      );
      const humanInventory = rendered((await cli(["list"])).stdout);
      check(/\|\s*spawn\s*\|/i.test(humanInventory), "Markdown inventory lacks spawn column");
      check(
        humanInventory.includes(spawnNameA) && humanInventory.includes(spawnNameC),
        "Markdown inventory lacks spawn provenance values",
      );

      // The Linux fdstore harness uses a process-level WebSocket probe because
      // systemd handoff cannot run inside Chrome. Exercise both its prelude and
      // rename-ack paths against this throwaway server before relying on it.
      const helperUrl = terminalWsUrl(
        ctx.serverUrl,
        sessionC,
        WINDOW_C,
        spawnNameC,
        "stale-helper-query",
      );
      const helperResult = JSON.parse(
        rendered(
          (
            await ctx.exec(
              process.execPath,
              [
                "--experimental-websocket",
                `${ctx.repoRoot}/scripts/e2e/terminal-metadata-ws.mjs`,
                helperUrl,
                liveNameC,
                "default",
              ],
              { timeout: 30_000 },
            )
          ).stdout,
        ),
      );
      check(
        helperResult.session?.name === liveNameC &&
          helperResult.session?.group === "default" &&
          helperResult.session?.spawn_name === spawnNameC &&
          helperResult.session?.spawn_group === "default",
        `process probe returned a stale prelude: ${JSON.stringify(helperResult)}`,
      );
      check(
        helperResult.renamed?.name === liveNameC &&
          helperResult.renamed?.group === "default",
        `process probe returned a bad rename ack: ${JSON.stringify(helperResult)}`,
      );

      // Same-group C is initially a cross-window broadcast member of A.
      await openTerminalMenu(pageA, liveNameA);
      const beforeGroup = await terminalMenuSnapshot(pageA);
      check(beforeGroup.hasOtherWindows, "same-group cross-window section is missing");
      check(
        beforeGroup.targets.some((name) => name.includes(liveNameC)),
        `browser C is absent from A's default-group members: ${JSON.stringify(beforeGroup)}`,
      );
      await closeTerminalMenu(pageA);

      const groupAck = await renameOnce(
        pageA,
        {
          key: "group-a",
          sessionId: sessionA,
          queryName: liveNameA,
          queryGroup: "default",
          windowId: WINDOW_AB,
        },
        liveNameA,
        finalGroup,
      );
      check(
        groupAck?.name === liveNameA && groupAck?.group === finalGroup,
        `group update settled unexpectedly: ${JSON.stringify(groupAck)}`,
      );

      await openTerminalMenu(pageB, liveNameA);
      await pageB.waitForFunction(
        (group) =>
          document.querySelectorAll(".rename-input")[1]?.value === group,
        { timeout: 20_000, polling: 100 },
        finalGroup,
      );
      const observedByB = await terminalMenuSnapshot(pageB);
      check(
        observedByB.drafts[1] === finalGroup,
        `browser B kept the old group: ${JSON.stringify(observedByB)}`,
      );
      await closeTerminalMenu(pageB);

      await openTerminalMenu(pageA, liveNameA);
      const afterGroup = await terminalMenuSnapshot(pageA);
      check(
        !afterGroup.targets.some((name) => name.includes(liveNameC)),
        `old-group browser C remained in A's broadcast members: ${JSON.stringify(afterGroup)}`,
      );
      await closeTerminalMenu(pageA);

      // A stale creation query must not overwrite the existing session, and a
      // full browser reload must converge on the same settled pair.
      const stalePrelude = await prepareRename(pageA, {
        key: "stale-query",
        sessionId: sessionA,
        queryName: spawnNameA,
        queryGroup: "stale-query-group",
        windowId: WINDOW_AB,
      });
      check(
        stalePrelude.name === liveNameA && stalePrelude.group === finalGroup,
        `reattach query overwrote live metadata: ${JSON.stringify(stalePrelude)}`,
      );
      await closePreparedRename(pageA, "stale-query");

      await pageB.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
      await pageB.waitForSelector(".pane", { timeout: 30_000 });
      await openTerminalMenu(pageB, liveNameA);
      await pageB.waitForFunction(
        (group) =>
          document.querySelectorAll(".rename-input")[1]?.value === group,
        { timeout: 20_000, polling: 100 },
        finalGroup,
      );
      await closeTerminalMenu(pageB);

      // A server-settled rename while B holds Hybrid Nav must stale and freeze
      // B's transaction. Escape adopts the authoritative layout/metadata.
      await pageB.bringToFront();
      await dispatchCommand(pageB, "app.pane.mode");
      await pageB.waitForSelector(".app.pane-mode", { timeout: 10_000 });
      const oldLiveName = liveNameA;
      const finalAck = await renameOnce(
        pageA,
        {
          key: "final-a",
          sessionId: sessionA,
          queryName: oldLiveName,
          queryGroup: finalGroup,
          windowId: WINDOW_AB,
        },
        finalName,
        finalGroup,
      );
      check(
        finalAck?.name === finalName && finalAck?.group === finalGroup,
        `final metadata settled unexpectedly: ${JSON.stringify(finalAck)}`,
      );
      liveNameA = finalName;
      await pageB.waitForFunction(
        () =>
          document.querySelector(".pane-mode-stale-warning")?.textContent?.trim() ===
          "Layout changed. Esc to discard.",
        { timeout: 20_000, polling: 100 },
      );
      await ctx.shot("hybrid-nav-stale-after-terminal-rename", pageB);
      await pageB.keyboard.press("Escape");
      await pageB.waitForSelector(".app.pane-mode", { hidden: true, timeout: 10_000 });
      await Promise.all([waitForTab(pageA, finalName), waitForTab(pageB, finalName)]);

      const finalInventory = await poll(
        list,
        (payload) =>
          terminalRows(payload).some(
            (row) =>
              row.session_id === sessionA &&
              row.name === finalName &&
              row.group === finalGroup &&
              row.spawn_name === spawnNameA,
          ),
        "final live/spawn inventory",
      );
      check(terminalRows(finalInventory).length >= 2, "terminal roster lost a session");

      // Neither the previous live name nor immutable spawn provenance is an
      // alias. Exercise every by-name operation against both before using the
      // final settled name successfully.
      check(oldLiveName !== spawnNameA, "old live name must differ from spawn name");
      for (const alias of [oldLiveName, spawnNameA]) {
        await expectSelectorFailure(
          cli,
          ["write", "--tab-name", alias, "printf 'SHOULD_NOT_RUN\\n'\n"],
          `write by stale alias ${alias}`,
        );
        await expectSelectorFailure(
          cli,
          ["scrollback", "--tab-name", alias],
          `scrollback by stale alias ${alias}`,
        );
        await expectSelectorFailure(
          cli,
          ["restart", "--tab-name", alias],
          `restart by stale alias ${alias}`,
        );
        await expectSelectorFailure(
          cli,
          ["close", "--tab-name", alias],
          `close by stale alias ${alias}`,
        );
      }

      const outputMarker = `R107_OUTPUT_${suffix}`;
      await cli([
        "write",
        "--tab-name",
        finalName,
        `printf '${outputMarker}\\n'\n`,
      ]);
      const scrollback = await poll(
        async () => rendered((await cli(["scrollback", "--tab-name", finalName])).stdout),
        (text) => text.includes(outputMarker),
        "write and scrollback by settled name",
      );
      check(scrollback.includes(outputMarker), "settled-name scrollback lost output");

      await cli(["restart", "--tab-name", finalName]);
      await poll(
        list,
        (payload) =>
          terminalRows(payload).some(
            (row) =>
              row.session_id === sessionA &&
              row.name === finalName &&
              row.group === finalGroup &&
              row.spawn_name === finalName,
          ),
        "restart spawn provenance",
        45_000,
      );
      const restartedPrelude = await prepareRename(pageA, {
        key: "restarted-prelude",
        sessionId: sessionA,
        queryName: spawnNameA,
        queryGroup: "stale-query-group",
        windowId: WINDOW_AB,
      });
      check(
        restartedPrelude.name === finalName &&
          restartedPrelude.group === finalGroup &&
          restartedPrelude.spawn_name === finalName &&
          restartedPrelude.spawn_group === finalGroup,
        `restart prelude did not converge live/spawn pairs: ${JSON.stringify(restartedPrelude)}`,
      );
      await closePreparedRename(pageA, "restarted-prelude");

      await cli(["close", "--tab-name", finalName]);
      await poll(
        list,
        (payload) => !terminalRows(payload).some((row) => row.session_id === sessionA),
        "close by settled name",
      );
      liveNameA = null;
      await ctx.shot("settled-inventory-and-targeting", pageC);

      return {
        collision: { a: settledA, c: settledC },
        spawnNames: { a: spawnNameA, c: spawnNameC },
        finalName,
        finalGroup,
        outputMarker,
      };
    } finally {
      for (const [page, keys] of [
        [pageA, ["collision-a", "group-a", "stale-query", "final-a", "restarted-prelude"]],
        [pageC, ["collision-c"]],
      ]) {
        for (const key of keys) await closePreparedRename(page, key);
      }
      try {
        const payload = await list();
        const leftovers = terminalRows(payload).filter(
          (row) => row.window === WINDOW_AB || row.window === WINDOW_C,
        );
        for (const row of leftovers) {
          await cli(["close", "--tab-name", row.name]).catch(() => {});
        }
      } catch {}
      if (!pageC.isClosed()) await pageC.close().catch(() => {});
      if (!pageB.isClosed()) await pageB.close().catch(() => {});
      if (!pageA.isClosed()) await pageA.close().catch(() => {});
    }
  },
};
