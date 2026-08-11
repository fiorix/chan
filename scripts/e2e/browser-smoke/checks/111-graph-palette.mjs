// Graph palette end to end. A custom contact hue written from OUTSIDE
// the page (`chan config set`, the preferences.toml watcher +
// config_changed broadcast path) must repaint the running graph without
// a reload, and must NOT escape the graph subtree: the file tree, the
// kind chips, the inspector, the JSON tree and the empty-pane carousel
// keep the theme hues. Then a hand-edited non-hex value in
// preferences.toml must drop that one key back to the theme default
// rather than painting a stale hue.
//
// The graph under test is a tag lens scoped on this check's own
// fixture tag, so its `.graph-tab.active` is distinguishable from any
// graph tab an earlier check left open.

import { appendFileSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const CONTACT = "palette-contact.md";
const NOTE = "palette-note.md";
const DATA = "palette-data.json";
const TAG = "#palette-smoke";
const LENS_TITLE = `tag=${TAG}`;
const CUSTOM_CONTACT = "#00ff00";
const CUSTOM_DOC = "#ff00ff";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const CONTACT_MD = `---
title: Palette Contact
chan:
  kind: contact
---

# Palette Contact
`;

const NOTE_MD = `# Palette Note

A mention of @@Palette Contact, tagged ${TAG} for the palette smoke.
`;

async function openFileBrowser(page) {
  if (await page.$(".file-tree, [role=tree]")) return;
  await page.evaluate(() => {
    window.dispatchEvent(
      new CustomEvent("chan:command", { detail: { name: "app.files.toggle" } }),
    );
  });
  await page.waitForSelector('[role="treeitem"]', { timeout: 15_000 });
}

async function selectTreeRow(page, name) {
  await page.evaluate((wanted) => {
    const row = [...document.querySelectorAll('[role="treeitem"] button.name')].find(
      (button) => button.textContent?.trim() === wanted,
    );
    if (!row) throw new Error(`tree row missing: ${wanted}`);
    row.click();
  }, name);
}

export default {
  name: "graph-palette",
  async run(ctx) {
    const { page } = ctx;
    await page.bringToFront();
    const windowId = await page.evaluate(
      () =>
        new URL(location.href).searchParams.get("w")?.trim() ||
        window.sessionStorage.getItem("chan.session.window")?.trim() ||
        "",
    );
    if (!windowId) throw new Error("could not resolve the page's window id");
    const cliEnv = {
      ...process.env,
      CHAN_CONTROL_SOCKET: ctx.controlSocket,
      CHAN_WINDOW_ID: windowId,
      CHAN_WORKSPACE_PATH: ctx.workspaceDir,
    };
    const cli = (args) =>
      ctx.exec(ctx.chanBin, ["shell", ...args], {
        cwd: ctx.workspaceDir,
        env: cliEnv,
        timeout: 60_000,
      });
    const configEnv = { ...process.env, CHAN_HOME: ctx.chanHome };
    const configSet = (key, value) =>
      ctx.exec(ctx.chanBin, ["config", "set", key, value], {
        cwd: ctx.workspaceDir,
        env: configEnv,
        timeout: 30_000,
      });

    const fixtures = [CONTACT, NOTE, DATA].map((name) => join(ctx.workspaceDir, name));
    const mark = (stage) =>
      appendFileSync(join(ctx.outDir, "111-progress.log"), `${new Date().toISOString()} ${stage}\n`);
    const writeFixtures = () => {
      writeFileSync(join(ctx.workspaceDir, CONTACT), CONTACT_MD);
      writeFileSync(join(ctx.workspaceDir, NOTE), NOTE_MD);
      writeFileSync(join(ctx.workspaceDir, DATA), '{ "palette": true, "hue": 3 }\n');
    };

    // Every graph read targets the ACTIVE graph tab, which this check
    // keeps pointed at its own tag lens.
    const graphTab = () => page.$(".graph-tab.active");
    const activateLens = async () => {
      // Tabs activate on mousedown, so this must be a real mouse click,
      // not a synthetic HTMLElement.click().
      const handle = await page.evaluateHandle((title) => {
        const tab = [...document.querySelectorAll(".tab")].find((candidate) =>
          candidate.textContent?.includes(title),
        );
        if (!tab) throw new Error(`graph lens tab missing: ${title}`);
        return tab;
      }, LENS_TITLE);
      const element = handle.asElement();
      if (!element) throw new Error(`graph lens tab not an element: ${LENS_TITLE}`);
      await element.click();
      await page.waitForSelector(".graph-tab.active canvas", { timeout: 10_000 });
      await page.waitForFunction(
        (title) => document.querySelector(".tab.active")?.textContent?.includes(title),
        { timeout: 10_000, polling: 200 },
        LENS_TITLE,
      );
    };
    const canvasHueCount = (hex) =>
      page.evaluate((wanted) => {
        const canvas = document.querySelector(".graph-tab.active canvas");
        if (!(canvas instanceof HTMLCanvasElement)) return -1;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context || canvas.width === 0) return -1;
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        let count = 0;
        for (let offset = 0; offset < pixels.length; offset += 4) {
          const here = `#${[pixels[offset], pixels[offset + 1], pixels[offset + 2]]
            .map((channel) => channel.toString(16).padStart(2, "0"))
            .join("")}`;
          if (here === wanted) count += 1;
        }
        return count;
      }, hex);
    const pollHue = async (hex, accept, label) => {
      let count = -1;
      for (const deadline = Date.now() + 20_000; ; ) {
        count = await canvasHueCount(hex);
        if (accept(count)) return count;
        if (Date.now() > deadline) throw new Error(`${label} (last count ${count})`);
        await sleep(300);
      }
    };
    const inspectorChipColor = () =>
      page.evaluate(() => {
        const chip = [...document.querySelectorAll(".inspector .kind-chip")].find(
          (candidate) => candidate.textContent?.trim() === "contact",
        );
        return chip ? getComputedStyle(chip).backgroundColor : null;
      });
    const carouselTokens = () =>
      page.evaluate(() => {
        const carousel = document.querySelector(".carousel");
        if (!carousel) return null;
        const style = getComputedStyle(carousel);
        return {
          doc: style.getPropertyValue("--g-doc").trim(),
          contact: style.getPropertyValue("--g-contact").trim(),
        };
      });

    try {
      mark("start");
      await openFileBrowser(page);
      mark("file-browser-open");
      // The contact row carries the hue the file tree must keep. A
      // write that precedes the SPA's watcher subscription never
      // reaches the tree, so the fixtures go in AFTER the browser is
      // open, with one rewrite if the first write raced the watcher.
      const contactRowVisible = (timeout) =>
        page
          .waitForFunction(
            () =>
              [...document.querySelectorAll('[role="treeitem"]')].some(
                (row) =>
                  row.classList.contains("contact") &&
                  row.querySelector("button.name")?.textContent?.trim() ===
                    "palette-contact.md",
              ),
            { timeout, polling: 250 },
          )
          .then(() => true)
          .catch(() => false);
      writeFixtures();
      if (!(await contactRowVisible(10_000))) {
        writeFixtures();
        if (!(await contactRowVisible(20_000))) {
          throw new Error("palette-contact.md never reached the file tree as a contact row");
        }
      }

      mark("contact-row-visible");
      // Reload detector: a live repaint keeps this marker; a reload drops it.
      await page.evaluate(() => {
        window.__paletteSmoke = "intact";
      });

      // Baselines that need the file tree mounted come FIRST: the tree
      // unmounts when another tab takes the pane, and the lens below
      // does exactly that.
      const fileTreeProbe = await page.evaluate(() => {
        const items = [...document.querySelectorAll('[role="treeitem"]')];
        const row = items
          .filter((candidate) => candidate.classList.contains("contact"))
          .map((candidate) => candidate.querySelector("button.name"))
          .find(Boolean);
        return {
          color: row ? getComputedStyle(row).color : null,
          treeitems: items.length,
        };
      });
      const fileTreeContactColor = fileTreeProbe.color;
      if (!fileTreeContactColor) {
        throw new Error(`contact file-tree row unreadable: ${JSON.stringify(fileTreeProbe)}`);
      }
      const rootContactBaseline = await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue("--g-contact").trim(),
      );

      // Inspector kind chip for the contact file.
      await selectTreeRow(page, "palette-contact.md");
      await page.waitForFunction(
        () =>
          [...document.querySelectorAll(".inspector .kind-chip")].some(
            (candidate) => candidate.textContent?.trim() === "contact",
          ),
        { timeout: 15_000, polling: 250 },
      );
      const chipBaseline = await inspectorChipColor();
      if (!chipBaseline) throw new Error("inspector contact chip unreadable");

      mark("tree-chip-baselines-done");
      // Open the tag lens on the fixture note.
      await selectTreeRow(page, "palette-note.md");
      await page.waitForFunction(
        (tag) =>
          [...document.querySelectorAll('button[title="open in graph (scoped to this tag)"]')]
            .some((button) => button.textContent?.trim() === tag),
        { timeout: 30_000, polling: 250 },
        TAG,
      );
      await page.evaluate((tag) => {
        const button = [
          ...document.querySelectorAll('button[title="open in graph (scoped to this tag)"]'),
        ].find((candidate) => candidate.textContent?.trim() === tag);
        if (!button) throw new Error(`tag lens button vanished: ${tag}`);
        button.click();
      }, TAG);
      mark("tag-button-clicked");
      await page.waitForSelector(".graph-tab.active canvas", { timeout: 30_000 });
      await page.waitForFunction(
        () => {
          const stat =
            document.querySelector(".graph-tab.active .statusbar .stat")?.textContent ?? "";
          const match = stat.match(/(\d+)\/(\d+) nodes/);
          return match && Number(match[1]) > 0;
        },
        { timeout: 30_000, polling: 250 },
      );

      mark("lens-rendered");
      // Pixel baselines are adaptive: a stray exact-hue pixel cluster
      // elsewhere in the render (focus rings, pulse frames) must not
      // vacate the check, so every canvas assertion is a DELTA against
      // the pre-override count, never an absolute zero.
      const preContactPx = await pollHue(
        CUSTOM_CONTACT,
        (count) => count >= 0,
        "canvas unreadable before any override",
      );
      const preDocPx = await pollHue(
        CUSTOM_DOC,
        (count) => count >= 0,
        "canvas unreadable before any override (doc hue)",
      );

      mark("baselines-1-done");
      // JSON tree: the pretty renderer colours keys with var(--g-doc).
      await cli(["open", DATA]);
      await page.waitForSelector(".editor-host .key", { timeout: 20_000 });
      const jsonKeyBaseline = await page.evaluate(
        () => getComputedStyle(document.querySelector(".editor-host .key")).color,
      );

      mark("json-baseline-done");
      // Empty-pane carousel: the dashboard tab hosts it unconditionally
      // (a fresh empty PANE only mounts it in the lone-pane case, so a
      // split would not exercise it).
      await page.evaluate(() => {
        window.dispatchEvent(
          new CustomEvent("chan:command", { detail: { name: "app.dashboard.open" } }),
        );
      });
      await page.waitForSelector(".carousel", { visible: true, timeout: 20_000 });
      const carouselBaseline = await carouselTokens();
      if (!carouselBaseline?.doc) {
        throw new Error("carousel mounted without a resolvable --g-doc");
      }

      mark("carousel-baseline-done");
      // Condition 3: write from OUTSIDE the page. The preferences.toml
      // watcher + config_changed broadcast must repaint the live window.
      await configSet("editor.graph_colors.mode", "custom");
      await configSet("editor.graph_colors.dark.contact", CUSTOM_CONTACT);
      await configSet("editor.graph_colors.light.contact", CUSTOM_CONTACT);
      await configSet("editor.graph_colors.dark.doc", CUSTOM_DOC);
      await configSet("editor.graph_colors.light.doc", CUSTOM_DOC);

      mark("config-written");
      const diagToml = readFileSync(join(ctx.chanHome, "preferences.toml"), "utf8");
      mark(`prefs-toml: ${diagToml.replace(/\s+/g, " ")}`);
      const authToken = new URL(ctx.serverUrl).searchParams.get("t") ?? "";
      const liveColors = await page.evaluate(async (token) => {
        const headers = {};
        if (token) headers.authorization = `Bearer ${token}`;
        const response = await fetch("/api/config", { headers });
        if (!response.ok) return `GET /api/config -> ${response.status}`;
        return (await response.json()).preferences?.graph_colors ?? null;
      }, authToken);
      mark(`live-graph-colors: ${JSON.stringify(liveColors)}`);
      // The override lands as an inline custom-property block on
      // .graph-tab, then the canvas MutationObserver repaints.
      await activateLens();
      // The browser re-serializes the inline style block (whitespace
      // around the colon), so match on a whitespace-stripped form.
      await page.waitForFunction(
        (hex) =>
          (document.querySelector(".graph-tab.active")?.getAttribute("style") ?? "")
            .replace(/\s+/g, "")
            .includes(`--g-contact:${hex}`),
        { timeout: 20_000, polling: 250 },
        CUSTOM_CONTACT,
      );
      const contactPixels = await pollHue(
        CUSTOM_CONTACT,
        (count) => count > preContactPx + 20,
        "canvas never repainted a contact/mention node in the custom hue",
      );
      const docPixels = await pollHue(
        CUSTOM_DOC,
        (count) => count > preDocPx + 20,
        "canvas never repainted a doc node in the custom hue",
      );

      mark("canvas-repainted");
      // The portaled tab-menu bubble gets its own application site, so
      // the mention filter dot follows the override too (border-color
      // carries the hue whether the filter is on or off).
      const tab = await graphTab();
      if (!tab) throw new Error("active graph tab lost before the filter-dot read");
      await tab.click({ button: "right" });
      await page.waitForSelector(".tab-menu-bubble", { visible: true, timeout: 10_000 });
      const dotColor = await page.evaluate(() => {
        // The mention filter row is labelled "contact" in semantic
        // mode (the two kinds share one token and one label).
        const row = [...document.querySelectorAll(".tab-menu-bubble .filter-row")].find(
          (candidate) =>
            candidate.querySelector(".mbtn-label")?.textContent?.trim() === "contact",
        );
        const dot = row?.querySelector(".filter-dot");
        return dot ? getComputedStyle(dot).borderColor : null;
      });
      await page.keyboard.press("Escape");
      if (dotColor !== "rgb(0, 255, 0)") {
        throw new Error(`mention filter dot did not follow the override: ${dotColor}`);
      }

      mark("dot-checked");
      // Condition 2: nothing outside the graph subtree moved. The file
      // tree unmounted when the lens took the pane, so spawn a FRESH
      // browser tab: a mount that happens under the live override is
      // the stronger escape probe anyway.
      await page.evaluate(() => {
        window.dispatchEvent(
          new CustomEvent("chan:command", { detail: { name: "app.files.toggle" } }),
        );
      });
      if (!(await contactRowVisible(15_000))) {
        throw new Error("respawned file browser never showed the contact row");
      }
      const fileTreeAfter = await page.evaluate(() => {
        const row = [...document.querySelectorAll('[role="treeitem"].contact')]
          .map((candidate) => candidate.querySelector("button.name"))
          .find(Boolean);
        return row ? getComputedStyle(row).color : null;
      });
      await selectTreeRow(page, "palette-contact.md");
      const chipAfter = await inspectorChipColor();
      const rootContactAfter = await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue("--g-contact").trim(),
      );
      const jsonKeyAfter = await page.evaluate(
        () => document.querySelector(".editor-host .key")
          ? getComputedStyle(document.querySelector(".editor-host .key")).color
          : null,
      );
      const carouselAfter = await carouselTokens();
      const marker = await page.evaluate(() => window.__paletteSmoke ?? null);
      const escapes = [
        marker !== "intact" && `page reloaded (marker=${marker})`,
        fileTreeAfter !== fileTreeContactColor &&
          `file tree contact row ${fileTreeContactColor} -> ${fileTreeAfter}`,
        chipAfter !== chipBaseline && `inspector chip ${chipBaseline} -> ${chipAfter}`,
        rootContactAfter !== rootContactBaseline &&
          `:root --g-contact ${rootContactBaseline} -> ${rootContactAfter}`,
        jsonKeyAfter !== jsonKeyBaseline &&
          `JSON tree key ${jsonKeyBaseline} -> ${jsonKeyAfter}`,
        JSON.stringify(carouselAfter) !== JSON.stringify(carouselBaseline) &&
          `carousel tokens ${JSON.stringify(carouselBaseline)} -> ${JSON.stringify(carouselAfter)}`,
      ].filter(Boolean);
      if (escapes.length > 0) {
        throw new Error(`override escaped the graph subtree: ${escapes.join("; ")}`);
      }

      mark("escape-checked");
      // Hex demonstration: a hand-edited non-hex value drops THAT key
      // back to the theme default; the canvas must not keep the stale
      // custom hue. The sibling doc override survives (per-key drop,
      // not a whole-palette reset).
      const prefsPath = join(ctx.chanHome, "preferences.toml");
      const toml = readFileSync(prefsPath, "utf8");
      if (!toml.includes(CUSTOM_CONTACT)) {
        throw new Error(`preferences.toml does not carry the custom hue:\n${toml}`);
      }
      writeFileSync(prefsPath, toml.replaceAll(CUSTOM_CONTACT, "chartreuse"));
      await activateLens();
      await page.waitForFunction(
        () =>
          !(document.querySelector(".graph-tab.active")?.getAttribute("style") ?? "").includes(
            "--g-contact",
          ),
        { timeout: 20_000, polling: 250 },
      );
      const stalePixels = await pollHue(
        CUSTOM_CONTACT,
        (count) => count >= 0 && count <= preContactPx,
        "canvas kept the stale hue after the malformed edit",
      );
      const docPixelsAfter = await pollHue(
        CUSTOM_DOC,
        (count) => count > preDocPx + 20,
        "malformed contact key took the sibling doc override down with it",
      );

      return {
        preContactPx,
        preDocPx,
        fileTreeContact: fileTreeContactColor,
        inspectorChip: chipBaseline,
        carousel: carouselBaseline,
        contactPixels,
        docPixels,
        dotColor,
        stalePixelsAfterMalformedEdit: stalePixels,
        docPixelsAfterMalformedEdit: docPixelsAfter,
      };
    } finally {
      try {
        await configSet("editor.graph_colors.mode", "standard");
      } catch (error) {
        console.error(`[111-graph-palette] mode restore failed: ${error.message}`);
      }
      for (const fixture of fixtures) {
        try {
          rmSync(fixture, { force: true });
        } catch {}
      }
    }
  },
};
