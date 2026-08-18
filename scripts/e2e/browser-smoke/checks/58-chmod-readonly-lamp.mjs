// Repro: chmod 400 on an open file must flip the editor to read-only
// (locked lamp / orange dot). Per b6204d7e the wiring was: chmod fires
// a watcher Modify event -> the tab re-reads -> FileResponse.writable
// (user-write bit) -> tab.fsWritable -> the WikiStatusBar lamp shows
// "locked" and the editor goes readOnly. Reported broken: the lamp
// stays "write" (green) after chmod 400.
//
// Records: lamp label + fs-locked class + CM contenteditable, whether
// a "changed on disk" banner appeared, what /api/fs serves for
// `writable`, and the same after a chmod back to 600.

import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TS = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default {
  name: "chmod-readonly-lamp",
  async run(ctx) {
    const socket = ctx.controlSocket;
    if (!socket) ctx.skip("control socket not found for the server pid");
    const { browser, serverUrl } = ctx;
    const token = new URL(serverUrl).searchParams.get("t");

    const file = "lamp.md";
    const abs = join(ctx.workspaceDir, file);
    writeFileSync(abs, `LAMP-${TS}\n`);

    const page = await browser.newPage();
    try {
      await page.goto(`${serverUrl}&w=smoke-lamp`, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await page.waitForSelector(".pane", { timeout: 30_000 });
      const wid = await page.evaluate(
        () =>
          new URL(location.href).searchParams.get("w")?.trim() ||
          window.sessionStorage.getItem("chan.session.window")?.trim() ||
          "",
      );
      // The pane is mounted; the server does not necessarily know this window
      // yet, and the opener below addresses it by id.
      await ctx.waitWindowLive(wid);
      await ctx.exec(ctx.chanBin, ["shell", "open", file], {
        cwd: ctx.workspaceDir,
        env: {
          ...process.env,
          CHAN_CONTROL_SOCKET: socket,
          CHAN_WINDOW_ID: wid,
        },
        timeout: 30_000,
      });
      await page.waitForSelector(".cm-content", { timeout: 30_000 });

      const lamp = () =>
        page.evaluate(() => {
          const btn = document.querySelector("button.lamp");
          const lbl = btn?.querySelector(".lamp-lbl")?.textContent?.trim() ?? null;
          const cm = document.querySelector(".cm-content");
          return {
            label: lbl,
            fsLocked: btn?.classList.contains("fs-locked") ?? null,
            disabled: btn?.disabled ?? null,
            contentEditable: cm?.getAttribute("contenteditable") ?? null,
          };
        });
      const apiWritable = () =>
        page.evaluate(
          async ({ tok, file }) => {
            const r = await fetch(`/api/fs/${file}`, {
              headers: { authorization: `Bearer ${tok}` },
            });
            if (!r.ok) return `HTTP ${r.status}`;
            return (await r.json()).writable;
          },
          { tok: token, file },
        );
      const bannerUp = () =>
        page.evaluate(() =>
          /changed on disk/i.test(document.body.innerText ?? ""),
        );

      const evidence = { steps: [] };
      const record = (step, data) => {
        evidence.steps.push({ step, ...data });
        console.log(`[smoke:58] ${step}: ${JSON.stringify(data)}`);
      };

      await page.bringToFront();
      await sleep(1500); // let the doc session attach
      record("initial", { ...(await lamp()), apiWritable: await apiWritable() });

      // chmod 400: drop every write bit.
      chmodSync(abs, 0o400);
      let locked = null;
      const t0 = Date.now();
      while (Date.now() - t0 < 8000) {
        const s = await lamp();
        if (s.fsLocked || s.label === "locked" || s.contentEditable === "false") {
          locked = s;
          break;
        }
        await sleep(250);
      }
      record("after-chmod-400", {
        reacted: locked !== null,
        lamp: locked ?? (await lamp()),
        banner: await bannerUp(),
        apiWritable: await apiWritable(),
        disk: readFileSync(abs, "utf8").trim(),
      });
      await ctx.shot("after-chmod-400");

      // The historical flow (pre-doc-session tabs): chmod surfaces as
      // the "changed on disk" banner, and clicking its Reload re-stats
      // the file, flipping the lamp to locked. Exercise that path too.
      if (await bannerUp()) {
        const clicked = await page.evaluate(() => {
          const btn = [...document.querySelectorAll("button")].find(
            (b) => b.textContent?.trim() === "Reload",
          );
          if (!btn) return false;
          btn.click();
          return true;
        });
        if (clicked) {
          let reloaded = null;
          const tr = Date.now();
          while (Date.now() - tr < 8000) {
            const s = await lamp();
            if (s.fsLocked || s.label === "locked") {
              reloaded = s;
              break;
            }
            await sleep(250);
          }
          record("banner-reload", {
            clicked: true,
            lockedAfterReload: reloaded !== null,
            lamp: reloaded ?? (await lamp()),
          });
        } else {
          record("banner-reload", { clicked: false });
        }
      }

      // chmod back: the lamp should recover to write.
      chmodSync(abs, 0o600);
      let back = null;
      const t1 = Date.now();
      while (Date.now() - t1 < 8000) {
        const s = await lamp();
        if (s.label === "write" && !s.fsLocked) {
          back = s;
          break;
        }
        await sleep(250);
      }
      record("after-chmod-600", {
        recovered: back !== null,
        lamp: back ?? (await lamp()),
        apiWritable: await apiWritable(),
      });

      const r400 = evidence.steps.find((s) => s.step === "after-chmod-400");
      const r600 = evidence.steps.find((s) => s.step === "after-chmod-600");
      if (!r400.reacted || !r600.recovered) {
        throw new Error(
          `chmod not reflected in the editor: ${JSON.stringify(evidence.steps)}`,
        );
      }
      return evidence;
    } finally {
      chmodSync(abs, 0o600);
      if (!page.isClosed()) await page.close().catch(() => {});
    }
  },
};
