import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { maskTokens } from "../lib/token-mask.mjs";

function makeFixture() {
  let text = "";
  const headings = [];
  function heading(label, body, level = 2) {
    const source = `${"#".repeat(level)} ${label}`;
    headings.push({ label, source, from: text.length, line: text.split("\n").length, level, body });
    text += `${source}\n${body}\n\n`;
  }
  // The caret begins on the title. The next line's link URL is naturally
  // hidden by the app's normal link decorations, leaving a compact prefix.
  heading("Foldlate title", `[Compact prefix](https://example.invalid/${"p".repeat(4200)})`, 1);
  for (let n = 1; n <= 8; n++) heading(`Foldlate first ${String(n).padStart(2, "0")}`, `First-screen section ${n} has a real body.`);
  for (let n = 1; n <= 180; n++) {
    const body = Array.from({ length: 14 }, (_, p) => `Body ${n}.${p + 1}: ordinary paragraph text with **bold words**, an *emphasis*, and a small inline \`code span\` to keep the long note realistic.`).join("\n\n");
    heading(`Foldlate middle ${String(n).padStart(3, "0")}`, body);
  }
  for (let n = 1; n <= 8; n++) heading(`Foldlate end ${String(n).padStart(2, "0")}`, `End-screen section ${n} has a real body.`);
  assert.ok(headings.find((h) => h.label === "Foldlate first 01").from > 3000);
  assert.ok(headings.every((h) => h.body.trim() && !h.body.startsWith("#")));
  return { text, headings };
}

// Read the mounted editor without dispatching, forcing a parse, or requesting
// a measure: any of those could repair the gutter before the check sees it.
function installReader(config) {
  const byLabel = new Map(config.headings.map((heading) => [heading.label, heading]));
  const byOffset = new Map(config.headings.map((heading) => [heading.from, heading]));
  let initialDocument = null;
  let trustedInputs = 0;
  for (const name of ["keydown", "pointerdown", "beforeinput", "input"]) {
    addEventListener(name, (event) => { if (event.isTrusted) trustedInputs++; }, true);
  }
  const rect = (r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
  function visible(element, scroller) {
    const r = element.getBoundingClientRect();
    let left = Math.max(0, r.left), top = Math.max(0, r.top);
    let right = Math.min(innerWidth, r.right), bottom = Math.min(innerHeight, r.bottom);
    for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
      const css = getComputedStyle(ancestor);
      if (css.display === "none" || css.visibility !== "visible" || Number(css.opacity) === 0) return null;
      if (ancestor !== element) {
        const a = ancestor.getBoundingClientRect();
        if (/(auto|scroll|hidden|clip)/.test(css.overflowX)) { left = Math.max(left, a.left); right = Math.min(right, a.right); }
        if (/(auto|scroll|hidden|clip)/.test(css.overflowY)) { top = Math.max(top, a.top); bottom = Math.min(bottom, a.bottom); }
      }
    }
    const clip = scroller.getBoundingClientRect();
    left = Math.max(left, clip.left); right = Math.min(right, clip.right);
    top = Math.max(top, clip.top); bottom = Math.min(bottom, clip.bottom);
    if (right - left < 1 || bottom - top < 1) return null;
    const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
    if (!hit || !(element === hit || element.contains(hit))) return null;
    return { rect: rect(r), full: top <= r.top + 1 && bottom >= r.bottom - 1 };
  }
  window.__foldlateCheck = () => {
    const content = document.querySelector(".editor-tab.active .md-wysiwyg-cm6 .cm-content");
    const editor = content?.closest(".cm-editor");
    const scroller = editor?.querySelector(".cm-scroller");
    if (!content || !editor || !scroller) return null;
    // These are the mounted view and published tree read by CodeMirror's
    // findFromDOM and syntaxTree; no private parser work is requested.
    const view = content.cmTile?.root?.view ?? content.cmView?.view;
    const tree = view?.state.tree;
    if (!view || !tree) return null;
    if (!initialDocument && view.state.doc.toString() === config.text) initialDocument = view.state.doc;
    const bodyStyle = getComputedStyle(content);
    const markers = [...editor.querySelectorAll(".cm-md-fold-gutter .cm-md-fold-chevron")]
      .map((element) => visible(element, scroller)).filter(Boolean);
    const headings = [...content.querySelectorAll(".cm-line")].flatMap((element) => {
      if (![...element.classList].some((name) => /^cm-md-h[1-6]$/.test(name))) return [];
      const box = visible(element, scroller);
      if (!box?.full) return [];
      const label = element.textContent.trim().replace(/^#{1,6}\s+/, "");
      const offset = element.cmTile?.posAtStart;
      const known = byOffset.get(offset) ?? byLabel.get(label);
      const from = Number.isInteger(offset) ? offset : known?.from;
      let parsed = false;
      if (known && Number.isInteger(from)) {
        tree.iterate({ from, to: from + known.source.length, enter(node) {
          if (/^ATXHeading[1-6]$/.test(node.name) && node.from === from) { parsed = true; return false; }
          return undefined;
        } });
      }
      const style = getComputedStyle(element);
      return [{
        label, from, rect: box.rect, parsed,
        fixtureSection: Boolean(known?.body.trim()),
        sourceMatches: Number.isInteger(from) && view.state.doc.lineAt(from).text === known?.source,
        styled: style.fontSize !== bodyStyle.fontSize || style.fontWeight !== bodyStyle.fontWeight || style.fontFamily !== bodyStyle.fontFamily,
        chevrons: markers.filter((marker) => {
          const middle = (marker.rect.top + marker.rect.bottom) / 2;
          return middle >= box.rect.top - 1 && middle <= box.rect.bottom + 1;
        }).length,
      }];
    });
    return {
      trustedInputs, documentUnchanged: initialDocument !== null && initialDocument === view.state.doc,
      documentLength: view.state.doc.length, treeLength: tree.length, headings,
      viewport: { from: view.viewport.from, to: view.viewport.to },
      counts: { headings: headings.length, chevrons: headings.reduce((total, heading) => total + heading.chevrons, 0) },
    };
  };
}

function assertSample(sample, kind, label) {
  assert.ok(sample, `${label}: mounted editor/tree unavailable`);
  assert.ok(sample.documentUnchanged, `${label}: fixture not loaded or document changed`);
  assert.ok(sample.headings.length > 0, `${label}: no fully visible section headings`);
  assert.ok(sample.headings.some((heading) => heading.label.startsWith(`Foldlate ${kind} `) && heading.from > 3000),
    `${label}: no ${kind} section heading beyond source offset 3000`);
  for (const heading of sample.headings) {
    assert.ok(heading.fixtureSection && heading.sourceMatches && heading.parsed && heading.styled,
      `${label}: ${heading.label} is not a styled, parsed fixture section`);
    assert.equal(heading.chevrons, 1, `${label}: ${heading.label} has ${heading.chevrons} painted chevrons`);
  }
  assert.equal(sample.counts.chevrons, sample.counts.headings, `${label}: chevron count differs from headings`);
  if (kind === "first") assert.equal(sample.trustedInputs, 0, "first screen received input before its count");
}

export default {
  name: "foldlate",
  async run(ctx) {
    const fixture = makeFixture();
    const directory = mkdtempSync(join(ctx.workspaceDir, "foldlate-"));
    const path = `${basename(directory)}/note.md`;
    const filename = join(directory, "note.md");
    writeFileSync(filename, fixture.text);
    const report = {
      chars: fixture.text.length,
      fixtureSha256: createHash("sha256").update(fixture.text).digest("hex"),
      runs: [], faults: [],
    };
    const save = () => writeFileSync(join(ctx.outDir, "261-foldlate.json"), JSON.stringify(report, null, 2) + "\n");
    try {
      // Fresh views keep a parse warmed by the first jump out of the second run.
      for (let iteration = 1; iteration <= 2; iteration++) {
        const page = await ctx.browser.newPage();
        const run = { iteration, checkpoints: [], pageErrors: 0 };
        report.runs.push(run);
        page.on("pageerror", () => run.pageErrors++);
        try {
          await page.setViewport({ width: 1440, height: 1000 });
          await page.evaluateOnNewDocument(installReader, { headings: fixture.headings, text: fixture.text });
          const url = new URL(ctx.serverUrl);
          url.searchParams.set("w", `${basename(directory)}-${iteration}`);
          url.hash = "s=" + encodeURIComponent(JSON.stringify({ k: "l", f: 1, t: [{ p: path, m: "wysiwyg", a: 1, ol: 1, ow: 280 }] }));
          await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 60_000 });
          for (const kind of ["first", "end"]) {
            if (kind === "end") {
              await page.focus(".editor-tab.active .md-wysiwyg-cm6 .cm-content");
              await page.keyboard.down("Control");
              try { await page.keyboard.press("End"); } finally { await page.keyboard.up("Control"); }
            }
            // Readiness is the published parse, independent of the chevrons we
            // assert. A missing marker must fail its count, not this barrier.
            await page.waitForFunction((kind) => {
              const sample = window.__foldlateCheck?.();
              return sample?.documentUnchanged && sample.headings.length > 0 &&
                sample.headings.some((heading) => heading.label.startsWith(`Foldlate ${kind} `) && heading.from > 3000) &&
                sample.headings.every((heading) => heading.parsed) &&
                (kind !== "end" || sample.treeLength === sample.documentLength);
            }, { timeout: 30_000, polling: "raf" }, kind);
            const before = await page.evaluate(() => window.__foldlateCheck());
            const screenshot = basename(await ctx.shot(`foldlate-${iteration}-${kind}`, page));
            const after = await page.evaluate(() => window.__foldlateCheck());
            run.checkpoints.push({ kind, before, screenshot, after });
            save();
            // Preserve both checkpoints in the artifact even if one count
            // is wrong; every failed assertion still fails the overall check.
            for (const [name, sample] of [["before", before], ["after", after]]) {
              try { assertSample(sample, kind, `run ${iteration} ${kind} ${name}`); }
              catch (error) { report.faults.push(error.message); }
            }
          }
          assert.equal(readFileSync(filename, "utf8"), fixture.text, "fixture on disk changed");
          assert.equal(run.pageErrors, 0, "application page errors occurred");
        } catch (error) {
          run.error = maskTokens(error.message);
          run.lastSample = await page.evaluate(() => window.__foldlateCheck?.()).catch(() => null);
          await ctx.shot(`foldlate-${iteration}-failure`, page).catch(() => null);
          throw error;
        } finally {
          await page.close();
          save();
        }
      }
      assert.equal(report.faults.length, 0, report.faults.join("\n"));
      return report;
    } catch (error) {
      error.smokeDetails = report;
      throw error;
    } finally {
      rmSync(directory, { recursive: true });
      save();
    }
  },
};
