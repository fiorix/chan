// Destructive tail check: remove the harness-owned workspace root while a
// fully expanded File Browser, max-depth Graph, and dirty >2 MiB editor are
// live. This filename MUST remain lexically last: every later check would
// inherit a deliberately missing workspace.

import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const TREE = "root-loss-tree";
const LARGE = "root-loss-large.md";
const DIRTY_MARKER = `ROOT-LOSS-UNSAVED-${Date.now()}`;
const delay = (ms) => new Promise((done) => setTimeout(done, ms));

function seedVisibleTree(root) {
  const dirs = [];
  const files = [];

  function addLevel(parent, depth) {
    if (depth > 4) return;
    for (let branch = 0; branch < 3; branch += 1) {
      const rel = join(parent, `d${depth}-${branch}`);
      mkdirSync(join(root, rel), { recursive: true });
      dirs.push(rel.replaceAll("\\", "/"));
      const file = join(rel, `node-${depth}-${branch}.md`);
      writeFileSync(
        join(root, file),
        `# Root loss ${depth}.${branch}\n\n#root-loss-smoke\n\n[[${LARGE}]]\n`,
      );
      files.push(file.replaceAll("\\", "/"));
      addLevel(rel, depth + 1);
    }
  }

  mkdirSync(join(root, TREE), { recursive: true });
  dirs.push(TREE);
  addLevel(TREE, 1);
  return { dirs, files };
}

function seedLargeEditorFile(root) {
  const target = 2 * 1024 * 1024 + 256 * 1024;
  const line = `root loss large editor line ${"x".repeat(80)} #root-loss-smoke [[${TREE}/d1-0/node-1-0.md]]\n`;
  const chunks = ["# Root loss large editor\n\n"];
  let bytes = Buffer.byteLength(chunks[0]);
  while (bytes < target) {
    chunks.push(line);
    bytes += Buffer.byteLength(line);
  }
  chunks.push("ROOT-LOSS-LARGE-TAIL\n");
  const body = chunks.join("");
  writeFileSync(join(root, LARGE), body);
  return Buffer.byteLength(body);
}

// Deletion ballast lives under a dependency directory excluded by chan's
// tree/index policy. It lengthens the rm window without asking Chromium to
// render thousands of irrelevant rows.
function seedDeletionBallast(root) {
  const ballast = join(root, "node_modules", "root-loss-delete-ballast");
  let files = 0;
  for (let group = 0; group < 120; group += 1) {
    const dir = join(ballast, `g-${String(group).padStart(3, "0")}`);
    mkdirSync(dir, { recursive: true });
    for (let item = 0; item < 100; item += 1) {
      writeFileSync(join(dir, `f-${String(item).padStart(3, "0")}`), "x");
      files += 1;
    }
  }
  return files;
}

async function dispatch(page, name) {
  await page.evaluate((command) => {
    window.dispatchEvent(
      new CustomEvent("chan:command", { detail: { name: command } }),
    );
  }, name);
}

async function activateTab(page, selector, description) {
  const activated = await page.evaluate((tabSelector) => {
    const marker = document.querySelector(tabSelector);
    const tab = marker?.closest(".tab");
    if (!(tab instanceof HTMLElement)) return false;
    tab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    tab.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
    return true;
  }, selector);
  if (!activated) throw new Error(`could not activate retained ${description} tab`);
}

async function api(page, token, path, method = "GET") {
  return page.evaluate(
    async ({ token, path, method }) => {
      try {
        const response = await fetch(path, {
          method,
          headers: token ? { authorization: `Bearer ${token}` } : {},
          signal: AbortSignal.timeout(5_000),
        });
        const body = await response.text();
        return { status: response.status, body: body.slice(0, 500) };
      } catch (error) {
        return { status: 0, body: String(error) };
      }
    },
    { token, path, method },
  );
}

function assertOwnedThrowawayRoot(workspaceDir) {
  const requested = resolve(workspaceDir);
  const canonical = realpathSync(workspaceDir);
  const tempRoot = realpathSync(tmpdir());
  const stat = lstatSync(canonical);

  if (requested !== canonical) {
    throw new Error(`refusing recursive delete through a symlinked path: ${requested}`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`refusing recursive delete of non-directory: ${canonical}`);
  }
  if (dirname(canonical) !== tempRoot) {
    throw new Error(`refusing recursive delete outside harness tmpdir: ${canonical}`);
  }
  if (!basename(canonical).startsWith("chan-smoke-")) {
    throw new Error(`refusing recursive delete of non-smoke root: ${canonical}`);
  }
  return canonical;
}

export default {
  name: "workspace-root-loss",
  async run(ctx) {
    const socket = ctx.controlSocket;
    if (!socket) ctx.skip("control socket not found for the server pid");

    const visible = seedVisibleTree(ctx.workspaceDir);
    const largeBytes = seedLargeEditorFile(ctx.workspaceDir);
    const ballastFiles = seedDeletionBallast(ctx.workspaceDir);
    const token = new URL(ctx.serverUrl).searchParams.get("t");
    const windowUrl = new URL(ctx.serverUrl);
    windowUrl.searchParams.set("w", "smoke-root-loss");

    const page = await ctx.browser.newPage();
    const httpFailures = [];
    const recordHttpFailure = (response) => {
      if (response.status() < 500) return;
      const url = new URL(response.url());
      const failure = {
        method: response.request().method(),
        path: `${url.pathname}${url.search}`,
        status: response.status(),
      };
      httpFailures.push(failure);
      console.log(`[smoke:98] HTTP failure: ${JSON.stringify(failure)}`);
    };
    page.on("response", recordHttpFailure);
    try {
      await page.goto(windowUrl.toString(), {
        waitUntil: "networkidle2",
        timeout: 60_000,
      });
      await page.waitForSelector(".pane", { timeout: 30_000 });

      // Wait for the generated markdown corpus, not merely a transient idle
      // sampled before watcher events reach the indexer.
      await page.waitForFunction(
        async ({ token, expectedDocs }) => {
          const response = await fetch("/api/index/status", {
            headers: token ? { authorization: `Bearer ${token}` } : {},
          });
          if (!response.ok) return false;
          const status = await response.json();
          return (
            status.state === "idle" &&
            status.readiness?.state === "ready" &&
            Number(status.indexed_docs ?? 0) >= expectedDocs
          );
        },
        { timeout: 90_000, polling: 250 },
        { token, expectedDocs: visible.files.length },
      );

      // File Browser: expand every generated directory and prove the deepest
      // layer is actually materialized before moving to the graph.
      await dispatch(page, "app.files.toggle");
      await page.waitForSelector(".pane .browser [role=tree]", {
        timeout: 20_000,
      });
      const titleNeedle = `/${TREE}`;
      for (let round = 0; round < 20; round += 1) {
        const clicked = await page.evaluate((needle) => {
          const buttons = [
            ...document.querySelectorAll(
              '.pane .browser .row.dir button.twirl[aria-label="expand"]',
            ),
          ].filter((button) =>
            button.closest(".row.dir")?.getAttribute("title")?.includes(needle),
          );
          for (const button of buttons) button.click();
          return buttons.length;
        }, titleNeedle);
        if (clicked === 0) {
          const count = await page.evaluate(
            (needle) =>
              [...document.querySelectorAll(".pane .browser .row.dir")]
                .filter((row) => row.getAttribute("title")?.includes(needle))
                .length,
            titleNeedle,
          );
          if (count >= visible.dirs.length) break;
        }
        await page
          .waitForFunction(
            () =>
              ![...document.querySelectorAll(".pane .browser .child-empty")]
                .some((row) => row.textContent?.includes("Loading")),
            { timeout: 20_000, polling: 50 },
          )
          .catch(() => {});
        await delay(75);
      }
      const expanded = await page.evaluate((needle) => {
        const rows = [...document.querySelectorAll(".pane .browser .row.dir")]
          .filter((row) => row.getAttribute("title")?.includes(needle));
        return {
          count: rows.length,
          expanded: rows.filter((row) => row.getAttribute("aria-expanded") === "true").length,
        };
      }, titleNeedle);
      if (
        expanded.count !== visible.dirs.length ||
        expanded.expanded !== visible.dirs.length
      ) {
        throw new Error(
          `generated File Browser tree not fully expanded: ${JSON.stringify(expanded)}, expected ${visible.dirs.length}`,
        );
      }

      // Graph: open from the unselected workspace File Browser context, then
      // drive its real tab-menu depth slider to that scope's computed maximum.
      await dispatch(page, "app.graph.toggle");
      await page.waitForSelector(".graph-tab canvas", { timeout: 30_000 });
      await page.waitForFunction(
        () => {
          const stat = document.querySelector(".graph-tab .statusbar .stat")?.textContent ?? "";
          const match = stat.match(/(\d+)\/(\d+) nodes/);
          return match && Number(match[2]) > 0;
        },
        { timeout: 60_000, polling: 250 },
      );
      await page.click(".tab.active .path", { button: "right" });
      await page.waitForSelector(
        '.tab-menu-bubble[aria-label="graph tab menu"] input[aria-label="depth"]:not([disabled])',
        { timeout: 30_000 },
      );
      const graphDepth = await page.$eval(
        '.tab-menu-bubble[aria-label="graph tab menu"] input[aria-label="depth"]',
        (input) => {
          input.value = input.max;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
          return { value: Number(input.value), max: Number(input.max) };
        },
      );
      if (graphDepth.value !== graphDepth.max || graphDepth.max < 2) {
        throw new Error(`graph did not reach max depth: ${JSON.stringify(graphDepth)}`);
      }
      await page.keyboard.press("Escape");
      await delay(500);

      // Editor: open the large file through the real control socket, wait for
      // streaming completion, and leave a visible dirty edit unsaved.
      const windowId = await page.evaluate(
        () =>
          new URL(location.href).searchParams.get("w")?.trim() ||
          window.sessionStorage.getItem("chan.session.window")?.trim() ||
          "",
      );
      await ctx.exec(ctx.chanBin, ["shell", "open", LARGE], {
        cwd: ctx.workspaceDir,
        env: {
          ...process.env,
          CHAN_CONTROL_SOCKET: socket,
          CHAN_WINDOW_ID: windowId,
        },
        timeout: 30_000,
      });
      await page.waitForFunction(
        (name) =>
          [...document.querySelectorAll(".tab.active")]
            .some((tab) => tab.textContent?.includes(name)) &&
          document.querySelector(".editor-tab .cm-content") !== null &&
          document.querySelector(".editor-tab .loading-toolbar") === null,
        { timeout: 90_000, polling: 250 },
        LARGE,
      );
      await page.click(".editor-tab .cm-content");
      await page.keyboard.down("Control");
      await page.keyboard.press("Home");
      await page.keyboard.up("Control");
      await page.keyboard.type(`${DIRTY_MARKER}\n`, { delay: 1 });
      await page.waitForFunction(
        ({ name, marker }) => {
          const active = [...document.querySelectorAll(".tab.active")]
            .find((tab) => tab.textContent?.includes(name));
          return (
            active?.querySelector(".dirty.unsaved") !== null &&
            (document.querySelector(".editor-tab .cm-content")?.textContent ?? "")
              .includes(marker)
          );
        },
        { timeout: 15_000 },
        { name: LARGE, marker: DIRTY_MARKER },
      );
      await ctx.shot("ready-to-delete", page);

      const canonicalRoot = assertOwnedThrowawayRoot(ctx.workspaceDir);
      const uiTimelinePromise = page.evaluate(
        () =>
          new Promise((resolve) => {
            const started = Date.now();
            const samples = [];
            let last = "";
            const sample = () => {
              const next = JSON.stringify({
                ms: Date.now() - started,
                treeRows: document.querySelectorAll(
                  ".pane .browser [role=treeitem]",
                ).length,
                rootUnavailable: (document.body.innerText ?? "").includes(
                  "Workspace root unavailable",
                ),
                graphStats: [...document.querySelectorAll(
                  ".graph-tab .statusbar .stat",
                )].map((node) => node.textContent?.trim() ?? ""),
                editorMissing: (document.body.innerText ?? "").includes(
                  "File moved or deleted",
                ),
              });
              if (next !== last) {
                samples.push(JSON.parse(next));
                last = next;
              }
              return JSON.parse(next).rootUnavailable;
            };
            const interval = setInterval(() => {
              if (sample() || Date.now() - started > 20_000) {
                clearInterval(interval);
                resolve(samples);
              }
            }, 20);
            sample();
          }),
      );

      let deleteDone = false;
      const deleteStarted = Date.now();
      const deletePromise = ctx
        .exec("/bin/rm", ["-rf", "--", canonicalRoot], {
          cwd: tmpdir(),
          timeout: 60_000,
        })
        .finally(() => {
          deleteDone = true;
        });
      const apiTimeline = [];
      do {
        const [files, graph] = await Promise.all([
          api(page, token, "/api/files?dir="),
          api(page, token, "/api/graph?scope=workspace&depth=10"),
        ]);
        apiTimeline.push({
          ms: Date.now() - deleteStarted,
          rootExists: existsSync(canonicalRoot),
          files: files.status,
          graph: graph.status,
        });
        if (!deleteDone) await delay(10);
      } while (!deleteDone && Date.now() - deleteStarted < 60_000);
      await deletePromise;
      const deleteMs = Date.now() - deleteStarted;

      if (existsSync(canonicalRoot)) {
        throw new Error(`rm returned but workspace root still exists: ${canonicalRoot}`);
      }
      const badIntermediate = apiTimeline.find(
        (sample) =>
          ![200, 404].includes(sample.files) ||
          ![200, 404].includes(sample.graph),
      );
      if (badIntermediate) {
        throw new Error(
          `root deletion produced an unsafe/interrupted API state: ${JSON.stringify(badIntermediate)}`,
        );
      }

      // Inactive tabs are intentionally not mounted. Activate each retained
      // surface before inspecting its post-loss UI; this also proves switching
      // back to it is safe after the backing workspace disappears.
      await activateTab(page, ".tab .lucide-folder", "File Browser");
      await page.waitForFunction(
        () => (document.body.innerText ?? "").includes("Workspace root unavailable"),
        { timeout: 30_000, polling: 100 },
      );
      await activateTab(page, ".tab .lucide-network", "Graph");
      await page.waitForFunction(
        () => {
          const graphs = [...document.querySelectorAll(".graph-tab")];
          return (
            graphs.length === 1 &&
            graphs.every((graph) => {
              const error = graph.querySelector(".placeholder.error")?.textContent ?? "";
              const stat = graph.querySelector(".statusbar .stat")?.textContent ?? "";
              return (
                error.toLowerCase().includes("workspace root does not exist") &&
                /^0\/0 nodes/.test(stat.trim())
              );
            })
          );
        },
        { timeout: 30_000, polling: 100 },
      );
      await activateTab(page, `.tab[title*="${LARGE}"]`, "large dirty editor");
      await page.waitForFunction(
        (name) => {
          const missing = [...document.querySelectorAll(".editor-tab .missing-file-state")]
            .some((state) => state.textContent?.includes(name));
          const tab = [...document.querySelectorAll(".tab")]
            .find((candidate) => candidate.textContent?.includes(name));
          return missing && tab?.querySelector(".dirty.unsaved") !== null;
        },
        { timeout: 30_000, polling: 100 },
        LARGE,
      );

      // Every new root-dependent action fails in its normal UI. Tabs are
      // allowed to open as error surfaces; none may become an empty success.
      await dispatch(page, "app.draft.new");
      await page.waitForFunction(
        () =>
          (document.querySelector(".status-msg")?.textContent ?? "")
            .toLowerCase()
            .includes("new draft failed: workspace root does not exist"),
        { timeout: 15_000, polling: 100 },
      );
      if (existsSync(canonicalRoot)) {
        throw new Error("new draft recreated the deleted workspace root");
      }

      const terminalCount = await page.$$eval(".terminal-tab", (nodes) => nodes.length);
      await dispatch(page, "app.terminal.toggle");
      await page.waitForFunction(
        () =>
          (document.querySelector(".status-msg")?.textContent ?? "")
            .toLowerCase()
            .includes("new terminal failed: workspace root does not exist"),
        { timeout: 15_000, polling: 100 },
      );
      const terminalCountAfter = await page.$$eval(
        ".terminal-tab",
        (nodes) => nodes.length,
      );
      if (terminalCountAfter !== terminalCount) {
        throw new Error(
          `new terminal left a doomed tab after root loss: ${terminalCount} -> ${terminalCountAfter}`,
        );
      }

      const graphCount = await page.$$eval(".graph-tab", (nodes) => nodes.length);
      await dispatch(page, "app.graph.toggle");
      await page.waitForFunction(
        (before) => document.querySelectorAll(".graph-tab").length > before,
        { timeout: 15_000 },
        graphCount,
      );
      await page.waitForFunction(
        (expected) => {
          const graphs = [...document.querySelectorAll(".graph-tab")];
          return (
            graphs.length === expected &&
            graphs.every((graph) => {
              const error = graph.querySelector(".placeholder.error")?.textContent ?? "";
              const stat = graph.querySelector(".statusbar .stat")?.textContent ?? "";
              return (
                error.toLowerCase().includes("workspace root does not exist") &&
                /^0\/0 nodes/.test(stat.trim())
              );
            })
          );
        },
        { timeout: 30_000, polling: 100 },
        graphCount + 1,
      );

      const browserCount = await page.$$eval(
        ".pane .browser",
        (nodes) => nodes.length,
      );
      await dispatch(page, "app.files.toggle");
      await page.waitForFunction(
        (before) =>
          document.querySelectorAll(".pane .browser").length > before,
        { timeout: 15_000 },
        browserCount,
      );
      await page.waitForFunction(
        (expected) => {
          const browsers = [...document.querySelectorAll(".pane .browser")];
          return (
            browsers.length === expected &&
            browsers.every((browser) =>
              (browser.textContent ?? "").includes("Workspace root unavailable"),
            )
          );
        },
        { timeout: 15_000 },
        browserCount + 1,
      );

      const finalApi = {
        files: await api(page, token, "/api/files?dir="),
        graph: await api(page, token, "/api/graph?scope=workspace&depth=10"),
        fsGraph: await api(
          page,
          token,
          "/api/fs-graph?scope=directory&path=&depth=10",
        ),
        draft: await api(page, token, "/api/drafts/new", "POST"),
      };
      for (const [surface, result] of Object.entries(finalApi)) {
        if (
          result.status !== 404 ||
          !result.body.toLowerCase().includes("workspace root does not exist")
        ) {
          throw new Error(
            `${surface} did not fail with root-missing: ${JSON.stringify(result)}`,
          );
        }
      }

      // Let session saves, watcher retries, and failed terminal reconnects run
      // once more; none may materialize the path as a side effect.
      await delay(2_500);
      if (existsSync(canonicalRoot)) {
        throw new Error("background work recreated the deleted workspace root");
      }
      if (httpFailures.length > 0) {
        throw new Error(
          `root loss produced HTTP 5xx responses: ${JSON.stringify(httpFailures)}`,
        );
      }

      const uiTimeline = await uiTimelinePromise;
      await ctx.shot("root-unavailable", page);
      return {
        fixture: {
          visibleDirs: visible.dirs.length,
          visibleFiles: visible.files.length,
          largeBytes,
          ballastFiles,
        },
        expanded,
        graphDepth,
        deleteMs,
        apiTimeline,
        uiTimeline,
        finalApi: Object.fromEntries(
          Object.entries(finalApi).map(([key, value]) => [
            key,
            { status: value.status, body: value.body },
          ]),
        ),
        dirtyEditorRetained: true,
        rootRemainedAbsent: true,
        httpFailures,
      };
    } finally {
      page.off("response", recordHttpFailure);
      await page.close().catch(() => {});
    }
  },
};
