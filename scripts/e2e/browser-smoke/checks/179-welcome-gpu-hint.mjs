// The native GPU hint narrows only the unnamed welcome. Force the renderer
// string that WebKitGTK exposes so Chrome's software rasterizer cannot make
// both arms pass through the same 2D fallback.
import { installWelcomeRecord, welcomeContexts } from "../lib/welcome-record.mjs";

const SAVED_KEY = "chan.empty-pane-animation";
const WEBGL_KEY = "sixfold-vortex";
const TWO_D_KEYS = new Set([
  "radial-ribbons", "concentric-pulse", "exponential-thread", "exponential-echo",
  "quadratic-bloom", "orbital-rosette", "dotted-waves", "spiral-spokes",
  "mutual-force-starburst", "recursive-arc-bloom", "chaotic-halo",
  "swaying-branches", "contracting-spiral",
]);

function installMaskedRenderer() {
  for (const type of [globalThis.WebGL2RenderingContext, globalThis.WebGLRenderingContext]) {
    if (!type) continue;
    const native = type.prototype.getParameter;
    type.prototype.getParameter = function (parameter) {
      if (parameter === 0x9246) return "Apple GPU"; // UNMASKED_RENDERER_WEBGL
      if (parameter === 0x1f01) return "WebKit WebGL"; // RENDERER
      return native.call(this, parameter);
    };
  }
}

async function readArm(ctx, name, gpuHint, baseWindowId) {
  const page = await ctx.browser.newPage();
  try {
    await page.evaluateOnNewDocument(installWelcomeRecord);
    await page.evaluateOnNewDocument(installMaskedRenderer);
    await page.evaluateOnNewDocument((key) => sessionStorage.setItem("chan.empty-pane-animation", key), WEBGL_KEY);
    const windowId = `${baseWindowId}-${name}`;
    const url = new URL(ctx.serverUrl);
    url.searchParams.set("w", windowId);
    if (gpuHint !== null) url.searchParams.set("chan-gpu", gpuHint);
    await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForFunction(
      () => window.__welcomeRecord?.contexts.some((request) => request.inWelcome),
      { timeout: 60_000 },
    );
    const reading = await page.evaluate((savedKey) => {
      const root = document.querySelector(".welcome");
      const canvas = root?.querySelector("canvas");
      const native = window.__nativeGetContext;
      const shownAttribute = root?.getAttribute("data-animation-id") ?? null;
      const persisted = sessionStorage.getItem(savedKey);
      return {
        gpuMeta: document.querySelector('meta[name="chan-gpu"]')?.content ?? null,
        shown: shownAttribute ?? persisted,
        shownAttribute,
        persisted,
        twoD: canvas ? native.call(canvas, "2d") !== null : false,
        webgl2: canvas ? native.call(canvas, "webgl2") !== null : false,
        requests: window.__welcomeRecord.contexts,
      };
    }, SAVED_KEY);
    reading.welcomeRequests = welcomeContexts({ contexts: reading.requests });
    delete reading.requests;
    await ctx.shot(name, page);
    return reading;
  } finally {
    await page.close().catch(() => {});
  }
}

export default {
  name: "welcome-gpu-hint",
  async run(ctx) {
    // Keep the runner's own welcome from drawing beside these arms.
    const baseWindowId = new URL(ctx.page.url()).searchParams.get("w");
    await ctx.page.goto("about:blank");
    const ordinary = await readArm(ctx, "ordinary", null, baseWindowId);
    if (ordinary.gpuMeta !== null || ordinary.shown !== WEBGL_KEY || ordinary.persisted !== WEBGL_KEY ||
        !ordinary.webgl2 || ordinary.twoD ||
        !ordinary.welcomeRequests.some((request) => request.kind === "webgl2" && request.answered)) {
      throw new Error(`ordinary browser did not keep its WebGL welcome: ${JSON.stringify(ordinary)}`);
    }
    console.log("[welcome-gpu-hint] ordinary no-meta control kept WebGL2");
    const gpuLess = await readArm(ctx, "no-gpu", "0", baseWindowId);
    if (gpuLess.gpuMeta !== "0" || !TWO_D_KEYS.has(gpuLess.shown) ||
        gpuLess.shownAttribute !== gpuLess.shown ||
        gpuLess.persisted !== gpuLess.shown || !gpuLess.twoD || gpuLess.webgl2 ||
        !gpuLess.welcomeRequests.some((request) => request.kind === "2d" && request.answered) ||
        gpuLess.welcomeRequests.some((request) => request.kind === "webgl2")) {
      throw new Error(`GPU-less welcome requested WebGL or failed to select 2D: ${JSON.stringify(gpuLess)}`);
    }
    return { ordinary, gpuLess };
  },
};
