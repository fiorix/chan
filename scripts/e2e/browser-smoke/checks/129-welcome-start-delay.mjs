// The empty pane's welcome starts its animation only after a delay, so a
// tab that arrives at once sees no frame of it.
//
// Control arm, an empty window: the welcome does mount its canvas, and no
// earlier than the delay after its region appeared. Without it, the tab
// arm's "no canvas" could be a record that sees nothing.
//
// Tab arm, a window reloaded with a saved terminal tab: the region appears,
// the tab replaces it within the delay, and no canvas under the region ever
// asks for a context. The premise is part of the arm. A load where the
// region never appeared before the tab, or where the tab came after the
// delay, exercised nothing and is a skip.
//
// Both arms run before the verdict, so a failure of one does not hide what
// the other read.

import {
  installWelcomeRecord,
  readWelcomeRecord,
  rendererReadings,
  welcomeContexts,
  WELCOME_RECORD_SKEW_MS,
  WELCOME_START_DELAY_MS,
} from "../lib/welcome-record.mjs";

const TAB = "welcome-delay-129";
// How long the tab arm keeps watching after the tab is up: past the delay,
// so a welcome that outlived its pane would have started by then.
const WATCH_MS = WELCOME_START_DELAY_MS + 1500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const round = (value) => (value === null ? null : Math.round(value));

export default {
  name: "welcome-start-delay",
  async run(ctx) {
    if (!ctx.controlSocket) ctx.skip("the tab arm needs the isolated server's control socket");
    const base = new URL(ctx.page.url()).searchParams.get("w");
    // The runner's own page is an empty window too. Park it, so its
    // welcome does not draw beside the arms read here.
    await ctx.page.goto("about:blank");
    const details = {};
    const failures = [];
    let notExercised = null;

    // Control arm.
    let page = await ctx.browser.newPage();
    try {
      await page.evaluateOnNewDocument(installWelcomeRecord);
      await page.goto(`${ctx.serverUrl}&w=${base}-empty`, {
        waitUntil: "domcontentloaded", timeout: 60_000,
      });
      await page.waitForFunction(
        () => window.__welcomeRecord?.contexts.some((request) => request.inWelcome),
        { timeout: 60_000 },
      );
      const record = await readWelcomeRecord(page);
      const first = welcomeContexts(record)[0];
      const readings = rendererReadings(record);
      details.control = {
        regionAt: round(record.regionAt),
        canvasAt: round(record.canvasAt),
        contextAt: round(first.at),
        contextKind: first.kind,
        startedAfterMs: round(first.at - record.regionAt),
        readingsAt: readings.map((request) => round(request.at)),
      };
      await ctx.shot("control", page);
      const earliest = Math.min(first.at, ...readings.map((request) => request.at));
      if (record.regionAt === null || earliest - record.regionAt < WELCOME_START_DELAY_MS - WELCOME_RECORD_SKEW_MS) {
        failures.push(
          `control arm: the welcome asked for a canvas context ${round(earliest - record.regionAt)} ms ` +
            `after its region appeared, before its ${WELCOME_START_DELAY_MS} ms start delay`,
        );
      }
    } finally {
      await page.close().catch(() => {});
    }

    // Tab arm.
    const windowId = `${base}-tab`;
    const env = { ...process.env, CHAN_CONTROL_SOCKET: ctx.controlSocket, CHAN_WINDOW_ID: windowId };
    const cs = (args) =>
      ctx.exec(ctx.chanBin, ["shell", "terminal", ...args], {
        cwd: ctx.workspaceDir, env, timeout: 90_000,
      });
    page = await ctx.browser.newPage();
    let opened = false;
    try {
      await page.evaluateOnNewDocument(installWelcomeRecord);
      await page.goto(`${ctx.serverUrl}&w=${windowId}`, {
        waitUntil: "domcontentloaded", timeout: 60_000,
      });
      await page.waitForSelector(".pane", { timeout: 30_000 });
      await ctx.waitWindowLive(windowId);
      await cs(["new", "--tab-name", TAB]);
      opened = true;
      await page.waitForSelector(".terminal-tab", { timeout: 60_000 });

      // The same page again: its window now holds a terminal tab, which
      // the reload brings back while the pane is first drawn.
      await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForSelector(".terminal-tab", { timeout: 60_000 });
      await sleep(WATCH_MS);
      const record = await readWelcomeRecord(page);
      const requests = welcomeContexts(record);
      details.tab = {
        regionAt: round(record.regionAt),
        regionGoneAt: round(record.regionGoneAt),
        terminalAt: round(record.terminalAt),
        canvasAt: round(record.canvasAt),
        welcomeRequests: requests.map((request) => ({ at: round(request.at), kind: request.kind })),
        readingsAt: rendererReadings(record).map((request) => round(request.at)),
      };
      await ctx.shot("tab", page);

      const replacedAfter = record.regionAt === null || record.regionGoneAt === null
        ? null
        : record.regionGoneAt - record.regionAt;
      details.tab.replacedAfterMs = round(replacedAfter);
      if (record.regionAt === null) {
        notExercised =
          "tab arm not exercised: the saved tab was in the pane before the welcome's region ever appeared";
      } else if (record.terminalAt === null || replacedAfter === null || replacedAfter >= WELCOME_START_DELAY_MS) {
        notExercised =
          `tab arm not exercised: the tab replaced the welcome ${round(replacedAfter)} ms after its ` +
          `region appeared, not within the ${WELCOME_START_DELAY_MS} ms start delay`;
      } else if (requests.length > 0 || record.canvasAt !== null) {
        failures.push(
          `tab arm: a welcome canvas appeared before the tab that replaced it ${round(replacedAfter)} ms ` +
            `after its region: ${JSON.stringify(details.tab.welcomeRequests)}`,
        );
      }
    } finally {
      if (opened) await cs(["close", "--tab-name", TAB]).catch(() => {});
      await page.close().catch(() => {});
    }

    if (failures.length > 0) {
      const error = new Error(
        [...failures, ...(notExercised ? [notExercised] : [])].join("; "),
      );
      error.smokeDetails = details;
      throw error;
    }
    if (notExercised) ctx.skip(`${notExercised}; the control arm passed (${JSON.stringify(details)})`);
    return details;
  },
};
