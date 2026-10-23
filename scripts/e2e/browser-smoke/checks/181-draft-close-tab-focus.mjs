// A draft's close dialog keeps native Tab traversal inside its path field
// and three actions, whether the tab is closed by its button or a command.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { draftsStore, listDrafts, newDraft, waitFor } from "../lib/drafts.mjs";

const DIALOG = ".draft-close";
const INPUT = `${DIALOG} input`;
const ORDER = [
  ["Tab", `${DIALOG} button.danger`, "Discard"],
  ["Tab", `${DIALOG} button:not(.danger):not(.primary)`, "Cancel"],
  ["Tab", `${DIALOG} button.primary`, "Save"],
  ["Tab", INPUT, "path input"],
  ["Shift+Tab", `${DIALOG} button.primary`, "Save"],
  ["Shift+Tab", `${DIALOG} button:not(.danger):not(.primary)`, "Cancel"],
  ["Shift+Tab", `${DIALOG} button.danger`, "Discard"],
  ["Shift+Tab", INPUT, "path input"],
];

async function pageState(page) {
  return page.evaluate(() => {
    const focused = document.activeElement;
    return {
      tag: focused?.tagName ?? "none",
      className: typeof focused?.className === "string" ? focused.className : "",
      text: (focused?.textContent ?? "").trim().slice(0, 100),
      dialogOpen: Boolean(document.querySelector(".draft-close")),
    };
  });
}

function describe(state) {
  return `focus=${state.tag}.${state.className} text=${JSON.stringify(state.text)} dialogOpen=${state.dialogOpen}`;
}

async function waitForPage(page, label, predicate, ...args) {
  try {
    await page.waitForFunction(predicate, { timeout: 15_000 }, ...args);
  } catch (error) {
    throw new Error(`${label}: ${error.message}; ${describe(await pageState(page))}`);
  }
  console.log(`WAIT ${label}: ${describe(await pageState(page))}`);
}

async function openDialog(page, route) {
  await page.bringToFront();
  if (route === "close button") {
    await page.click(".tabs .tab.active button.close");
  } else if (route === "Ctrl+D") {
    await page.click(".editor-tab.active .cm-content");
    await page.keyboard.down("Control");
    try {
      await page.keyboard.press("KeyD");
    } finally {
      await page.keyboard.up("Control");
    }
  } else {
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: "app.tab.close" } }));
    });
  }
  await waitForPage(page, `${route} opens Close Draft with the path focused`, () =>
    document.activeElement === document.querySelector(".draft-close input"),
  );
}

async function keyRecord(page, before) {
  return page.evaluate((index) => {
    const events = window.__draftCloseTabKeys;
    const event = events[index];
    return { count: events.length, trusted: event?.isTrusted ?? false, prevented: event?.defaultPrevented ?? null };
  }, before);
}

export async function walk(page, route) {
  for (const [index, [key, selector, name]] of ORDER.entries()) {
    const before = await page.evaluate(() => window.__draftCloseTabKeys.length);
    if (key === "Shift+Tab") await page.keyboard.down("Shift");
    try {
      await page.keyboard.press("Tab");
    } finally {
      if (key === "Shift+Tab") await page.keyboard.up("Shift");
    }
    const keyEvent = await keyRecord(page, before);
    const focus = await page.evaluate((wanted) => {
      const dialog = document.querySelector(".draft-close");
      return {
        expected: document.activeElement === document.querySelector(wanted),
        contained: Boolean(dialog?.contains(document.activeElement)),
      };
    }, selector);
    const state = await pageState(page);
    const evidence = `${route} key ${index + 1} ${key}: expected ${name}, ${describe(state)}, defaultPrevented=${keyEvent.prevented}, trusted=${keyEvent.trusted}`;
    console.log(evidence);
    if (keyEvent.count !== before + 1 || !keyEvent.trusted || !focus.expected || !focus.contained) {
      throw new Error(evidence);
    }
  }
}

async function cancel(page, route) {
  await page.click(`${DIALOG} button:not(.danger):not(.primary)`);
  await waitForPage(page, `${route} Cancel closes Close Draft`, () => !document.querySelector(".draft-close"));
}

export default {
  name: "draft-close-tab-focus",
  async run(ctx) {
    const { page } = ctx;
    await page.evaluate(() => {
      window.__draftCloseTabKeys = [];
      window.addEventListener("keydown", (event) => {
        if (event.key === "Tab") window.__draftCloseTabKeys.push(event);
      }, true);
      const first = document.createElement("button");
      const second = document.createElement("button");
      first.id = "smoke-tab-first";
      second.id = "smoke-tab-second";
      first.textContent = "Tab control first";
      second.textContent = "Tab control second";
      document.body.append(first, second);
      first.focus();
    });
    const before = await page.evaluate(() => window.__draftCloseTabKeys.length);
    await page.keyboard.press("Tab");
    const controlKey = await keyRecord(page, before);
    const controlMoved = await page.evaluate(() => document.activeElement?.id === "smoke-tab-second");
    const controlState = await pageState(page);
    console.log(`native Tab control: ${describe(controlState)}, defaultPrevented=${controlKey.prevented}, trusted=${controlKey.trusted}`);
    if (!controlMoved || controlKey.count !== before + 1 || !controlKey.trusted || controlKey.prevented) {
      throw new Error(`native Tab did not move between controls outside a dialog: ${describe(controlState)}, defaultPrevented=${controlKey.prevented}`);
    }
    await page.evaluate(() => {
      document.querySelector("#smoke-tab-first")?.remove();
      document.querySelector("#smoke-tab-second")?.remove();
    });

    const draft = await newDraft(ctx, page);
    let failed = false;
    try {
      console.log(`WAIT new draft editor: ${describe(await pageState(page))}`);
      const typed = `draft close focus ${Date.now().toString(36)}`;
      await page.click(".editor-tab.active .cm-content");
      await page.keyboard.type(`\n${typed}\n`);
      const primary = join(draftsStore(ctx, draft.name), draft.path);
      try {
        await waitFor("the edited draft in its store", 20_000, () => readFileSync(primary, "utf8").includes(typed));
      } catch (error) {
        throw new Error(`${error.message}; ${describe(await pageState(page))}`);
      }
      console.log(`WAIT edited draft stored: ${describe(await pageState(page))}`);

      for (const route of ["close button", "Ctrl+D", "app.tab.close"]) {
        await openDialog(page, route);
        await walk(page, route);
        await cancel(page, route);
      }
      return { routes: 3, keysPerRoute: ORDER.length, nativeTabControl: true };
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      try {
        const active = await page.$eval(".tabs .tab.active", (tab) => tab.getAttribute("title")).catch(() => null);
        if (active === `Drafts/${draft.path}`) {
          if (!(await page.$(DIALOG))) {
            await page.evaluate(() => {
              window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: "app.tab.close" } }));
            });
            await waitForPage(page, "cleanup opens Close Draft", () => Boolean(document.querySelector(".draft-close")));
          }
          await page.click(`${DIALOG} button.danger`);
          await waitForPage(page, "cleanup discards the draft", () => !document.querySelector(".draft-close"));
          try {
            await waitFor("the discarded draft to leave the server list", 20_000, async () =>
              !(await listDrafts(ctx)).drafts.some((row) => row.primary?.draft_id === draft.id),
            );
          } catch (error) {
            throw new Error(`${error.message}; ${describe(await pageState(page))}`);
          }
          console.log(`WAIT discarded draft absent: ${describe(await pageState(page))}`);
        }
      } catch (error) {
        if (!failed) throw error;
        console.error(`cleanup: ${error.message}`);
      }
    }
  },
};
