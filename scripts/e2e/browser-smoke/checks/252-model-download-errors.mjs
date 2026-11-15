import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const WAIT_MS = 15_000;
const COVER = '[data-cover="preflight"]';
const DOWNLOAD = `${COVER} .choices button`;
const ALERT = `${COVER} [role="alert"]`;
const FIELD = '[data-setting="workspace.semantic"]';
const TOGGLE = `${FIELD} input[type="checkbox"]`;
const POLLED_LABEL = "Embedding model (readiness polled after refusal)";

function responseFor(page, method, path, extra = () => true) {
  const pending = page.waitForResponse(
    (response) => response.request().method() === method &&
      new URL(response.url()).pathname === path && extra(response),
    { timeout: WAIT_MS },
  );
  // An earlier assertion can fail before this response is needed.
  pending.catch(() => {});
  return pending;
}

async function readServerJson(serverUrl, path) {
  const token = new URL(serverUrl).searchParams.get("t");
  const response = await fetch(new URL(path, serverUrl), {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(WAIT_MS),
  });
  assert.equal(response.status, 200, `${path}: readable protocol baseline`);
  return response.json();
}

export default {
  name: "model download certificate refusals remain visible in preflight and Settings",
  async run(ctx) {
    const page = ctx.page;
    const fixtureBytes = await readFile(join(ctx.repoRoot, "scripts/e2e/browser-smoke/fixtures/model-download-refusal.json"));
    const refusal = JSON.parse(fixtureBytes.toString("utf8"));
    assert.equal(typeof refusal.error, "string", "recorded refusal uses the server's string error field");
    assert.match(refusal.error, /certificate/i, "recorded refusal identifies its certificate cause");
    const fixtureSha256 = createHash("sha256").update(fixtureBytes).digest("hex");
    const [baseline, semantic, registry, build] = await Promise.all([
      readServerJson(ctx.serverUrl, "/api/preflight"),
      readServerJson(ctx.serverUrl, "/api/index/semantic/state"),
      readServerJson(ctx.serverUrl, "/api/index/semantic/models"),
      readServerJson(ctx.serverUrl, "/api/build-info"),
    ]);
    assert.equal(build.features.embeddings, true, "the server can exercise semantic settings");
    assert.ok(Array.isArray(baseline.steps) && Array.isArray(registry.models), "the server supplied current response shapes");
    assert.ok(registry.models.some((model) => model.id === registry.current_model), "the current model appears in the registry");

    // These controlled transitions retain the live server's response shape.
    // The refusal body itself is the recorded TLS failure, served verbatim.
    const modelStep = {
      id: "model", label: "Embedding model", state: "needs_decision",
      decision: {
        prompt: "Download the embedding model for semantic search, or use keyword search?",
        choices: [
          { id: "download", label: "Download model" },
          { id: "skip", label: "Use keyword search" },
        ],
      },
    };
    const otherSteps = baseline.steps.filter((step) => step.id !== "model")
      .map((step) => ({ ...step, state: "done", decision: null }));
    const lockedSnapshot = (polled) => ({
      ...baseline, phase: "needs_decision", locked: true, error: null, summary: null,
      readiness: { ...baseline.readiness, state: "ready" },
      steps: [...otherSteps, { ...modelStep, label: polled ? POLLED_LABEL : modelStep.label }],
    });
    const readySnapshot = {
      ...baseline, phase: "ready", locked: false, error: null, summary: null,
      readiness: { ...baseline.readiness, state: "ready" },
      steps: [...otherSteps, { id: "model", label: "Embedding model", state: "done", decision: null }],
    };
    const missingModel = { ...semantic, mode: "bm25", model_present: false, semantic_enabled: false };
    const missingRegistry = { ...registry, models: registry.models.map((model) => ({ ...model, downloaded: false })) };
    const trace = [];
    const errors = [];
    const pending = new Set();
    const counts = { readiness: 0, decisions: 0, downloads: 0, enables: 0 };
    let ready = false;
    let completed = false;
    let stopping = false;
    let stage = "locked preflight";
    let releaseRetry;
    const retryGate = new Promise((resolve) => { releaseRetry = resolve; });
    const json = (request, body, status = 200, headers = {}) => request.respond({
      status, contentType: "application/json", headers, body: JSON.stringify(body),
    });
    const refuse = (request) => request.respond({
      status: 500, contentType: "application/json", body: fixtureBytes,
    });
    const handleRequest = async (request) => {
      const path = new URL(request.url()).pathname;
      const method = request.method();
      if (path === "/api/preflight" && method === "GET") {
        counts.readiness++;
        const polled = counts.decisions === 1;
        trace.push({ event: "readiness", count: counts.readiness, afterRefusal: polled, ready });
        await json(request, ready ? readySnapshot : lockedSnapshot(polled), 200,
          { "x-chan-smoke-252": polled ? "after-refusal" : "other" });
      } else if (path === "/api/preflight/decision" && method === "POST") {
        const body = JSON.parse(request.postData() ?? "null");
        counts.decisions++;
        trace.push({ event: "decision", attempt: counts.decisions, body });
        assert.deepEqual(body, { step: "model", choice: "download" }, "the visible model choice sent the download decision");
        if (counts.decisions === 1) await refuse(request);
        else if (counts.decisions === 2) {
          await retryGate;
          ready = true;
          await json(request, readySnapshot);
        } else throw new Error("unexpected extra preflight decision");
      } else if (path === "/api/index/semantic/state" && method === "GET") {
        trace.push({ event: "semantic-state" });
        await json(request, missingModel);
      } else if (path === "/api/index/semantic/models" && method === "GET") {
        trace.push({ event: "semantic-models" });
        await json(request, missingRegistry);
      } else if (path === "/api/index/semantic/download" && method === "POST") {
        counts.downloads++;
        trace.push({ event: "semantic-download", attempt: counts.downloads });
        await refuse(request);
      } else if (path.startsWith("/api/index/semantic/") && method !== "GET") {
        if (path.endsWith("/enable")) counts.enables++;
        errors.push({ event: "unexpected-semantic-write", path, method });
        await refuse(request);
      } else await request.continue();
    };
    const onRequest = (request) => {
      const task = handleRequest(request).catch(async (error) => {
        if (!stopping) errors.push({ event: "interception-error", name: error.name, path: new URL(request.url()).pathname });
        if (!request.isInterceptResolutionHandled()) await request.abort("failed").catch(() => {});
      }).finally(() => pending.delete(task));
      pending.add(task);
    };

    await page.setRequestInterception(true);
    page.on("request", onRequest);
    try {
      await page.goto(page.url(), { waitUntil: "domcontentloaded", timeout: WAIT_MS });
      await page.waitForSelector(DOWNLOAD, { visible: true, timeout: WAIT_MS });
      assert.equal(await page.$eval(DOWNLOAD, (button) => button.textContent.trim()), "Download model");
      const firstResponse = responseFor(page, "POST", "/api/preflight/decision");
      const polledResponse = responseFor(page, "GET", "/api/preflight",
        (response) => response.headers()["x-chan-smoke-252"] === "after-refusal");
      await page.click(DOWNLOAD);
      const refusedResponse = await firstResponse;
      assert.equal(refusedResponse.status(), 500);
      assert.deepEqual(await refusedResponse.json(), refusal, "the decision received the recorded server refusal");
      await page.waitForFunction((selector) => {
        const button = document.querySelector(selector);
        return button && !button.disabled;
      }, { timeout: WAIT_MS }, DOWNLOAD);
      const visible = await page.evaluate((selector, expected) =>
        document.querySelector(selector)?.textContent === expected, ALERT, refusal.error);
      trace.push({ event: "preflight-refusal", observedResponse: true, visible });
      ctx.mark("model-refusal-response", { fixtureSha256, visible, decisions: counts.decisions });
      await ctx.shot("preflight-refusal");
      assert.equal(visible, true, "preflight displays the certificate refusal after the decision response");

      stage = "readiness poll preserves refusal";
      assert.equal((await polledResponse).status(), 200);
      await page.waitForFunction((label) => [...document.querySelectorAll('[data-cover="preflight"] .label')]
        .some((node) => node.textContent === label), { timeout: WAIT_MS }, POLLED_LABEL);
      assert.equal(await page.$eval(ALERT, (node) => node.textContent), refusal.error,
        "a successful locked readiness poll preserves the certificate refusal");
      trace.push({ event: "preflight-refusal-after-poll", readiness: counts.readiness, visible: true });
      await ctx.shot("preflight-refusal-after-poll");

      stage = "retry clears refusal while pending";
      const retryResponse = responseFor(page, "POST", "/api/preflight/decision");
      const retryRequest = page.waitForRequest((request) => request.method() === "POST" &&
        new URL(request.url()).pathname === "/api/preflight/decision", { timeout: WAIT_MS });
      retryRequest.catch(() => {});
      await page.click(DOWNLOAD);
      await retryRequest;
      await page.waitForFunction((selector) => document.querySelector(selector)?.disabled === true,
        { timeout: WAIT_MS }, DOWNLOAD);
      assert.equal(counts.decisions, 2, "the retry request is held before its answer");
      assert.equal(await page.$(ALERT), null, "retry clears the previous refusal before its answer");
      trace.push({ event: "preflight-retry-pending", previousRefusalCleared: true });
      releaseRetry();
      assert.equal((await retryResponse).status(), 200);
      await page.waitForSelector(COVER, { hidden: true, timeout: WAIT_MS });
      await page.waitForSelector(".pane", { visible: true, timeout: WAIT_MS });
      assert.equal(counts.decisions, 2);
      trace.push({ event: "preflight-unlocked" });
      await ctx.shot("preflight-success-unlocked");

      stage = "Settings displays refusal";
      await page.evaluate(() => window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: "app.settings.open" } })));
      await page.waitForSelector('[aria-label="Settings sections"]', { visible: true, timeout: WAIT_MS });
      await page.evaluate(() => {
        const button = [...document.querySelectorAll('[aria-label="Settings sections"] button')]
          .find((node) => node.textContent.trim() === "This workspace");
        if (!button) throw new Error("Settings has no This workspace section");
        button.click();
      });
      await page.waitForSelector(TOGGLE, { visible: true, timeout: WAIT_MS });
      await page.waitForFunction((selector) => {
        const toggle = document.querySelector(selector);
        return toggle && !toggle.checked && !toggle.disabled;
      }, { timeout: WAIT_MS }, TOGGLE);
      const settingsResponse = responseFor(page, "POST", "/api/index/semantic/download");
      await page.click(TOGGLE);
      const settingsRefusal = await settingsResponse;
      assert.equal(settingsRefusal.status(), 500);
      assert.deepEqual(await settingsRefusal.json(), refusal, "Settings received the same recorded server refusal");
      await page.waitForFunction((selector, expected) => {
        const field = document.querySelector(selector);
        const toggle = field?.querySelector('input[type="checkbox"]');
        return field?.querySelector('[role="alert"]')?.textContent === expected && toggle && !toggle.disabled;
      }, { timeout: WAIT_MS }, FIELD, refusal.error);
      const checkboxChecked = await page.$eval(TOGGLE, (toggle) => toggle.checked);
      assert.equal(counts.downloads, 1);
      assert.equal(counts.enables, 0, "a refused download never sends enable");
      assert.deepEqual(errors, [], "every intercepted request followed the intended protocol");
      await page.$eval(`${FIELD} [role="alert"]`, (node) => node.scrollIntoView({ block: "center" }));
      const settingsScreenshot = await ctx.shot("settings-refusal");
      trace.push({ event: "settings-refusal", visible: true, enableRequests: counts.enables, checkboxChecked, screenshot: settingsScreenshot });
      await page.keyboard.press("Escape");
      await page.waitForSelector('[aria-label="Settings sections"]', { hidden: true, timeout: WAIT_MS });
      completed = true;
      return { fixtureSha256, counts, trace };
    } finally {
      stopping = true;
      releaseRetry();
      let cleanupFailure = false;
      let cleanupTimer;
      try {
        await Promise.race([
          (async () => {
            page.off("request", onRequest);
            await page.setRequestInterception(false);
            await Promise.allSettled([...pending]);
          })(),
          new Promise((_, reject) => {
            cleanupTimer = setTimeout(() => reject(new Error("interception cleanup timed out")), WAIT_MS);
          }),
        ]);
      } catch (error) {
        cleanupFailure = true;
        errors.push({ event: "cleanup-error", name: error.name });
      } finally {
        clearTimeout(cleanupTimer);
      }
      const evidence = { fixtureSha256, completed: completed && !cleanupFailure, stage, counts, errors, trace };
      await writeFile(join(ctx.outDir, "252-model-download-errors.trace.json"), JSON.stringify(evidence, null, 2) + "\n", { flag: "wx" });
      ctx.mark("model-refusal-verdict", evidence);
      if (completed && cleanupFailure) throw new Error("model error check could not restore request interception");
    }
  },
};
