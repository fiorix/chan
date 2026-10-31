// The command-launcher Open action opens files through its path prompt, opens directories through an inline argument, reveals existing images and refuses missing images in the persistent status pill.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readFiles } from "../lib/files.mjs";
import { waitFor } from "../lib/drafts.mjs";

const LAUNCHER_SELECTOR = '[role="dialog"][aria-label="Command launcher"]';
const LAUNCHER_INPUT_SELECTOR = `${LAUNCHER_SELECTOR} input[role="combobox"]`;

async function raiseLauncher(page) {
  await page.keyboard.down("Control");
  await page.keyboard.down("Alt");
  await page.keyboard.press("KeyK");
  await page.keyboard.up("Alt");
  await page.keyboard.up("Control");
  await page.waitForSelector(LAUNCHER_INPUT_SELECTOR, { timeout: 10_000 });
}

async function launcherRun(page, query) {
  await raiseLauncher(page);
  await page.type(LAUNCHER_INPUT_SELECTOR, query);
  // The top Results row is auto-highlighted; wait for it, then Enter.
  await page.waitForSelector(`${LAUNCHER_SELECTOR} [role="option"]`, { timeout: 10_000 });
  await page.keyboard.press("Enter");
}

export default {
  name: "launcher-open",
  async run(ctx) {
    const { page } = ctx;
    await page.bringToFront();

    // ---- dialog flow: bare Open -> modal -> seeded file -> editor tab ----
    await launcherRun(page, "Open");
    await page.waitForSelector(".modal input", { timeout: 10_000 });
    await ctx.shot("open-dialog");
    await page.type(".modal input", "doc.md");
    // The open-mode status row discloses the action before submit.
    await page.waitForFunction(
      () =>
        document
          .querySelector(".modal .status")
          ?.textContent?.includes("opens doc.md"),
      { timeout: 10_000 },
    );
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll(".tab")].some((t) =>
          t.textContent?.includes("doc.md"),
        ),
      { timeout: 15_000 },
    );
    await ctx.shot("opened-file");

    // ---- inline-arg flow: "Open <dir>" opens the file browser ----
    const dir = "smoke-open-dir";
    mkdirSync(join(ctx.workspaceDir, dir), { recursive: true });
    writeFileSync(join(ctx.workspaceDir, dir, "inner.md"), "inner\n");
    await launcherRun(page, `Open ${dir}`);
    await page.waitForFunction(
      (d) =>
        document
          .querySelector(".status-msg")
          ?.textContent?.includes(`opened ${d}`),
      { timeout: 15_000 },
      dir,
    );
    await ctx.shot("opened-dir");

    // ---- existing binary: reveal, select, and open its viewer ----
    const selected = page.waitForFunction(
      () => document.querySelector(".status-msg")?.textContent?.includes("selected photo.png"),
      { timeout: 15_000 },
    );
    await launcherRun(page, "Open photo.png");
    await selected.catch(() => { throw new Error("binary reveal pill missing: selected photo.png"); });
    let listing;
    await waitFor("the revealed image selection", 15_000, async () => {
      listing = await readFiles(page);
      return listing.rows.some((row) => row.name === "photo.png" && row.selected);
    }).catch((error) => { throw new Error(`${error.message}: ${JSON.stringify(listing)}`); });
    await page.waitForSelector(".md-image-zoom", { timeout: 15_000 });
    await ctx.shot("binary-revealed");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector(".md-image-zoom"), { timeout: 10_000 });

    // ---- missing binary: the server refuses an uneditable target ----
    const missing = "smoke-80-absent.png";
    if (existsSync(join(ctx.workspaceDir, missing))) {
      throw new Error(`missing binary fixture unexpectedly exists: ${missing}`);
    }
    await launcherRun(page, `Open ${missing}`);
    await page.waitForFunction(
      (name) => {
        const text = document.querySelector(".status-msg")?.textContent ?? "";
        return text.includes(`open failed: create ${name}: path is not editable text: ${name}`);
      },
      { timeout: 15_000 },
      missing,
    ).catch(() => { throw new Error(`missing binary refusal pill missing: ${missing}`); });
    if (existsSync(join(ctx.workspaceDir, missing))) {
      throw new Error(`refused binary target was created: ${missing}`);
    }
    await ctx.shot("binary-error");
    return null;
  },
};
