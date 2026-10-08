// On a page whose WebGL2 contexts are drawn by a software rasterizer, or
// that has none, the empty pane's welcome draws only the animations that use
// the 2D canvas. Several loads of an empty window, each on new session
// storage, each read on its own mounted canvas.
//
// A draw from the whole catalog lands on a 2D animation about one time in
// three, so ten loads pass by chance about three times in a hundred
// thousand.

import {
  installWelcomeRecord,
  readWelcomeRecord,
  rendererReadings,
  welcomeContexts,
} from "../lib/welcome-record.mjs";

const LOADS = 10;
const SAVED_ANIMATION_KEY = "chan.empty-pane-animation";
// This check's own reading of a software rasterizer's name, kept apart from
// the product's list so the two cannot agree by sharing a mistake.
const SOFTWARE_RENDERER = /swiftshader|llvmpipe|softpipe|lavapipe|software|basic render driver/i;

/// Read one loaded page: what its welcome mounted, on which kind of context,
/// and what the page's WebGL2 renderer is. Runs in the page.
function readLoad(savedKey) {
  const getContext = window.__nativeGetContext;
  const canvas = document.querySelector(".welcome canvas");
  // The order is the guard. On a canvas that holds a 2D context a webgl2
  // request answers null and creates nothing; on a canvas with no context
  // yet it would create one, so such a load reads as WebGL2 and never as
  // 2D by mistake.
  const webgl2 = canvas ? getContext.call(canvas, "webgl2") !== null : null;
  const twoD = canvas && !webgl2 ? getContext.call(canvas, "2d") !== null : false;
  const gl = getContext.call(document.createElement("canvas"), "webgl2");
  let renderer = null;
  if (gl) {
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    renderer = info
      ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL)
      : gl.getParameter(gl.RENDERER);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
  return {
    saved: sessionStorage.getItem(savedKey),
    host: canvas?.parentElement?.className ?? null,
    webgl2,
    twoD,
    context: gl !== null,
    renderer,
  };
}

export default {
  name: "welcome-software-context",
  async run(ctx) {
    const windowId = `${new URL(ctx.page.url()).searchParams.get("w")}-loads`;
    // The runner's own page is an empty window too. Park it, so its
    // welcome does not draw beside the loads read here.
    await ctx.page.goto("about:blank");

    const loads = [];
    let page = null;
    try {
      for (let load = 0; load < LOADS; load += 1) {
        page = await ctx.browser.newPage();
        await page.evaluateOnNewDocument(installWelcomeRecord);
        await page.goto(`${ctx.serverUrl}&w=${windowId}`, {
          waitUntil: "domcontentloaded", timeout: 60_000,
        });
        // The welcome has mounted its animation once a context request
        // under its region is on record.
        await page.waitForFunction(
          () => window.__welcomeRecord?.contexts.some((request) => request.inWelcome),
          { timeout: 60_000 },
        );
        const record = await readWelcomeRecord(page);
        const reading = await page.evaluate(readLoad, SAVED_ANIMATION_KEY);
        if (load === 0 && reading.context && !SOFTWARE_RENDERER.test(String(reading.renderer))) {
          ctx.skip(
            `this page's WebGL2 renderer is not a software rasterizer (${reading.renderer}); ` +
              "the fallback is not exercised here",
          );
        }
        const requests = welcomeContexts(record);
        loads.push({
          load,
          saved: reading.saved,
          host: reading.host,
          renderer: reading.renderer,
          context: reading.context,
          webgl2: reading.webgl2,
          twoD: reading.twoD,
          welcomeRequests: requests.map((request) => request.kind),
          // The cost of the welcome's own reading of the renderer.
          readingMs: rendererReadings(record).map((request) => request.ms),
          startedAfterMs: requests[0].at - record.regionAt,
        });
        await ctx.shot(`load-${load}`, page);
        await page.close();
        page = null;
      }
    } finally {
      await page?.close().catch(() => {});
    }

    const details = {
      renderer: loads[0].renderer,
      context: loads[0].context,
      animations: loads.map((entry) => entry.saved),
      loads,
    };
    const offenders = loads.filter(
      (entry) =>
        entry.webgl2 !== false ||
        entry.twoD !== true ||
        entry.welcomeRequests.some((kind) => kind !== "2d"),
    );
    if (offenders.length > 0) {
      const error = new Error(
        `${offenders.length} of ${LOADS} loads mounted a welcome off the 2D canvas under ` +
          `${details.renderer ?? "no WebGL2 context"}: ` +
          offenders
            .map((entry) => `load ${entry.load} ${entry.saved} (${entry.welcomeRequests.join(",")})`)
            .join("; "),
      );
      error.smokeDetails = details;
      throw error;
    }
    return details;
  },
};
