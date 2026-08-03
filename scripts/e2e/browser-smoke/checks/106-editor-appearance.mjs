// Editor appearance end to end. Drive the real Settings control while editor
// surfaces stay mounted, observe the offscreen printable document DOM, and
// keep source plus slide preview alive while Use theme clears the override.

import { readFileSync } from "node:fs";
import { join } from "node:path";

const DECK = "deck-blank.md";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function expectSize(actual, expected, label, tolerance = 0.05) {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > tolerance) {
    throw new Error(`${label}: expected ${expected}px, got ${actual}px`);
  }
}

function closeEnough(left, right, tolerance = 0.05) {
  return Number.isFinite(left) && Math.abs(left - right) <= tolerance;
}

export default {
  name: "editor-appearance",
  async run(ctx) {
    const { page } = ctx;
    await page.bringToFront();
    const socket = ctx.controlSocket;
    if (!socket) ctx.skip("control socket not found for the server pid");
    const windowId = await page.evaluate(
      () =>
        new URL(location.href).searchParams.get("w")?.trim() ||
        window.sessionStorage.getItem("chan.session.window")?.trim() ||
        "",
    );
    if (!windowId) throw new Error("could not resolve the page's window id");
    const authToken = new URL(ctx.serverUrl).searchParams.get("t") ?? "";
    const shellEnv = {
      ...process.env,
      CHAN_CONTROL_SOCKET: socket,
      CHAN_WINDOW_ID: windowId,
    };

    async function openFile(filename) {
      if (!(await page.$(".file-tree, [role=tree]"))) {
        await page.evaluate(() => {
          window.dispatchEvent(
            new CustomEvent("chan:command", { detail: { name: "app.files.toggle" } }),
          );
        });
        await page.waitForSelector('[role="treeitem"]', { timeout: 15_000 });
      }
      const clicked = await page.evaluate((name) => {
        const row = [...document.querySelectorAll('[role="treeitem"] button.name')].find(
          (candidate) => candidate.textContent?.trim() === name,
        );
        if (!row) return false;
        row.click();
        return true;
      }, filename);
      if (!clicked) throw new Error(`tree row not found: ${filename}`);
      await page.waitForFunction(
        () =>
          [...document.querySelectorAll("button")].some(
            (candidate) => candidate.textContent?.trim() === "Open",
          ),
        { timeout: 15_000, polling: 200 },
      );
      await page.evaluate(() => {
        const button = [...document.querySelectorAll("button")].find(
          (candidate) => candidate.textContent?.trim() === "Open",
        );
        button?.click();
      });
      await page.waitForSelector(".md-wysiwyg-cm6 .cm-editor", {
        visible: true,
        timeout: 30_000,
      });
    }

    async function openSettingsEditor() {
      await page.keyboard.down("Control");
      await page.keyboard.press("Comma");
      await page.keyboard.up("Control");
      await page.waitForSelector('[aria-label="Settings sections"]', {
        visible: true,
        timeout: 15_000,
      });
      await page.evaluate(() => {
        const rail = document.querySelector('[aria-label="Settings sections"]');
        const button = [...rail.querySelectorAll("button")].find(
          (candidate) => candidate.textContent?.trim() === "Editor",
        );
        if (!button) throw new Error("settings rail has no Editor section");
        button.click();
      });
      await page.waitForSelector('input[aria-label="Editor font size"]', {
        visible: true,
        timeout: 10_000,
      });
    }

    async function closeSettings() {
      await page.evaluate(() => {
        const button = document.querySelector(".settings button.close");
        if (!(button instanceof HTMLButtonElement)) {
          throw new Error("Settings Close button missing");
        }
        button.click();
      });
      await page.waitForFunction(
        () => !document.querySelector('[aria-label="Settings sections"]'),
        { timeout: 10_000 },
      );
    }

    async function waitForConfigPatch(action) {
      const response = page.waitForResponse(
        (candidate) =>
          candidate.request().method() === "PATCH" &&
          candidate.url().includes("/api/config") &&
          candidate.ok(),
        { timeout: 15_000 },
      );
      await action();
      await response;
      await sleep(500);
    }

    async function setEditorSize(size) {
      await openSettingsEditor();
      const selector = 'input[aria-label="Editor font size"]';
      await page.focus(selector);
      await page.keyboard.down("Control");
      await page.keyboard.press("KeyA");
      await page.keyboard.up("Control");
      await page.keyboard.type(String(size));
      await waitForConfigPatch(() => page.keyboard.press("Tab"));
      const values = await page.evaluate(() => ({
        body: document.documentElement.style.getPropertyValue(
          "--chan-editor-body-size",
        ),
        source: document.documentElement.style.getPropertyValue(
          "--chan-editor-source-size",
        ),
      }));
      if (values.body !== `${size}px` || values.source !== `${size - 2}px`) {
        throw new Error(`editor override pair did not apply: ${JSON.stringify(values)}`);
      }
      await closeSettings();
      const toml = readFileSync(join(ctx.chanHome, "preferences.toml"), "utf8");
      if (!new RegExp(`editor_font_size\\s*=\\s*${size}`).test(toml)) {
        throw new Error(`preferences.toml did not persist editor_font_size = ${size}`);
      }
    }

    async function useTheme({ keepOpen = false } = {}) {
      await openSettingsEditor();
      await waitForConfigPatch(() =>
        page.evaluate(() => {
          const button = [...document.querySelectorAll("button")].find(
            (candidate) => candidate.textContent?.trim() === "Use theme",
          );
          if (!(button instanceof HTMLButtonElement)) {
            throw new Error("Use theme button missing");
          }
          button.click();
        }),
      );
      const inline = await page.evaluate(() => ({
        body: document.documentElement.style.getPropertyValue(
          "--chan-editor-body-size",
        ),
        source: document.documentElement.style.getPropertyValue(
          "--chan-editor-source-size",
        ),
      }));
      if (inline.body !== "" || inline.source !== "") {
        throw new Error(`Use theme left inline overrides behind: ${JSON.stringify(inline)}`);
      }
      if (!keepOpen) await closeSettings();
    }

    async function editorSize(selector) {
      return page.$eval(selector, (element) =>
        Number.parseFloat(getComputedStyle(element).fontSize),
      );
    }

    async function themeSizes() {
      return page.evaluate(() => {
        const style = getComputedStyle(document.documentElement);
        return {
          body: Number.parseFloat(
            style.getPropertyValue("--chan-editor-body-size"),
          ),
          source: Number.parseFloat(
            style.getPropertyValue("--chan-editor-source-size"),
          ),
        };
      });
    }

    async function toggleSource() {
      await page.evaluate(() => {
        window.dispatchEvent(
          new CustomEvent("chan:command", {
            detail: { name: "app.editor.toggleMode" },
          }),
        );
      });
      await page.waitForSelector(".md-source .cm-editor", {
        visible: true,
        timeout: 15_000,
      });
    }

    async function openSlides() {
      await page.click(".md-source .cm-content");
      await page.keyboard.down("Control");
      await page.keyboard.press("Enter");
      await page.keyboard.up("Control");
      await page.waitForSelector(".md-slide-preview-page", {
        visible: true,
        timeout: 15_000,
      });
    }

    async function installDocumentProbe() {
      await page.evaluate(() => {
        window.__appearanceDocSamples = [];
        window.__appearanceDocObserver?.disconnect();
        const capture = (root) => {
          if (!(root instanceof HTMLElement)) return;
          const style = getComputedStyle(root);
          window.__appearanceDocSamples.push({
            fontSize: Number.parseFloat(style.fontSize),
            bodyToken: style.getPropertyValue("--chan-editor-body-size").trim(),
            codeToken: style.getPropertyValue("--chan-editor-code-size").trim(),
          });
        };
        const observer = new MutationObserver((records) => {
          for (const record of records) {
            for (const node of record.addedNodes) {
              if (!(node instanceof Element)) continue;
              if (node.matches(".chan-print-page")) capture(node);
              for (const root of node.querySelectorAll(".chan-print-page")) {
                capture(root);
              }
            }
          }
        });
        observer.observe(document.body, { childList: true, subtree: true });
        window.__appearanceDocObserver = observer;
      });
    }

    async function exportDocument(out, sampleStart) {
      await ctx.exec(
        ctx.chanBin,
        ["shell", "export", "tables.md", "--out", out],
        {
          cwd: ctx.workspaceDir,
          env: shellEnv,
          timeout: 120_000,
        },
      );
      await page.waitForFunction(
        (start) => (window.__appearanceDocSamples?.length ?? 0) > start,
        { timeout: 30_000, polling: 200 },
        sampleStart,
      );
      return page.evaluate(
        (start) => window.__appearanceDocSamples.slice(start),
        sampleStart,
      );
    }

    const details = {};
    try {
      await openFile(DECK);
      const theme = await themeSizes();
      if (!Number.isFinite(theme.body) || !Number.isFinite(theme.source)) {
        throw new Error(`active editor theme sizes are invalid: ${JSON.stringify(theme)}`);
      }

      // A mounted WYSIWYG follows both setting and clearing live.
      await setEditorSize(20);
      expectSize(
        await editorSize(".md-wysiwyg-cm6 .cm-editor"),
        20,
        "mounted WYSIWYG set",
      );
      await useTheme();
      expectSize(
        await editorSize(".md-wysiwyg-cm6 .cm-editor"),
        theme.body,
        "mounted WYSIWYG Use theme",
      );
      details.wysiwyg = { override: 20, theme: theme.body };

      // Reapply for source, document, and slide surfaces.
      await setEditorSize(20);
      await installDocumentProbe();
      const document20 = await exportDocument("appearance-document-20.pdf", 0);
      if (!document20.some((sample) => closeEnough(sample.fontSize, 20))) {
        throw new Error(`printable document did not receive 20px: ${JSON.stringify(document20)}`);
      }

      await toggleSource();
      expectSize(
        await editorSize(".md-source .cm-editor"),
        18,
        "mounted source set",
      );
      await openSlides();
      expectSize(
        await editorSize(".md-slide-preview-page"),
        20,
        "mounted slide set",
      );
      await ctx.shot("all-overridden");

      // Settings sits above the slide overlay; both the slide and source stay
      // mounted while the real Use theme button clears the root tokens.
      await useTheme({ keepOpen: true });
      expectSize(
        await editorSize(".md-source .cm-editor"),
        theme.source,
        "mounted source Use theme",
      );
      expectSize(
        await editorSize(".md-slide-preview-page"),
        theme.body,
        "mounted slide Use theme",
      );
      await ctx.shot("source-slide-theme");
      await closeSettings();
      await page.keyboard.press("Escape");
      await page.waitForFunction(
        () => !document.querySelector(".md-slide-preview"),
        { timeout: 10_000 },
      );

      const beforeThemeExport = await page.evaluate(
        () => window.__appearanceDocSamples.length,
      );
      const documentTheme = await exportDocument(
        "appearance-document-theme.pdf",
        beforeThemeExport,
      );
      if (!documentTheme.some((sample) => closeEnough(sample.fontSize, theme.body))) {
        throw new Error(
          `printable document did not return to the theme: ${JSON.stringify(documentTheme)}`,
        );
      }
      details.source = { override: 18, theme: theme.source };
      details.slide = { override: 20, theme: theme.body };
      details.document = { override: document20, theme: documentTheme };
      return details;
    } finally {
      try {
        const settingsOpen = await page.$('[aria-label="Settings sections"]');
        if (settingsOpen) await closeSettings();
      } catch {}
      try {
        await page.keyboard.press("Escape");
      } catch {}
      try {
        const inline = await page.evaluate(() =>
          document.documentElement.style.getPropertyValue(
            "--chan-editor-body-size",
          ),
        );
        if (inline) await useTheme();
      } catch (error) {
        console.error(`[106-editor-appearance] preference restore failed: ${error.message}`);
      }
      await page
        .evaluate(() => window.__appearanceDocObserver?.disconnect())
        .catch(() => {});
    }
  },
};
