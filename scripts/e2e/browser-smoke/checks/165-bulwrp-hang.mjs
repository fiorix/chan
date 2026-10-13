import { writeFileSync } from "node:fs";
import { join } from "node:path";

const LINE = ".editor-tab.active .md-wysiwyg-cm6 .cm-line";
const PHRASE = "building and shipping systems across many projects while keeping each visible word available to the geometry reader ";
const VARIANTS = [
  ["dash", "- "],
  ["star", "* "],
  ["plus", "+ "],
  ["one", "1. "],
  ["ten", "10. "],
  ["task", "- [ ] "],
];
const ARMS = [
  { key: "github", theme: "github", faces: false },
  { key: "google_docs_two_faces", theme: "google_docs", faces: true },
];
const LIMIT = 0.1;

function docFor(prefix) {
  return [
    `${prefix}BulwrpOne ${PHRASE.repeat(3)}`,
    `    ${prefix}BulwrpTwo ${PHRASE.repeat(3)}`,
  ].join("\n");
}

function geometryReader({ selector, label = null }) {
  const line = [...document.querySelectorAll(selector)].find((candidate) => label === null || candidate.textContent?.includes(label));
  if (!line) throw new Error(`missing line ${selector} ${label ?? ""}`);
  const marker = line.querySelector(".cm-md-list-marker");
  const range = document.createRange();
  const rows = [];
  const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.parentElement?.closest(".cm-md-list-marker")) continue;
    const value = node.textContent ?? "";
    for (let offset = 0; offset < value.length; offset++) {
      if (/\s/u.test(value[offset])) continue;
      range.setStart(node, offset);
      range.setEnd(node, offset + 1);
      const rect = range.getClientRects()[0];
      if (!rect || rect.width <= 0 || rect.height <= 0) continue;
      let row = rows.find((candidate) => Math.abs(candidate.top - rect.top) < 2);
      if (!row) {
        row = { top: rect.top, left: rect.left };
        rows.push(row);
      } else if (rect.left < row.left) {
        row.left = rect.left;
      }
    }
  }
  rows.sort((a, b) => a.top - b.top);

  const ch = (element) => {
    const style = getComputedStyle(element);
    const probe = document.createElement("span");
    probe.style.cssText = "position:absolute;visibility:hidden;display:inline-block;width:1ch;height:1px;text-indent:0;padding:0;border:0";
    for (const name of ["fontFamily", "fontSize", "fontWeight", "fontStyle", "fontStretch", "fontVariantNumeric", "letterSpacing"]) {
      probe.style[name] = style[name];
    }
    document.body.append(probe);
    const width = probe.getBoundingClientRect().width;
    probe.remove();
    return width;
  };
  let glyphLeft = null;
  let glyphWidth = null;
  if (marker) {
    const glyph = marker.querySelector(".cm-md-list-marker-glyph") ?? marker;
    const textNode = [...glyph.childNodes].find((node) => node.nodeType === Node.TEXT_NODE && node.textContent);
    if (textNode) {
      range.selectNodeContents(textNode);
      const rect = range.getClientRects()[0];
      glyphLeft = rect?.left ?? null;
      glyphWidth = rect?.width ?? null;
    } else {
      glyphLeft = marker.querySelector("input")?.getBoundingClientRect().left ?? null;
    }
  }
  const style = getComputedStyle(line);
  const markerStyle = marker ? getComputedStyle(marker) : null;
  const markerBox = marker?.getBoundingClientRect();
  const glyphElement = marker?.querySelector(".cm-md-list-marker-glyph") ?? marker;
  return {
    rows,
    deltas: rows.slice(1).map((row) => row.left - rows[0].left),
    first: rows[0]?.left ?? null,
    lineLeft: line.getBoundingClientRect().left,
    markerBoxLeft: markerBox?.left ?? null,
    markerWidth: markerStyle ? Number.parseFloat(markerStyle.width) : null,
    markerMargin: markerStyle ? Number.parseFloat(markerStyle.marginRight) : null,
    glyphLeft,
    glyphWidth,
    chLine: ch(line),
    chGlyph: glyphElement ? ch(glyphElement) : null,
    lineFamily: style.fontFamily,
    glyphFamily: glyphElement ? getComputedStyle(glyphElement).fontFamily : null,
    fontSize: style.fontSize,
    level: style.getPropertyValue("--cm-md-list-level").trim(),
    markerKind: marker?.className ?? null,
    lineText: line.textContent?.slice(0, 80) ?? "",
  };
}

async function applyArm(page, arm) {
  return page.evaluate(async ({ theme, faces }) => {
    window.__bulwrpFaces ??= [];
    for (const face of window.__bulwrpFaces.splice(0)) document.fonts.delete(face);
    document.documentElement.setAttribute("data-editor-theme", theme);
    const loaded = [];
    if (faces) {
      for (const [family, local] of [["Arial", "DejaVu Sans Mono"], ["Segoe UI", "DejaVu Sans"]]) {
        const face = new FontFace(family, `local("${local}")`);
        await face.load();
        document.fonts.add(face);
        window.__bulwrpFaces.push(face);
        loaded.push(`${family}=${local}:${face.status}`);
      }
    }
    await document.fonts.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return { theme: document.documentElement.getAttribute("data-editor-theme"), loaded };
  }, arm);
}

function expectNear(failures, label, got, want, limit = LIMIT) {
  if (got === null || !Number.isFinite(got) || Math.abs(got - want) > limit) {
    failures.push(`${label}: ${got} expected ${want} within ${limit}`);
  }
}

export default {
  name: "bulwrp-hang",
  async run(ctx) {
    const { page } = ctx;
    const failures = [];
    const result = { browser: await page.browser().version(), control: null, arms: [] };
    await page.setViewport({ width: 650, height: 1000, deviceScaleFactor: 1 });
    await page.goto("about:blank");
    await page.setContent('<style>body{margin:0}#control{width:180px;font:16px Arial;line-height:24px;text-indent:17px}</style><div id="control">alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau</div>');
    result.control = await page.evaluate(geometryReader, { selector: "#control" });
    if (result.control.deltas.length < 1) failures.push("the 17px constructed control did not wrap");
    for (const delta of result.control.deltas) expectNear(failures, "17px constructed control", delta, -17);

    const initial = docFor(VARIANTS[0][1]);
    writeFileSync(join(ctx.workspaceDir, "bulwrp.md"), initial);
    const windowId = "bulwrp-hang-165";
    await page.goto(`${ctx.serverUrl}&w=${windowId}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForSelector(".pane", { timeout: 30_000 });
    await ctx.waitWindowLive(windowId);
    await ctx.exec(ctx.chanBin, ["shell", "open", "bulwrp.md"], {
      cwd: ctx.workspaceDir,
      env: { ...process.env, CHAN_CONTROL_SOCKET: ctx.controlSocket, CHAN_WINDOW_ID: windowId },
      timeout: 30_000,
    });
    await page.waitForFunction((doc) => document.querySelector(".editor-tab.active .md-wysiwyg-cm6 .cm-content")?.cmTile?.root?.view?.state.doc.toString() === doc, { timeout: 30_000 }, initial);

    for (const arm of ARMS) {
      const applied = await applyArm(page, arm);
      if (applied.theme !== arm.theme) failures.push(`${arm.key}: theme did not apply`);
      if (arm.faces && (applied.loaded.length !== 2 || applied.loaded.some((entry) => !entry.endsWith(":loaded")))) {
        failures.push(`${arm.key}: both local faces did not load: ${applied.loaded}`);
      }
      const readings = [];
      for (const [key, sourcePrefix] of VARIANTS) {
        for (const [gap, prefix] of [["one_space", sourcePrefix], ["nbsp", `${sourcePrefix}\u00a0`]]) {
          const doc = docFor(prefix);
          await page.evaluate(async (nextDoc) => {
            const view = document.querySelector(".editor-tab.active .md-wysiwyg-cm6 .cm-content")?.cmTile?.root?.view;
            if (!view) throw new Error("rendered editor unavailable");
            view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: nextDoc }, selection: { anchor: 0 } });
            await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          }, doc);
          const currentDoc = await page.evaluate(() => document.querySelector(".editor-tab.active .md-wysiwyg-cm6 .cm-content")?.cmTile?.root?.view?.state.doc.toString() ?? null);
          if (currentDoc !== doc) failures.push(`${arm.key}/${key}/${gap}: document bytes changed`);
          const lines = {
            parent: await page.evaluate(geometryReader, { selector: LINE, label: "BulwrpOne" }),
            child: await page.evaluate(geometryReader, { selector: LINE, label: "BulwrpTwo" }),
          };
          readings.push({ key, gap, sourcePrefix: prefix, lines });
          for (const [depth, reading] of Object.entries(lines)) {
            const label = `${arm.key}/${key}/${gap}/${depth}`;
            if (reading.deltas.length < 1) failures.push(`${label}: no wrapped line`);
            for (const delta of reading.deltas) expectNear(failures, `${label}: wrapped minus first`, delta, 0);
            if (key === "dash" && gap === "one_space") {
              const level = depth === "parent" ? 0 : 1;
              expectNear(failures, `${label}: marker box width`, reading.markerWidth, 2 * reading.chLine);
              expectNear(failures, `${label}: marker gap`, reading.markerMargin, 3 * reading.chLine);
              expectNear(failures, `${label}: marker column`, reading.markerBoxLeft, reading.lineLeft + 6 + level * 5 * reading.chLine);
              expectNear(failures, `${label}: first text column`, reading.first, reading.markerBoxLeft + 5 * reading.chLine);
              if (reading.glyphLeft !== null && reading.glyphWidth !== null) {
                expectNear(failures, `${label}: neutral glyph position`, reading.glyphLeft, reading.markerBoxLeft + reading.chGlyph - reading.glyphWidth / 2);
              } else {
                failures.push(`${label}: marker glyph was not measured`);
              }
              if (arm.faces && reading.chGlyph - reading.chLine < 0.4) {
                failures.push(`${label}: the two font faces are not distinct: line=${reading.chLine} glyph=${reading.chGlyph}`);
              }
            }
          }
        }
      }
      result.arms.push({ ...applied, key: arm.key, readings });
    }
    writeFileSync(join(ctx.outDir, "bulwrp-hang-measurements.json"), JSON.stringify(result, null, 2));
    if (failures.length) throw new Error(`bulwrp-hang: ${failures.length} failures; ${failures.slice(0, 10).join("; ")}`);
    return { browser: result.browser, variants: result.arms.map((arm) => `${arm.key}:${arm.readings.length}`) };
  },
};
