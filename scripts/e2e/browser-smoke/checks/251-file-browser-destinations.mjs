import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileRow, navigateFiles, selectFile } from "../lib/files.mjs";
import { fetchWindows, goto, killChild, mask, poll, spawnDevserver } from "../lib/launcher-devserver.mjs";

const LAUNCHER = '[role="dialog"][aria-label="Command launcher"]';
const LAUNCHER_INPUT = `${LAUNCHER} input[role="combobox"]`;
const PROMPT = '[role="dialog"][aria-labelledby="path-prompt-title"]';
const LIST = '.browser:not(.dock)';
const DOCK = 'aside[aria-label="left file browser"] .browser';
const NEW = "New file or directory";

async function launcher(page, title, toggle = false) {
  await page.keyboard.down("Control");
  await page.keyboard.down("Alt");
  await page.keyboard.press("KeyK");
  await page.keyboard.up("Alt");
  await page.keyboard.up("Control");
  await page.waitForSelector(LAUNCHER_INPUT, { visible: true });
  await page.waitForFunction((selector) => {
    const input = document.querySelector(selector);
    return input === document.activeElement && input.selectionStart === 0 && input.selectionEnd === input.value.length;
  }, {}, LAUNCHER_INPUT);
  await page.type(LAUNCHER_INPUT, title);
  await page.waitForFunction((selector, wanted) =>
    document.querySelector(`${selector} [role="option"][aria-selected="true"] .deck-result-title`)?.textContent?.trim() === wanted,
  {}, LAUNCHER, title);
  await page.keyboard.press("Enter");
  if (toggle) await page.keyboard.press("Escape");
  await page.waitForSelector(LAUNCHER, { hidden: true });
}

async function clickMenuRow(page, menu, title) {
  await page.waitForSelector(menu, { visible: true });
  const handle = await page.evaluateHandle(({ menu, title }) =>
    [...document.querySelectorAll(`${menu} button`)].find((button) =>
      (button.querySelector(".menu-row-label")?.textContent ?? button.textContent)?.trim() === title) ?? null,
  { menu, title });
  const row = handle.asElement();
  assert.ok(row, `menu ${menu} has ${title}`);
  assert.equal(await row.evaluate((button) => button.disabled), false, `${title} is enabled`);
  await row.click();
  await handle.dispose();
}

async function surfaceAction(page, scope, title) {
  await page.click(`${scope} .browser-toolbar button[aria-label="Menu"]`);
  await clickMenuRow(page, '.hamburger-menu[role="menu"]', title);
}

async function entryAction(page, row, title) {
  await row.click({ button: "right" });
  await clickMenuRow(page, '[role="menu"][aria-label="File actions"]', title);
}

function treeRow(root, path) {
  return `${DOCK} [role="treeitem"][title=${JSON.stringify(root === "/" ? path : join(root, path))}]`;
}

async function expand(page, root, path, expanded = true) {
  const row = treeRow(root, path);
  await page.waitForSelector(row, { visible: true });
  if (await page.$eval(row, (node) => node.getAttribute("aria-expanded") === "true") !== expanded) {
    await page.click(`${row} .twirl`);
  }
  await page.waitForFunction((selector, wanted) =>
    document.querySelector(selector)?.getAttribute("aria-expanded") === String(wanted), {}, row, expanded);
}

async function expandParents(page, root, path) {
  const parts = path.split("/").filter(Boolean);
  for (let i = 1; i < parts.length; i++) await expand(page, root, parts.slice(0, i).join("/"));
}

async function closeDetails(page) {
  const close = await page.$(`${LIST} button[aria-label="Close Details"]`);
  if (close) {
    await close.click();
    await close.dispose();
    await page.waitForSelector(`${LIST} aside[aria-label="Details"]`, { hidden: true });
  }
}

async function setDock(page, side, wanted) {
  const selector = `aside[aria-label="${side} file browser"]`;
  if (Boolean(await page.$(selector)) !== wanted) {
    await launcher(page, `${side === "left" ? "Left" : "Right"} file browser dock`, true);
  }
  await page.waitForSelector(selector, wanted ? { visible: true } : { hidden: true });
}

async function selectTarget(page, root, directory, view, selected) {
  const path = `${directory}/${selected === "directory" ? "sub" : "anchor.txt"}`;
  const scope = view === "list" ? LIST : DOCK;
  if (view === "list") {
    await navigateFiles(page, directory);
    await closeDetails(page);
    const row = await fileRow(page, basename(path));
    assert.ok(row, `list has ${path}`);
    await row.click();
    await row.dispose();
  } else {
    await setDock(page, "left", true);
    await expandParents(page, root, path);
    const row = treeRow(root, path);
    await page.waitForSelector(row, { visible: true });
    if (selected === "directory") await expand(page, root, path, false);
    await page.click(`${row} .row-icon`);
  }
  if (selected === "none") await launcher(page, "Clear selection");
  await page.focus(`${scope} .tree`);
  await page.waitForFunction(({ scope, selected, path, root }) => {
    const tree = document.querySelector(`${scope} .tree`);
    const active = document.getElementById(tree?.getAttribute("aria-activedescendant") ?? "");
    return selected === "none" ? !active : active?.getAttribute("title") === `${root}/${path}`;
  }, {}, { scope, selected, path, root: root.replace(/\/$/, "") });
  return scope;
}

async function readNew(ctx, page, label, action, expected, suffix = null) {
  await action();
  await page.waitForSelector(`${PROMPT} input`, { visible: true });
  const value = await page.$eval(`${PROMPT} input`, (input) => input.value);
  await ctx.shot(`${label}-prompt`, page);
  assert.equal(value, expected ? `${expected}/` : "", `${label}: New uses the destination folder`);
  if (suffix === null) await page.keyboard.press("Escape");
  else {
    await page.waitForFunction((selector, expectedValue) => {
      const input = document.querySelector(selector);
      return input === document.activeElement && input.value === expectedValue &&
        input.selectionStart === expectedValue.length && input.selectionEnd === expectedValue.length;
    }, { timeout: 5_000 }, `${PROMPT} input`, value);
    await page.type(`${PROMPT} input`, suffix);
    assert.equal(await page.$eval(`${PROMPT} input`, (input) => input.value), `${value}${suffix}`, `${label}: typing appends to the destination`);
    await page.keyboard.press("Enter");
  }
  await page.waitForSelector(PROMPT, { hidden: true });
  return value;
}

async function upload(ctx, page, label, action, destination, observations) {
  const source = join(ctx.outDir, `${label}.txt`);
  const contents = `upload ${label}\n`;
  writeFileSync(source, contents);
  const opened = page.waitForFileChooser({ timeout: 15_000 }).then((chooser) => ({ chooser }), (error) => ({ error }));
  await action();
  const result = await opened;
  if (result.error) throw result.error;
  const multiple = result.chooser.isMultiple();
  await result.chooser.accept([source]);
  const target = join(destination, basename(source));
  await poll(`${label}: upload reaches ${target}`, () => existsSync(target) && readFileSync(target, "utf8") === contents);
  observations.push({ label, kind: "upload", target, multiple });
  assert.equal(multiple, true, `${label}: surface Upload accepts multiple files`);
  return target;
}

export default {
  name: "file-browser-destinations",
  async run(ctx) {
    const { page } = ctx;
    const prefix = `destinations-${Date.now()}`;
    const directory = `${prefix}/target`;
    const fixture = join(ctx.workspaceDir, prefix);
    const observations = [];
    const originalDocks = {
      left: Boolean(await page.$('aside[aria-label="left file browser"]')),
      right: Boolean(await page.$('aside[aria-label="right file browser"]')),
    };
    let standalone = null;
    let standalonePage = null;
    let standaloneHome = null;
    let standaloneSource = null;
    let primaryError = null;
    const cleanupErrors = [];
    const standaloneLanded = [];
    const workspaceLanded = [];
    try {
      mkdirSync(join(fixture, "target", "sub"), { recursive: true });
      mkdirSync(join(fixture, "sources"));
      writeFileSync(join(fixture, "target", "anchor.txt"), "selected file\n");
      for (const view of ["list", "tree"]) {
        for (const selected of ["none", "directory", "file"]) {
          for (const route of ["row", "launcher"]) {
            const label = `${view}-${selected}-${route}`;
            writeFileSync(join(fixture, "sources", `${prefix}-${label}-paste.txt`), `paste ${label}\n`);
          }
        }
      }
      await page.setViewport({ width: 1440, height: 1000 });
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector(".pane");
      await setDock(page, "left", false);
      await setDock(page, "right", false);
      assert.equal(await page.$(".browser"), null, "fresh window has no file browser surface");
      observations.push({ label: "no-surface-new", value: await readNew(ctx, page, "no-surface", () => launcher(page, NEW), "") });

      for (const view of ["list", "tree"]) {
        for (const selected of ["none", "directory", "file"]) {
          const dest = view === "list" ? directory : selected === "none" ? "" : selected === "directory" ? `${directory}/sub` : directory;
          for (const route of ["row", "launcher"]) {
            const label = `${view}-${selected}-${route}`;
            let scope = await selectTarget(page, ctx.workspaceDir, directory, view, selected);
            const action = (title) => route === "launcher" ? launcher(page, title) : surfaceAction(page, scope, title);
            observations.push({ label, kind: "new", value: await readNew(ctx, page, label, () => action(NEW), dest) });
            scope = await selectTarget(page, ctx.workspaceDir, directory, view, selected);
            const uploaded = await upload(ctx, page, `${prefix}-${label}-upload`, () => action("Upload"), join(ctx.workspaceDir, dest), observations);
            workspaceLanded.push(uploaded);
            if (view === "tree" && selected === "directory") {
              await page.waitForSelector(treeRow(ctx.workspaceDir, `${dest}/${basename(uploaded)}`), { visible: true });
            }

            const sourceName = `${prefix}-${label}-paste.txt`;
            const sourcePath = `${prefix}/sources/${sourceName}`;
            await selectFile(page, sourcePath);
            await launcher(page, "Copy");
            scope = await selectTarget(page, ctx.workspaceDir, directory, view, selected);
            if (route === "launcher") await launcher(page, "Paste");
            else if (selected === "none") {
              await page.keyboard.down("Control");
              await page.keyboard.press("KeyV");
              await page.keyboard.up("Control");
            } else {
              const path = `${directory}/${selected === "directory" ? "sub" : "anchor.txt"}`;
              const row = view === "list" ? await fileRow(page, basename(path)) : await page.$(treeRow(ctx.workspaceDir, path));
              assert.ok(row, `${label}: Paste has an entry menu`);
              await entryAction(page, row, "Paste");
              await row.dispose();
            }
            const landed = join(ctx.workspaceDir, dest, sourceName);
            workspaceLanded.push(landed);
            await poll(`${label}: Paste reaches ${landed}`, () => existsSync(landed) && readFileSync(landed, "utf8") === `paste ${label}\n`);
            observations.push({ label, kind: "paste", route: route === "row" && selected === "none" ? "keyboard" : route, target: landed });
            if (view === "tree" && selected === "directory") {
              await page.waitForSelector(treeRow(ctx.workspaceDir, `${dest}/${sourceName}`), { visible: true });
            }
            await ctx.shot(`${label}-landed`);
          }
        }
      }

      await selectTarget(page, ctx.workspaceDir, directory, "tree", "directory");
      await readNew(ctx, page, "nested-directory", () => surfaceAction(page, DOCK, NEW), `${directory}/sub`, "nested/deeper/");
      await poll("nested directory is created", () => existsSync(join(ctx.workspaceDir, directory, "sub/nested/deeper")));
      await page.waitForSelector(treeRow(ctx.workspaceDir, `${directory}/sub/nested/deeper`), { visible: true });
      for (const path of [prefix, directory, `${directory}/sub`, `${directory}/sub/nested`]) {
        assert.equal(await page.$eval(treeRow(ctx.workspaceDir, path), (row) => row.getAttribute("aria-expanded")), "true", `New expands ${path}`);
      }
      observations.push({ label: "nested-directory", target: `${directory}/sub/nested/deeper` });
      await ctx.shot("nested-directory-landed");

      // Entry Upload keeps its directory/replacement meaning even in a list.
      await selectTarget(page, ctx.workspaceDir, directory, "list", "directory");
      let row = await fileRow(page, "sub");
      await upload(ctx, page, "entry-directory-upload", () => entryAction(page, row, "Upload"), join(ctx.workspaceDir, directory, "sub"), observations);
      await row.dispose();
      await selectFile(page, `${directory}/sub`, { details: true });
      await upload(ctx, page, "details-directory-upload", async () => {
        const details = `${LIST} aside[aria-label="Details"]`;
        await page.click(`${details} button[aria-label="More actions"]`);
        await clickMenuRow(page, `${details} .action-menu`, "Upload");
      }, join(ctx.workspaceDir, directory, "sub"), observations);
      await closeDetails(page);
      await selectTarget(page, ctx.workspaceDir, directory, "list", "file");
      row = await fileRow(page, "anchor.txt");
      const replacement = join(ctx.outDir, `${prefix}-replacement.txt`);
      writeFileSync(replacement, "replacement contents\n");
      const picker = page.waitForFileChooser({ timeout: 15_000 }).then((chooser) => ({ chooser }), (error) => ({ error }));
      await entryAction(page, row, "Upload");
      await row.dispose();
      const picked = await picker;
      if (picked.error) throw picked.error;
      assert.equal(picked.chooser.isMultiple(), false, "entry file Upload remains replacement");
      await picked.chooser.accept([replacement]);
      await poll("entry upload replaces selected file", () => readFileSync(join(ctx.workspaceDir, directory, "anchor.txt"), "utf8") === "replacement contents\n");
      observations.push({ label: "entry-file-upload", target: `${directory}/anchor.txt` });
      await ctx.shot("entry-upload-exceptions");

      // The standalone tenant supplies its real home path; no filesystem-root
      // assumption or fabricated capability metadata enters this arm.
      standaloneHome = mkdtempSync(join(tmpdir(), "chan-destinations-home-"));
      standalone = spawnDevserver(ctx.chanBin, standaloneHome, ["--bind", "127.0.0.1", "--no-tunnel"]);
      const launch = new URL(await standalone.url);
      const terminal = await poll("standalone terminal window", async () =>
        (await fetchWindows(launch.origin, launch.searchParams.get("t"))).find((window) => window.kind === "terminal" && window.token));
      const address = new URL(`/${terminal.prefix.replace(/^\/+|\/+$/g, "")}/`, launch.origin);
      address.searchParams.set("kind", "terminal");
      address.searchParams.set("w", terminal.window_id);
      address.searchParams.set("t", terminal.token);
      const context = await fetch(new URL("api/fs/context", address), { headers: { authorization: `Bearer ${terminal.token}` } });
      assert.equal(context.ok, true, "standalone filesystem context is available");
      const homeWire = (await context.json()).home;
      assert.equal(typeof homeWire, "string");
      assert.ok(homeWire.length > 0 && !homeWire.startsWith("/"), "standalone home is a non-root wire path");
      standalonePage = await ctx.browser.newPage();
      await standalonePage.setViewport({ width: 1440, height: 1000 });
      const home = join("/", homeWire);
      standaloneSource = join(home, prefix);
      mkdirSync(standaloneSource);
      writeFileSync(join(standaloneSource, "anchor.txt"), "standalone selection\n");
      for (const route of ["row", "launcher"]) {
        writeFileSync(join(standaloneSource, `${prefix}-${route}-paste.txt`), `standalone ${route}\n`);
      }
      await goto(standalonePage, address.toString());
      await standalonePage.waitForSelector(".pane .terminal-tab.active", { visible: true, timeout: 30_000 });
      observations.push({ label: "standalone-no-surface", kind: "new", value: await readNew(ctx, standalonePage, "standalone-no-surface", () => launcher(standalonePage, NEW), homeWire) });
      // The catalog's browser commands require an active Files tab even when
      // their recorded target is a dock. Keep that tab active behind the dock.
      await navigateFiles(standalonePage, homeWire);
      await setDock(standalonePage, "left", true);
      for (const route of ["row", "launcher"]) {
        const label = `standalone-empty-${route}`;
        await expandParents(standalonePage, "/", `${homeWire}/${prefix}/anchor.txt`);
        await standalonePage.click(`${treeRow("/", `${homeWire}/${prefix}/anchor.txt`)} .row-icon`);
        await launcher(standalonePage, "Clear selection");
        await standalonePage.focus(`${DOCK} .tree`);
        const action = (title) => route === "launcher" ? launcher(standalonePage, title) : surfaceAction(standalonePage, DOCK, title);
        observations.push({ label, kind: "new", value: await readNew(ctx, standalonePage, label, () => action(NEW), homeWire) });
        standaloneLanded.push(await upload(ctx, standalonePage, `${prefix}-${label}-upload`, () => action("Upload"), home, observations));
        const sourceName = `${prefix}-${route}-paste.txt`;
        await standalonePage.click(`${treeRow("/", `${homeWire}/${prefix}/${sourceName}`)} .row-icon`);
        await launcher(standalonePage, "Copy");
        await launcher(standalonePage, "Clear selection");
        await standalonePage.focus(`${DOCK} .tree`);
        if (route === "launcher") await launcher(standalonePage, "Paste");
        else {
          await standalonePage.keyboard.down("Control");
          await standalonePage.keyboard.press("KeyV");
          await standalonePage.keyboard.up("Control");
        }
        const landed = join(home, sourceName);
        standaloneLanded.push(landed);
        await poll(`${label}: Paste reaches home`, () => existsSync(landed) && readFileSync(landed, "utf8") === `standalone ${route}\n`);
        observations.push({ label, kind: "paste", route: route === "row" ? "keyboard" : route, target: landed });
      }
      await ctx.shot("standalone-empty-tree", standalonePage);
      return { observations, hiddenSelection: "Covered by mounted component tests: collapsing a parent through the UI moves its cursor to a visible row." };
    } catch (error) {
      primaryError = error;
      for (const [label, target] of [["assertion-failure", page], ["standalone-failure", standalonePage]]) {
        if (!target) continue;
        try { await ctx.shot(label, target); }
        catch (shotError) { cleanupErrors.push(`${label}: ${mask(String(shotError))}`); }
      }
      throw error;
    } finally {
      const cleanup = async (label, action) => {
        try { await action(); }
        catch (error) { cleanupErrors.push(`${label}: ${mask(String(error))}`); }
      };
      if (standalonePage) await cleanup("close standalone page", () => standalonePage.close());
      if (standalone) await cleanup("stop standalone server", () => killChild(standalone.child));
      if (standaloneHome) await cleanup("remove standalone home", () => rmSync(standaloneHome, { recursive: true, force: true }));
      if (standaloneSource) await cleanup("remove standalone sources", () => rmSync(standaloneSource, { recursive: true, force: true }));
      for (const path of standaloneLanded) await cleanup("remove standalone landing", () => rmSync(path, { force: true }));
      for (const path of workspaceLanded) await cleanup("remove workspace landing", () => rmSync(path, { force: true }));
      await cleanup("remove workspace fixture", () => rmSync(fixture, { recursive: true, force: true }));
      await cleanup("dismiss active overlay", () => page.keyboard.press("Escape"));
      await cleanup("restore left dock", () => setDock(page, "left", originalDocks.left));
      await cleanup("restore right dock", () => setDock(page, "right", originalDocks.right));
      if (cleanupErrors.length) observations.push({ label: "cleanup-errors", errors: cleanupErrors });
      await cleanup("save observations", () => writeFileSync(join(ctx.outDir, "251-file-browser-destinations.observations.json"), JSON.stringify(observations, null, 2)));
      if (cleanupErrors.length) {
        if (primaryError instanceof Error) primaryError.smokeDetails = { observations, cleanupErrors };
        else throw new Error(`check cleanup failed: ${cleanupErrors.join("; ")}`);
      }
    }
  },
};
