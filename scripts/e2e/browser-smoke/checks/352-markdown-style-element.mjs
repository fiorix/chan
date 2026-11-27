// Markdown rendered into the app's own document keeps the app's look: a
// `<style>` element in it reaches no element outside it. Each leg plants a
// rule that draws a dashed magenta outline on a pane, a property no app rule
// sets on a pane in any state, and reads that pane's computed outline before
// the rendered Markdown shows, while it shows and after it goes:
//
// - survey: two panes, a terminal in pane A and a deck in pane B, which is
//   the focused one. A survey raised on A's terminal carries a paragraph and
//   then a `<style>` element whose rule names pane B by its id. The leg first
//   reads that the card's body rendered the paragraph, so it cannot pass on a
//   survey that never showed; the reading after is taken once a press on the
//   card's first option has answered it and the card is gone.
// - preview: a seeded note holds a paragraph and then a `<style>` element
//   whose rule names every pane; a second note links to it. The second note
//   opens in read mode, where a press on the link's pill opens the preview
//   popover; the leg first reads that the popover's body holds the paragraph.
//   The reading after is taken once Escape has closed the popover.
//
// A reading that differs from the one before is the product's failure, named
// by the property, the value read and the element. A step that does not reach
// its precondition is an interaction error: the run then reports an error,
// not a failure, unless a leg also read a failure.
//
// Where the renderers keep a `<style>` element, both legs read the planted
// outline while the Markdown shows (while the survey shows, pane B
// .pane[data-pane-id="..."] reads outline-style "dashed", "none" before; the
// same for outline-width and outline-color) and the app's outline again
// after it goes.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { answerOpenSurveys, raiseSurvey, surveyOutcome, terminalCard, waitForCard } from "../lib/keyboard-owners.mjs";
import { dispatchCommand } from "../lib/pane-strip.mjs";
import { openAttachedTerminal } from "../lib/terminal-attach.mjs";
import { maskTokens } from "../lib/token-mask.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const describeError = (error) => maskTokens(error?.stack ?? String(error));
const firstLine = (text) => String(text).split("\n")[0];
const attribute = (name, value) => `[${name}=${JSON.stringify(value)}]`;
const paneSelector = (pane) => `.pane${attribute("data-pane-id", pane)}`;

const DECLARATION = "outline: 7px dashed rgb(255, 0, 170)";
const PLANTED = { "outline-style": "dashed", "outline-width": "7px", "outline-color": "rgb(255, 0, 170)" };
const PROPERTIES = Object.keys(PLANTED);
const SURVEY_PARAGRAPH = "A survey body that carries a style element after this paragraph.";
const PREVIEW_PARAGRAPH = "A previewed note that carries a style element after this paragraph.";
const DECK = "---\nchan:\n  kind: slides\n---\n\n# Outline deck\n\nOne slide.\n";

async function settle(page) {
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
}

async function until(label, predicate, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  do {
    const value = await predicate();
    if (value) return value;
    await sleep(50);
  } while (Date.now() < deadline);
  throw new Error(`${label}: condition not reached within ${timeout} ms`);
}

/// The element's computed outline, or null when no element matches.
async function lookOf(page, selector) {
  return page.evaluate((query, properties) => {
    const element = document.querySelector(query);
    if (!element) return null;
    const style = getComputedStyle(element);
    return Object.fromEntries(properties.map((name) => [name, style.getPropertyValue(name)]));
  }, selector, PROPERTIES);
}

/// A reading before the Markdown shows, refused when the element is missing
/// or already wears the planted outline, since the leg could not see the rule.
async function lookBefore(page, selector, label) {
  const look = await lookOf(page, selector);
  if (!look) throw new Error(`${label}: no element at ${selector}`);
  if (look["outline-style"] === PLANTED["outline-style"]) {
    throw new Error(`${label}: ${selector} already reads outline-style ${JSON.stringify(look["outline-style"])} before the Markdown shows, so the leg cannot see the planted rule`);
  }
  return look;
}

function compareLook(leg, moment, element, before, now) {
  if (!now) {
    leg.interactionErrors.push(`${moment}, no element at ${element}`);
    return;
  }
  for (const name of PROPERTIES) {
    if (now[name] !== before[name]) {
      leg.failures.push(`${moment}, ${element} reads ${name} ${JSON.stringify(now[name])}, ${JSON.stringify(before[name])} before`);
    }
  }
}

function newLeg(kind) {
  return { kind, observed: false, step: "start", readings: {}, failures: [], interactionErrors: [], cleanupErrors: [], pageErrors: [] };
}

async function openWindow(ctx, page, windowId) {
  const url = new URL(ctx.serverUrl);
  url.searchParams.set("w", windowId);
  await page.setViewport({ width: 1280, height: 900 });
  await page.bringToFront();
  await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForSelector(".pane", { timeout: 30_000 });
  await ctx.waitWindowLive(windowId);
}

function shellFor(ctx, windowId) {
  const env = { ...process.env, CHAN_CONTROL_SOCKET: ctx.controlSocket, CHAN_WINDOW_ID: windowId };
  const shell = (args, timeout = 30_000) => ctx.exec(ctx.chanBin, ["shell", ...args], { cwd: ctx.workspaceDir, env, timeout });
  // `cs terminal survey` blocks until the survey resolves, so its call
  // outlives the survey's own timeout.
  const cs = (args) => shell(["terminal", ...args], 75_000);
  return { shell, cs };
}

async function waitActiveTab(page, pane, path) {
  await page.waitForFunction((selector, wanted) => document.querySelector(selector)?.getAttribute("title") === wanted,
    { timeout: 30_000 }, `${pane} .tabs .tab.active`, path);
}

async function focusPane(shell, page, pane) {
  await shell(["pane", "focus", pane]);
  await page.waitForFunction((selector) => document.querySelector(selector)?.classList.contains("focused"),
    { timeout: 10_000 }, paneSelector(pane));
}

/// The survey card's body as rendered: its first paragraph and how many
/// style elements it holds, with the focused pane.
async function cardState(page, tab) {
  return page.evaluate((selector) => {
    const body = document.querySelector(selector)?.querySelector(".survey-body");
    return {
      shown: Boolean(body),
      paragraph: body?.querySelector("p")?.textContent ?? null,
      styleElements: body ? body.querySelectorAll("style").length : null,
      focusedPane: document.querySelector(".pane.focused")?.getAttribute("data-pane-id") ?? null,
    };
  }, terminalCard(tab));
}

async function answerFirstOption(page, tab, call) {
  await page.click(`${terminalCard(tab)} .survey-option`);
  const outcome = await surveyOutcome(call, 10_000);
  if (!outcome) throw new Error("a press on the card's first option left the survey unanswered");
  if (outcome.code !== 0 || outcome.stdout !== "Alpha") throw new Error(`a press on the card's first option answered ${JSON.stringify(maskTokens(JSON.stringify(outcome)))}, expected "Alpha"`);
  await page.waitForSelector(terminalCard(tab), { hidden: true, timeout: 10_000 });
  await settle(page);
  return outcome.stdout;
}

async function runSurveyLeg(ctx, report, directory, save) {
  const leg = newLeg("survey");
  report.legs.survey = leg;
  save();
  const page = await ctx.browser.newPage();
  page.on("pageerror", (error) => leg.pageErrors.push(describeError(error)));
  const suffix = Date.now().toString(36);
  const windowId = `style-352-survey-${suffix}`;
  const terminalName = `Style352A-${suffix}`;
  const deckPath = `${directory.relative}/deck.md`;
  const { shell, cs } = shellFor(ctx, windowId);
  const calls = [];
  let terminal = null;
  let paneB = null;
  try {
    leg.step = "load the window";
    await openWindow(ctx, page, windowId);
    leg.step = "open pane A's terminal";
    terminal = await openAttachedTerminal(ctx, page, cs, windowId, terminalName, ["--command", "exec cat"]);
    leg.step = "split pane A";
    await dispatchCommand(page, "app.pane.splitDown");
    await page.waitForFunction(() => document.querySelectorAll(".pane").length === 2, { timeout: 10_000 });
    paneB = await page.evaluate((paneA) => [...document.querySelectorAll(".pane")]
      .map((el) => el.getAttribute("data-pane-id")).find((id) => id && id !== paneA) ?? null, terminal.pane);
    if (!paneB) throw new Error(`no second pane beside pane A ${terminal.pane}`);
    leg.panes = { a: terminal.pane, b: paneB };
    leg.step = "open the deck in pane B";
    await focusPane(shell, page, paneB);
    await shell(["open", deckPath]);
    await waitActiveTab(page, paneSelector(paneB), deckPath);
    await page.waitForSelector(`${paneSelector(paneB)} .editor-tab.active .cm-editor`, { visible: true, timeout: 30_000 });
    await focusPane(shell, page, paneB);

    const element = `pane B ${paneSelector(paneB)}`;
    leg.element = paneSelector(paneB);
    leg.step = "read pane B before the survey";
    leg.readings.before = await lookBefore(page, paneSelector(paneB), "before the survey");
    leg.step = "raise the survey";
    const body = [SURVEY_PARAGRAPH, `<style>${paneSelector(paneB)}{${DECLARATION}}</style>`].join("\n\n");
    leg.body = body;
    const call = raiseSurvey(cs, ["--tab-name", terminalName, "--timeout", "60", "--title", "Style element", "--option", "Alpha", "--option", "Beta", body]);
    calls.push(call);
    await waitForCard(page, terminalCard(terminal.tab), call, "the survey's card");
    await settle(page);
    leg.step = "read that the card's body rendered the paragraph";
    leg.card = await cardState(page, terminal.tab);
    if (leg.card.paragraph?.trim() !== SURVEY_PARAGRAPH) {
      throw new Error(`the card's body rendered no paragraph ${JSON.stringify(SURVEY_PARAGRAPH)}: ${JSON.stringify(leg.card)}`);
    }
    leg.readings.while = await lookOf(page, paneSelector(paneB));
    leg.screenshot = basename(await ctx.shot("352-survey-while", page));
    compareLook(leg, "while the survey shows", element, leg.readings.before, leg.readings.while);
    leg.step = "answer the survey";
    leg.answer = await answerFirstOption(page, terminal.tab, call);
    leg.readings.after = await lookOf(page, paneSelector(paneB));
    compareLook(leg, "after the survey is answered", element, leg.readings.before, leg.readings.after);
    leg.observed = true;
  } catch (error) {
    leg.interactionErrors.push(`${leg.step}: ${describeError(error)}`);
    leg.screenshot = basename(await ctx.shot("352-survey-failure", page).catch(() => "unavailable"));
  }
  save();

  try { await answerOpenSurveys(page, calls); }
  catch (error) { leg.cleanupErrors.push(`answer open surveys: ${describeError(error)}`); }
  if (terminal) {
    try { await cs(["close", "--tab-name", terminalName]); }
    catch (error) { leg.cleanupErrors.push(`close ${terminalName}: ${describeError(error)}`); }
  }
  for (const call of calls) {
    try { await until("survey process exits during cleanup", () => call.result, 15_000); }
    catch (error) { leg.cleanupErrors.push(describeError(error)); }
  }
  leg.surveyResults = calls.map((call) => call.result && { code: call.result.code, stdout: maskTokens(call.result.stdout ?? "") });
  try { await page.close(); }
  catch (error) { leg.cleanupErrors.push(`close page: ${describeError(error)}`); }
  save();
}

async function runPreviewLeg(ctx, report, directory, save) {
  const leg = newLeg("preview");
  report.legs.preview = leg;
  save();
  const page = await ctx.browser.newPage();
  page.on("pageerror", (error) => leg.pageErrors.push(describeError(error)));
  const windowId = `style-352-preview-${Date.now().toString(36)}`;
  const linkingPath = `${directory.relative}/linking.md`;
  const target = `${directory.relative}/styled`;
  const { shell } = shellFor(ctx, windowId);
  const active = ".editor-tab.active";
  const pill = `${active} .cm-md-wiki-pill${attribute("data-target", target)}`;
  try {
    leg.step = "load the window";
    await openWindow(ctx, page, windowId);
    leg.step = "open the linking note";
    await shell(["open", linkingPath]);
    const pane = await until("the window shows one pane", () => page.evaluate(() => {
      const panes = document.querySelectorAll(".pane");
      return panes.length === 1 ? panes[0].getAttribute("data-pane-id") : null;
    }));
    await waitActiveTab(page, paneSelector(pane), linkingPath);
    await page.waitForSelector(`${active} .cm-editor`, { visible: true, timeout: 30_000 });
    if (await page.$(`${active} .md-source`)) await dispatchCommand(page, "app.editor.toggleMode");
    await page.waitForSelector(`${active} .md-wysiwyg-cm6 .cm-content`, { visible: true, timeout: 30_000 });
    await page.waitForSelector(pill, { visible: true, timeout: 15_000 });
    // A pill whose kind is still resolving is drawn again when it lands.
    leg.refkind = await page.waitForFunction((selector) => document.querySelector(selector)?.dataset.refkind ?? null,
      { timeout: 10_000 }, pill).then((handle) => handle.jsonValue(), () => null);
    leg.step = "switch the note to read mode";
    await page.click(`${active} button.lamp`);
    await page.waitForFunction((selector) => document.querySelector(`${selector} .wiki-statusbar.read-mode`) &&
      document.querySelector(`${selector} .cm-content`)?.getAttribute("contenteditable") === "false",
    { timeout: 10_000 }, active);

    const element = `the note's pane ${paneSelector(pane)}`;
    leg.element = paneSelector(pane);
    leg.step = "read the pane before the preview";
    leg.readings.before = await lookBefore(page, paneSelector(pane), "before the preview");
    leg.step = "open the link's preview";
    await page.click(pill);
    leg.step = "read that the popover's body holds the paragraph";
    const shown = await page.waitForFunction((wanted) => [...document.querySelectorAll(".md-preview-popover .md-preview-md p")]
      .some((p) => p.textContent.trim() === wanted), { timeout: 15_000 }, PREVIEW_PARAGRAPH).then(() => true, () => false);
    leg.popover = await page.evaluate(() => {
      const popover = document.querySelector(".md-preview-popover");
      return {
        shown: Boolean(popover),
        path: popover?.querySelector(".md-preview-path")?.textContent ?? null,
        body: popover?.querySelector(".md-preview-body")?.textContent?.slice(0, 200) ?? null,
        styleElements: popover ? popover.querySelectorAll("style").length : null,
      };
    });
    if (!shown) throw new Error(`the popover's body holds no paragraph ${JSON.stringify(PREVIEW_PARAGRAPH)}: ${JSON.stringify(leg.popover)}`);
    await settle(page);
    leg.readings.while = await lookOf(page, paneSelector(pane));
    leg.screenshot = basename(await ctx.shot("352-preview-while", page));
    compareLook(leg, "while the preview shows", element, leg.readings.before, leg.readings.while);
    leg.step = "close the preview";
    await page.keyboard.press("Escape");
    await page.waitForSelector(".md-preview-popover", { hidden: true, timeout: 10_000 });
    await settle(page);
    leg.readings.after = await lookOf(page, paneSelector(pane));
    compareLook(leg, "after the preview closes", element, leg.readings.before, leg.readings.after);
    leg.observed = true;
  } catch (error) {
    leg.interactionErrors.push(`${leg.step}: ${describeError(error)}`);
    leg.screenshot = basename(await ctx.shot("352-preview-failure", page).catch(() => "unavailable"));
  } finally {
    try { await page.close(); }
    catch (error) { leg.cleanupErrors.push(`close page: ${describeError(error)}`); }
    save();
  }
}

export default {
  name: "markdown-style-element",
  async run(ctx) {
    if (!ctx.controlSocket) ctx.skip("control socket not found for the server pid");
    const report = { planted: { declaration: DECLARATION, values: PLANTED }, legs: {}, cleanupErrors: [] };
    const save = () => writeFileSync(join(ctx.outDir, "352-markdown-style-element.json"), JSON.stringify(report, null, 2) + "\n");
    const relative = `style-352-${Date.now().toString(36)}`;
    const directory = { relative, absolute: join(ctx.workspaceDir, relative) };
    try {
      report.browserVersion = await ctx.page.browser().version().catch(() => null);
      mkdirSync(directory.absolute);
      writeFileSync(join(directory.absolute, "deck.md"), DECK);
      writeFileSync(join(directory.absolute, "styled.md"), `${PREVIEW_PARAGRAPH}\n\n<style>.pane{${DECLARATION}}</style>\n`);
      writeFileSync(join(directory.absolute, "linking.md"), `A note that links to the styled one.\n\nSee [[${relative}/styled]] for it.\n`);
      await runSurveyLeg(ctx, report, directory, save);
      await runPreviewLeg(ctx, report, directory, save);
    } finally {
      try { rmSync(directory.absolute, { recursive: true, force: true }); }
      catch (error) { report.cleanupErrors.push(describeError(error)); }
      save();
    }
    const legs = ["survey", "preview"].map((kind) => report.legs[kind] ?? { ...newLeg(kind), interactionErrors: ["the leg never ran"] });
    const failures = legs.flatMap((leg) => [...leg.failures, ...leg.pageErrors.map(firstLine)].map((reason) => `${leg.kind}: ${reason}`));
    const interaction = legs.flatMap((leg) => [
      ...leg.interactionErrors.map(firstLine),
      ...(leg.observed || leg.interactionErrors.length ? [] : ["the leg did not finish its readings"]),
    ].map((reason) => `${leg.kind}: ${reason}`));
    const cleanup = [...legs.flatMap((leg) => leg.cleanupErrors.map((reason) => `${leg.kind} cleanup: ${firstLine(reason)}`)), ...report.cleanupErrors.map(firstLine)];
    if (failures.length) {
      throw Object.assign(new Error(`rendered Markdown changed the app's look: ${[...failures, ...interaction, ...cleanup].join("; ")}`), { smokeDetails: report });
    }
    if (interaction.length || cleanup.length) {
      // A leg that never read its Markdown shown read nothing about the
      // product: an interaction error, not a pass and not a failure.
      throw Object.assign(new Error(`the app's look could not be read: ${[...interaction, ...cleanup].join("; ")}`), { smokeDetails: report, smokeEnvironment: true });
    }
    return report;
  },
};
