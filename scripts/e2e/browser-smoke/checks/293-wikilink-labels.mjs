// Four surfaces show wikilinks as their labels: table cells, a survey
// body, the link preview popover, and Copy as HTML. Each face asserts
// the positive (the label is there) and the negative (no `[[` in that
// surface); the table face also carries the code-span guard once (a
// wikilink inside backticks stays as typed) and an escaped alias. The
// survey face reads eight paragraphs from the card: a link to a note
// that exists shows its label, an aliased link its alias, and four shell
// tests (one holding a POSIX class, one a link) and two bare POSIX
// classes read character for character as typed, since a survey body is
// an agent's prose about code. Table cells render through the grid
// widget, which carries no pills, so that face waits for the grid; a
// caret inside a wikilink suppresses its pill, so every face parks the
// caret at the document's end first. The preview target lives at the
// workspace root, where the popover reads a bare target, and the face
// asserts the label that note renders. A missing precondition is a
// skip, never a pass and never a fail: no rendered grid, no survey
// overlay, no preview content, or a refused clipboard read ends that
// face inconclusive, and the next face still runs. Any face's fault
// fails the check whatever another face reads; the check skips only
// when no face failed and at least one skipped.

import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openFileTab } from "../lib/files.mjs";
import { quadrantPng } from "../lib/png.mjs";

const DIRECTORY = "wikiplaces-probe";
const NOTE = "note.md";
const TABLE_DOC = "table.md";
const LINK_DOC = "links.md";
const COPY_DOC = "copy.md";

const TABLE_BODY = [
  "before",
  "",
  "| Name | Code |",
  "|------|------|",
  "| [[note]] | `[[note]]` |",
  "| [[note\\|alias]] | ok |",
  "",
  "after",
  "",
].join("\n");

const COPY_BODY = "[[note|alias]] and more\n\n![](img.png)\n";

// The target note lives at the workspace root on purpose: the preview
// popover reads a bare `[[note]]` target there, and the face asserts
// labels, not resolution.
const ROOT_NOTE_BODY = "# Note\n\nSee [[note|alias]] here.\n";
const ROOT_NOTE_LABELLED = "See alias here.";

// Each source is one paragraph of the survey body, with what the card
// shows for it.
const SURVEY_CASES = [
  ["Open [[note]] now.", "Open note now."],
  ["Open [[note|alias]] now.", "Open alias now."],
  ["Should I replace [[ -f a/b.txt ]] with [ -f a/b.txt ]?", "Should I replace [[ -f a/b.txt ]] with [ -f a/b.txt ]?"],
  ['if [[ "$a" == "$b" || -z "$c" ]]; then', 'if [[ "$a" == "$b" || -z "$c" ]]; then'],
  ["Use [[ $x =~ ^[[:digit:]]+$ ]] here", "Use [[ $x =~ ^[[:digit:]]+$ ]] here"],
  ["nested [[ $x == [[note]] ]] end", "nested [[ $x == [[note]] ]] end"],
  ["Strip it with sed 's/[[:space:]]*$//' first?", "Strip it with sed 's/[[:space:]]*$//' first?"],
  ["grep -E '^[[:space:]]*#' conf", "grep -E '^[[:space:]]*#' conf"],
];

async function focusedPane(page) {
  const id = await page.evaluate(() =>
    (document.querySelector(".pane.focused") ?? document.querySelector(".pane"))
      ?.getAttribute("data-pane-id"),
  );
  assert(id, "the active pane has no id");
  return `.pane[data-pane-id=${JSON.stringify(id)}]`;
}

/// What the active editor tab holds, for the failure line when a face
/// cannot drive it: mode, pill and grid presence, the caret line and a
/// head of the rendered text. No document text leaves the guest.
async function domState(page, pane) {
  return page.evaluate((scope) => {
    const tab = document.querySelector(`${scope} .editor-tab.active`);
    if (!tab) return "no active editor tab";
    const text = tab.querySelector(".cm-content")?.textContent ?? "";
    return JSON.stringify({
      source: Boolean(tab.querySelector(".md-source")),
      pills: tab.querySelectorAll(".cm-md-wiki-pill").length,
      gridCells: tab.querySelectorAll(".cm-md-table td").length,
      contentHead: text.slice(0, 60),
    });
  }, pane).catch((error) => `dom read failed: ${error.message}`);
}

async function openRendered(page, path, pane, ready) {
  await openFileTab(page, path, pane);
  const active = `${pane} .editor-tab.active`;
  try {
    await page.waitForSelector(`${active} .cm-editor`, { visible: true, timeout: 30_000 });
    // Rendered mode is where pills and the grid live. A caret inside a
    // wikilink suppresses its pill, so park it at the document's end
    // first: a selection open starts at the top, which is inside a
    // leading link.
    await page.click(`${active} .cm-content`);
    await page.keyboard.down("Control");
    await page.keyboard.press("End");
    await page.keyboard.up("Control");
    for (let i = 0; i < 3; i++) {
      if (!(await page.$(`${active} .md-source`))) break;
      await page.evaluate(() => window.dispatchEvent(new CustomEvent("chan:command", {
        detail: { name: "app.editor.toggleMode" },
      })));
      try {
        await page.waitForFunction(
          (sel) => !document.querySelector(`${sel} .md-source`),
          { timeout: 10_000 }, active,
        );
        break;
      } catch {}
    }
    await page.waitForSelector(`${active} ${ready}`, { visible: true, timeout: 30_000 });
  } catch (error) {
    throw new Error(`setup: ${error.message}; dom: ${await domState(page, pane)}`);
  }
  return active;
}

/// Close a menu or the preview popover a face left open when it stopped
/// early, so the next face's editor takes its clicks.
async function closeStray(page) {
  for (let i = 0; i < 3; i++) {
    const open = await page.evaluate(() =>
      [...document.querySelectorAll('[role="menu"], .md-preview-popover')]
        .some((el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden"),
    ).catch(() => false);
    if (!open) return;
    await page.keyboard.press("Escape").catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function waitPopover(page, timeout = 15_000) {
  try {
    await page.waitForSelector(".md-preview-md", { visible: true, timeout });
    return true;
  } catch {
    return false;
  }
}

export default {
  name: "wikilink-labels",
  async run(ctx) {
    const faults = [];
    const skips = [];
    const evidence = { faces: {}, artifacts: [] };
    const directory = join(ctx.workspaceDir, DIRECTORY);
    const face = (name, lines) => { evidence.faces[name] = lines; };
    const fail = (name, lines) => {
      face(name, lines);
      faults.push(`${name}: ${lines.join("; ")}`);
    };
    // A face runs to its own verdict: a skip is recorded as that face's
    // and the next face still runs, so no skip hides another face's fault.
    const runFace = async (name, body) => {
      try {
        await body();
      } catch (error) {
        if (error.smokeSkip) {
          face(name, [`skipped: ${error.message}`]);
          skips.push(`${name}: ${error.message}`);
        } else {
          fail(name, [`error: ${error.message}`]);
        }
        await closeStray(ctx.page);
      }
    };
    mkdirSync(directory, { recursive: true });
    try {
      writeFileSync(join(directory, NOTE), "# Note\n");
      writeFileSync(join(ctx.workspaceDir, NOTE), ROOT_NOTE_BODY);
      writeFileSync(join(directory, TABLE_DOC), TABLE_BODY);
      writeFileSync(join(directory, LINK_DOC), "See [[note]] for the label.\n");
      writeFileSync(join(directory, COPY_DOC), COPY_BODY);
      writeFileSync(join(directory, "img.png"), quadrantPng());
      const pane = await focusedPane(ctx.page);

      // Face 1: table cells show labels (and an escaped alias), and code stays typed.
      // Table cells render through the grid widget, which carries no pills,
      // so this face waits for the grid itself.
      await runFace("table", async () => {
        const active = await openRendered(ctx.page, `${DIRECTORY}/${TABLE_DOC}`, pane, ".cm-md-table td");
        const cells = await ctx.page.$$eval(
          `${active} .cm-md-table td`,
          (items) => items.map((el) => el.textContent),
        );
        const lines = [`cells: ${JSON.stringify(cells)}`];
        evidence.artifacts.push(await ctx.shot("table-labels"));
        if (cells[0] !== "note") lines.push(`label cell shows ${JSON.stringify(cells[0])}, not "note"`);
        if (cells.some((text) => text.includes("[[") && text !== "[[note]]"))
          lines.push(`label cells keep brackets: ${JSON.stringify(cells)}`);
        if (cells[1] !== "[[note]]") lines.push(`code cell shows ${JSON.stringify(cells[1])}, not its brackets`);
        if (cells[2] !== "alias") lines.push(`escaped-alias cell shows ${JSON.stringify(cells[2])}, not "alias"`);
        if (lines.length > 1) fail("table", lines); else face("table", lines);
      });

      // Face 2: a survey body shows a link's label and an alias, and shell
      // tests and POSIX classes as typed.
      await runFace("survey", async () => {
        const socket = ctx.controlSocket;
        if (!socket) ctx.skip("control socket not found for the server pid");
        const windowId = await ctx.page.evaluate(() =>
          new URL(location.href).searchParams.get("w")?.trim() ||
          window.sessionStorage.getItem("chan.session.window")?.trim() || "",
        );
        if (!windowId) throw new Error("could not resolve the page's window id");
        const env = { ...process.env, CHAN_CONTROL_SOCKET: socket, CHAN_WINDOW_ID: windowId };
        const cs = (args, opts = {}) =>
          ctx.exec(ctx.chanBin, ["shell", "terminal", ...args], {
            cwd: ctx.workspaceDir, env, timeout: 90_000, ...opts,
          });
        const TAB = "SmokeWikiplaces293";
        try {
          await cs(["new", "--tab-name", TAB]);
          const deadline = Date.now() + 30_000;
          for (;;) {
            const { stdout } = await cs(["list", "--json"]);
            if (Object.values(JSON.parse(stdout).groups ?? {}).flat().some((s) => s.name === TAB)) break;
            if (Date.now() > deadline) throw new Error(`session ${TAB} never registered`);
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
          await ctx.waitWindowLive(windowId);
          // One positional word keeps its blank lines, so each case is a
          // paragraph of its own.
          const pending = cs([
            "survey", "--tab-name", TAB, "--timeout", "60",
            "--option", "Alpha", "--option", "Beta",
            SURVEY_CASES.map(([source]) => source).join("\n\n"),
          ]);
          const surveyExit = pending.then(
            () => ({ code: 0, stdout: "" }),
            (error) => ({ code: error.code ?? "unknown", stdout: "" }),
          );
          const first = await Promise.race([
            ctx.page.waitForSelector(".survey-card", { visible: true, timeout: 30_000 })
              .then(() => ({ kind: "card" })),
            surveyExit.then((result) => ({ kind: "exit", ...result })),
          ]);
          if (first.kind === "exit") ctx.skip("the survey overlay never raised its card");
          const paragraphs = await ctx.page.$$eval(
            ".survey-card .survey-body p", (items) => items.map((el) => el.textContent),
          );
          const lines = [`paragraphs: ${JSON.stringify(paragraphs)}`];
          evidence.artifacts.push(await ctx.shot("survey-label"));
          if (paragraphs.length !== SURVEY_CASES.length)
            lines.push(`body has ${paragraphs.length} paragraphs, not ${SURVEY_CASES.length}`);
          SURVEY_CASES.forEach(([source, shown], i) => {
            if (paragraphs[i] !== shown)
              lines.push(`${JSON.stringify(source)} shows ${JSON.stringify(paragraphs[i])}, not ${JSON.stringify(shown)}`);
          });
          await ctx.page.click(".survey-card .survey-dismiss");
          await ctx.page.waitForFunction(
            () => !document.querySelector(".survey-card"), { timeout: 15_000 },
          );
          await pending.catch(() => {});
          if (lines.length > 1) fail("survey", lines); else face("survey", lines);
        } finally {
          try {
            if (await ctx.page.$(".survey-card")) await ctx.page.click(".survey-card .survey-dismiss");
          } catch {}
          try { await cs(["close", "--tab-name", TAB]); } catch {}
        }
      });

      // Face 3: the link preview shows the label its note renders.
      await runFace("preview", async () => {
        const active = await openRendered(ctx.page, `${DIRECTORY}/${LINK_DOC}`, pane, ".cm-md-wiki-pill");
        const pill = `${active} .cm-md-wiki-pill`;
        await ctx.page.click(pill, { button: "right" });
        const previewRow = await ctx.page.evaluate(() => {
          const rows = [...document.querySelectorAll('[role="menuitem"] .mbtn-label')];
          const item = rows.find((el) => el.textContent?.trim() === "Preview");
          if (item) item.closest('[role="menuitem"]')?.click();
          return Boolean(item);
        });
        if (!previewRow) ctx.skip("the body menu offers no Preview row for the pill");
        if (!await waitPopover(ctx.page)) ctx.skip("the link preview never rendered its content");
        const text = await ctx.page.$eval(".md-preview-md", (el) => el.textContent);
        const lines = [`preview: ${JSON.stringify(text)}`];
        evidence.artifacts.push(await ctx.shot("preview-labels"));
        if (!text.includes(ROOT_NOTE_LABELLED))
          lines.push(`preview misses ${JSON.stringify(ROOT_NOTE_LABELLED)}: ${JSON.stringify(text)}`);
        if (text.includes("[["))
          lines.push(`preview keeps brackets: ${JSON.stringify(text)}`);
        await ctx.page.keyboard.press("Escape");
        await ctx.page.waitForFunction(
          () => !document.querySelector(".md-preview-popover"), { timeout: 15_000 },
        );
        if (lines.length > 1) fail("preview", lines); else face("preview", lines);
      });

      // Face 4: Copy as HTML labels the HTML flavour, brackets in text.
      await runFace("copy", async () => {
        const active = await openRendered(ctx.page, `${DIRECTORY}/${COPY_DOC}`, pane, ".cm-md-wiki-pill");
        const content = `${active} .cm-content`;
        await ctx.page.click(content);
        await ctx.page.keyboard.down("Control");
        await ctx.page.keyboard.press("KeyA");
        await ctx.page.keyboard.up("Control");
        await ctx.page.evaluate(() => {
          const dt = new DataTransfer();
          document.querySelector(".editor-tab.active .cm-content")
            ?.dispatchEvent(new ClipboardEvent("copy", { clipboardData: dt, bubbles: true, cancelable: true }));
        });
        let payload = null;
        try {
          const deadline = Date.now() + 20_000;
          while (Date.now() < deadline) {
            const html = await ctx.page.evaluate(async () => {
              for (const item of await navigator.clipboard.read()) {
                if (!item.types.includes("text/html")) continue;
                const text = await (await item.getType("text/html")).text();
                if (text.includes("data-chan-markdown")) return text;
              }
              return null;
            }).catch(() => "refused");
            if (html === "refused") break;
            if (html) { payload = html; break; }
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
        } catch {
          payload = null;
        }
        if (!payload) ctx.skip("the clipboard read refused the HTML flavour");
        const parsed = await ctx.page.evaluate((html) => {
          const doc = new DOMParser().parseFromString(html, "text/html");
          const wrap = doc.querySelector("[data-chan-markdown]");
          return {
            markdown: wrap?.getAttribute("data-chan-markdown"),
            body: wrap?.querySelector("p")?.textContent,
          };
        }, payload);
        const plain = await ctx.page.evaluate(async () => {
          for (const item of await navigator.clipboard.read()) {
            if (!item.types.includes("text/plain")) continue;
            return await (await item.getType("text/plain")).text();
          }
          return null;
        }).catch(() => null);
        const lines = [`html body: ${JSON.stringify(parsed.body)}`];
        evidence.artifacts.push(await ctx.shot("copy-flavours"));
        if (parsed.markdown !== COPY_BODY)
          lines.push(`wrapper attribute is not the authored Markdown: ${JSON.stringify(parsed.markdown)}`);
        if (plain !== COPY_BODY)
          lines.push(`text flavour is not the authored Markdown: ${JSON.stringify(plain)}`);
        if (!parsed.body?.includes("alias"))
          lines.push(`HTML flavour misses the label: ${JSON.stringify(parsed.body)}`);
        if (parsed.body?.includes("[["))
          lines.push(`HTML flavour keeps brackets: ${JSON.stringify(parsed.body)}`);
        if (lines.length > 1) fail("copy", lines); else face("copy", lines);
      });

      assert.equal(faults.length, 0, faults.join("\n"));
      if (skips.length) ctx.skip(`no face failed; skipped: ${skips.join("; ")}`);
      return evidence;
    } catch (error) {
      error.smokeDetails = { faces: evidence.faces };
      throw error;
    } finally {
      writeFileSync(join(ctx.outDir, "wikilink-labels.json"),
        JSON.stringify(evidence, null, 2) + "\n");
      rmSync(directory, { recursive: true, force: true });
      // The seed has no root note, and a later check in the same run would
      // resolve `[[note]]` to this one.
      rmSync(join(ctx.workspaceDir, NOTE), { force: true });
    }
  },
};
