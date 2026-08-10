// Adversarial variants of check 55 (which passes): hunt the stale-read
// condition around external disk edits on `cs open`-ed files.
//
// Every scenario drives its OWN fresh page (own window, own DOM) so
// `.cm-content` queries never read another scenario's mounted editor:
//   A  atomic-save edit (tmp + rename, vim-style) with the tab open
//   B  tab's window closed -> session lingering in detach grace,
//      external edit, then cs open on a fresh window (fresh tab)
//   C  dirty tab (unsaved editor text) + immediate external edit
//   D  three rapid external edits in a row
//   E  file in a subdirectory
//   F  external edit landing between cs open and session attach
//
// Failing scenarios throw with the full evidence trail. The point is
// finding WHERE staleness lives (editor buffer vs server doc session
// vs disk).

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TS = Date.now();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function editorText(page) {
  return page.evaluate(() => {
    const el = document.querySelector(".cm-content");
    return el ? (el.textContent ?? "") : null;
  });
}

async function waitEditorHas(page, marker, timeoutMs = 10_000) {
  try {
    await page.waitForFunction(
      (m) => {
        const el = document.querySelector(".cm-content");
        return el !== null && (el.textContent ?? "").includes(m);
      },
      { timeout: timeoutMs, polling: 200 },
      marker,
    );
    return true;
  } catch {
    return false;
  }
}

function classify(text, v1, v2) {
  if (text == null) return "no-editor";
  const has2 = text.includes(v2);
  const has1 = text.includes(v1);
  if (has2 && !has1) return "v2";
  if (has1 && !has2) return "v1";
  if (has1 && has2) return "both";
  return "neither";
}

export default {
  name: "external-edit-stale-matrix",
  async run(ctx) {
    const socket = ctx.controlSocket;
    if (!socket) ctx.skip("control socket not found for the server pid");
    const { browser, serverUrl } = ctx;
    const token = new URL(serverUrl).searchParams.get("t");

    const results = {};
    const failures = [];
    let pageSeq = 0;

    // A fresh window (own DOM) with the workspace loaded; returns
    // helpers bound to that page. Caller must close().
    const openWindow = async (label) => {
      const p = await browser.newPage();
      await p.goto(`${serverUrl}&w=smoke-mat-${label}-${++pageSeq}`, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await p.waitForSelector(".pane", { timeout: 30_000 });
      const wid = await p.evaluate(
        () =>
          new URL(location.href).searchParams.get("w")?.trim() ||
          window.sessionStorage.getItem("chan.session.window")?.trim() ||
          "",
      );
      if (!wid) throw new Error(`no window id on ${label}`);
      // The pane is mounted; the server does not necessarily know this window
      // yet, and every helper below addresses it by id.
      await ctx.waitWindowLive(wid);
      const csOpen = (file) =>
        ctx.exec(ctx.chanBin, ["shell", "open", file], {
          cwd: ctx.workspaceDir,
          env: {
            ...process.env,
            CHAN_CONTROL_SOCKET: socket,
            CHAN_WINDOW_ID: wid,
          },
          timeout: 30_000,
        });
      const apiRead = (file) =>
        p.evaluate(
          async ({ tok, file }) => {
            const r = await fetch(`/api/files/${file}`, {
              headers: { authorization: `Bearer ${tok}` },
            });
            if (!r.ok) return `HTTP ${r.status}`;
            return (await r.json()).content ?? "";
          },
          { tok: token, file },
        );
      const sawPill = async (ms) => {
        const t0 = Date.now();
        let seen = false;
        while (Date.now() - t0 < ms) {
          if (
            await p.evaluate(() =>
              /indexing|reindexing/i.test(document.body.innerText ?? ""),
            )
          )
            seen = true;
          await sleep(150);
        }
        return seen;
      };
      return { page: p, csOpen, apiRead, sawPill };
    };

    const disk = (file) => readFileSync(join(ctx.workspaceDir, file), "utf8");
    const writeDisk = (file, text) =>
      writeFileSync(join(ctx.workspaceDir, file), text);

    // ---- A: atomic-save (tmp + rename) with the tab open ----
    {
      const name = "A-atomic-save";
      const file = "mat-a.md";
      const v1 = `MAT-A-V1-${TS}`;
      const v2 = `MAT-A-V2-${TS}`;
      const w = await openWindow("a");
      try {
        await w.page.bringToFront();
        writeDisk(file, `${v1}\n`);
        await w.csOpen(file);
        if (!(await waitEditorHas(w.page, v1, 30_000))) {
          failures.push(`A: initial open did not show v1`);
        }
        await sleep(1500);
        const tmp = `${file}.tmp`;
        writeDisk(tmp, `${v2}\n`);
        renameSync(join(ctx.workspaceDir, tmp), join(ctx.workspaceDir, file));
        const pill = await w.sawPill(3000);
        const merged = await waitEditorHas(w.page, v2, 8000);
        const out = {
          mergedLive: merged,
          pill,
          editor: classify(await editorText(w.page), v1, v2),
          disk: classify(disk(file), v1, v2),
          api: classify(await w.apiRead(file), v1, v2),
        };
        results[name] = out;
        console.log(`[smoke:56] ${name}: ${JSON.stringify(out)}`);
        if (!merged) failures.push(`A: atomic-save edit never reached editor ${JSON.stringify(out)}`);
      } finally {
        await w.page.close().catch(() => {});
      }
    }

    // ---- B: close the window, external edit, cs open fresh tab ----
    {
      const name = "B-closed-window-reopen";
      const file = "mat-b.md";
      const v1 = `MAT-B-V1-${TS}`;
      const v2 = `MAT-B-V2-${TS}`;
      writeDisk(file, `${v1}\n`);
      {
        const w = await openWindow("b1");
        await w.page.bringToFront();
        await w.csOpen(file);
        const ok = await waitEditorHas(w.page, v1, 30_000);
        await sleep(1500); // session attached
        await w.page.close().catch(() => {}); // detach -> 30s linger
        if (!ok) failures.push(`B: initial open did not show v1`);
      }
      await sleep(1000);
      writeDisk(file, `${v2}\n`);
      await sleep(2000); // reconciler should fold into the lingering session
      {
        const w = await openWindow("b2");
        try {
          await w.page.bringToFront();
          const pill = w.sawPill(5000); // runs while cs open lands
          await w.csOpen(file);
          const shown = await waitEditorHas(w.page, v2, 10_000);
          const out = {
            showedV2: shown,
            pill: await pill,
            editor: classify(await editorText(w.page), v1, v2),
            disk: classify(disk(file), v1, v2),
            api: classify(await w.apiRead(file), v1, v2),
          };
          results[name] = out;
          console.log(`[smoke:56] ${name}: ${JSON.stringify(out)}`);
          if (!shown) failures.push(`B: reopen after external edit showed stale ${JSON.stringify(out)}`);
          await ctx.shot("B-reopen", w.page);
        } finally {
          await w.page.close().catch(() => {});
        }
      }
    }

    // ---- C: dirty tab + immediate external edit ----
    {
      const name = "C-dirty-tab";
      const file = "mat-c.md";
      const v1 = `MAT-C-V1-${TS}`;
      const v2 = `MAT-C-V2-${TS}`;
      const typed = `MAT-C-TYPED-${TS}`;
      const w = await openWindow("c");
      try {
        await w.page.bringToFront();
        writeDisk(file, `${v1}\n`);
        await w.csOpen(file);
        if (!(await waitEditorHas(w.page, v1, 30_000))) {
          failures.push(`C: initial open did not show v1`);
        }
        await sleep(1500);
        await w.page.click(".cm-content");
        await w.page.keyboard.down("Control");
        await w.page.keyboard.press("Home");
        await w.page.keyboard.up("Control");
        await w.page.keyboard.type(`${typed} `, { delay: 5 });
        writeDisk(file, `${v2}\n`); // lands while the session may be dirty
        const pill = await w.sawPill(3000);
        await sleep(5000); // corroboration + transforms
        const ed = await editorText(w.page);
        const out = {
          editorHasV2: ed?.includes(v2) ?? false,
          editorHasTyped: ed?.includes(typed) ?? false,
          disk: classify(disk(file), v1, v2),
          diskHasTyped: disk(file).includes(typed),
          api: classify(await w.apiRead(file), v1, v2),
          pill,
        };
        results[name] = out;
        console.log(`[smoke:56] ${name}: ${JSON.stringify(out)}`);
        if (!out.editorHasV2) {
          failures.push(`C: dirty tab never saw external edit ${JSON.stringify(out)}`);
        }
        await ctx.shot("C-dirty-tab", w.page);
      } finally {
        await w.page.close().catch(() => {});
      }
    }

    // ---- D: three rapid external edits ----
    {
      const name = "D-rapid-edits";
      const file = "mat-d.md";
      const v1 = `MAT-D-V1-${TS}`;
      const v2 = `MAT-D-V2-${TS}`;
      const w = await openWindow("d");
      try {
        await w.page.bringToFront();
        writeDisk(file, `${v1}\n`);
        await w.csOpen(file);
        if (!(await waitEditorHas(w.page, v1, 30_000))) {
          failures.push(`D: initial open did not show v1`);
        }
        await sleep(1500);
        writeDisk(file, `MAT-D-mid1-${TS}\n`);
        await sleep(150);
        writeDisk(file, `MAT-D-mid2-${TS}\n`);
        await sleep(150);
        writeDisk(file, `${v2}\n`);
        const merged = await waitEditorHas(w.page, v2, 10_000);
        const out = {
          mergedLive: merged,
          editor: classify(await editorText(w.page), v1, v2),
          disk: classify(disk(file), v1, v2),
          api: classify(await w.apiRead(file), v1, v2),
        };
        results[name] = out;
        console.log(`[smoke:56] ${name}: ${JSON.stringify(out)}`);
        if (!merged) failures.push(`D: rapid edits never converged ${JSON.stringify(out)}`);
      } finally {
        await w.page.close().catch(() => {});
      }
    }

    // ---- E: file in a subdirectory ----
    {
      const name = "E-subdir";
      const file = "sub/dir/mat-e.md";
      mkdirSync(join(ctx.workspaceDir, "sub/dir"), { recursive: true });
      const v1 = `MAT-E-V1-${TS}`;
      const v2 = `MAT-E-V2-${TS}`;
      const w = await openWindow("e");
      try {
        await w.page.bringToFront();
        writeDisk(file, `${v1}\n`);
        await w.csOpen(file);
        if (!(await waitEditorHas(w.page, v1, 30_000))) {
          failures.push(`E: initial open did not show v1`);
        }
        await sleep(1500);
        writeDisk(file, `${v2}\n`);
        const merged = await waitEditorHas(w.page, v2, 8000);
        const out = {
          mergedLive: merged,
          editor: classify(await editorText(w.page), v1, v2),
          disk: classify(disk(file), v1, v2),
          api: classify(await w.apiRead(file), v1, v2),
        };
        results[name] = out;
        console.log(`[smoke:56] ${name}: ${JSON.stringify(out)}`);
        if (!merged) failures.push(`E: subdir edit never reached editor ${JSON.stringify(out)}`);
      } finally {
        await w.page.close().catch(() => {});
      }
    }

    // ---- F: external edit between cs open and attach ----
    {
      const name = "F-edit-during-open";
      const file = "mat-f.md";
      const v1 = `MAT-F-V1-${TS}`;
      const v2 = `MAT-F-V2-${TS}`;
      const w = await openWindow("f");
      try {
        await w.page.bringToFront();
        writeDisk(file, `${v1}\n`);
        const opening = w.csOpen(file);
        writeDisk(file, `${v2}\n`); // race the window command + attach
        await opening;
        const shown = await waitEditorHas(w.page, v2, 15_000);
        const out = {
          showedV2: shown,
          editor: classify(await editorText(w.page), v1, v2),
          disk: classify(disk(file), v1, v2),
          api: classify(await w.apiRead(file), v1, v2),
        };
        results[name] = out;
        console.log(`[smoke:56] ${name}: ${JSON.stringify(out)}`);
        if (!shown) failures.push(`F: edit during open lost ${JSON.stringify(out)}`);
      } finally {
        await w.page.close().catch(() => {});
      }
    }

    if (failures.length > 0) {
      throw new Error(`stale scenarios: ${failures.join(" | ")}`);
    }
    return results;
  },
};
