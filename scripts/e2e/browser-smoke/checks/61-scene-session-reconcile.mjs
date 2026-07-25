// Scene-session disk integration beyond the two-client collaboration smoke:
// clean external edits fold live, a later external restore folds too, and
// overlapping local/disk edits retain both sides until the explicit reload
// resolution route is called.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TS = Date.now();
const FILE = `scene-reconcile-${TS}.excalidraw`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function bumpedElement(element, { x, version, nonce }) {
  return {
    ...element,
    x,
    version,
    versionNonce: nonce,
    updated: Date.now(),
  };
}

async function waitFor(probe, description, timeoutMs = 15_000) {
  const started = Date.now();
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() - started > timeoutMs) {
      throw new Error(`timed out waiting for ${description}`);
    }
    await sleep(100);
  }
}

export default {
  name: "scene-session-external-edit-restore-conflict",
  async run(ctx) {
    const { page } = ctx;
    const seed = JSON.parse(
      readFileSync(join(ctx.repoRoot, "scripts/e2e/browser-smoke/seed/board.excalidraw"), "utf8"),
    );
    seed.elements = [seed.elements[0]];
    const original = structuredClone(seed.elements[0]);
    writeFileSync(join(ctx.workspaceDir, FILE), JSON.stringify(seed, null, 2));

    await page.evaluate(async (path) => {
      const prefix =
        document.querySelector('meta[name="chan-prefix"]')?.getAttribute("content") ?? "";
      const token =
        sessionStorage.getItem("chan.token") ??
        new URLSearchParams(location.search).get("t") ??
        "";
      const url = new URL(`${prefix}/api/scene/ws`, location.origin);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("path", path);
      url.searchParams.set("w", `smoke-scene-${Date.now()}`);
      if (token) url.searchParams.set("t", token);
      const frames = [];
      const socket = new WebSocket(url);
      window.__chanSceneReconcileSmoke = { socket, frames };
      socket.addEventListener("message", (event) => {
        frames.push(JSON.parse(String(event.data)));
      });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("scene snapshot timed out")), 15_000);
        const poll = () => {
          if (frames.some((frame) => frame.type === "snapshot")) {
            clearTimeout(timer);
            resolve();
          } else {
            setTimeout(poll, 25);
          }
        };
        socket.addEventListener("error", () => {
          clearTimeout(timer);
          reject(new Error("scene socket failed"));
        });
        poll();
      });
    }, FILE);

    const apiRead = () =>
      page.evaluate(async (path) => {
        const token =
          sessionStorage.getItem("chan.token") ??
          new URLSearchParams(location.search).get("t") ??
          "";
        const response = await fetch(
          `/api/files/${encodeURIComponent(path)}?t=${encodeURIComponent(token)}`,
        );
        if (!response.ok) throw new Error(`GET scene: ${response.status}`);
        return response.json();
      }, FILE);

    const evidence = { steps: [] };
    const record = (step, data) => {
      evidence.steps.push({ step, ...data });
      console.log(`[smoke:61] ${step}: ${JSON.stringify(data)}`);
    };

    try {
      // Clean external edit.
      const external = structuredClone(seed);
      external.elements[0] = bumpedElement(original, {
        x: 110,
        version: original.version + 1,
        nonce: original.versionNonce + 10,
      });
      writeFileSync(join(ctx.workspaceDir, FILE), JSON.stringify(external, null, 2));
      const afterExternal = await waitFor(async () => {
        const body = await apiRead();
        const scene = JSON.parse(body.content);
        return scene.elements[0]?.x === 110 && body.disk_conflicted === false
          ? body
          : null;
      }, "clean external scene edit");
      record("external-edit", {
        x: JSON.parse(afterExternal.content).elements[0].x,
        diskConflicted: afterExternal.disk_conflicted,
      });

      // Restore the visual value with a newer Excalidraw version. This is an
      // actual restore semantically without relying on a 60-second raw-byte
      // echo expiry.
      const restored = structuredClone(seed);
      restored.elements[0] = bumpedElement(original, {
        x: original.x,
        version: original.version + 2,
        nonce: original.versionNonce + 20,
      });
      writeFileSync(join(ctx.workspaceDir, FILE), JSON.stringify(restored, null, 2));
      const afterRestore = await waitFor(async () => {
        const body = await apiRead();
        const scene = JSON.parse(body.content);
        return scene.elements[0]?.x === original.x && body.disk_conflicted === false
          ? body
          : null;
      }, "external scene restore");
      record("external-restore", {
        x: JSON.parse(afterRestore.content).elements[0].x,
        diskConflicted: afterRestore.disk_conflicted,
      });

      // Dirty the live authority, wait for its push acknowledgement, then land
      // an overlapping disk edit before the 800 ms flush debounce.
      const local = bumpedElement(restored.elements[0], {
        x: 220,
        version: original.version + 3,
        nonce: original.versionNonce + 30,
      });
      const beforePushFrames = await page.evaluate(
        () => window.__chanSceneReconcileSmoke.frames.length,
      );
      await page.evaluate((element) => {
        window.__chanSceneReconcileSmoke.socket.send(
          JSON.stringify({ type: "push", elements: [element] }),
        );
      }, local);
      await waitFor(
        () =>
          page.evaluate(
            (start) =>
              window.__chanSceneReconcileSmoke.frames
                .slice(start)
                .some((frame) => frame.type === "push-ok"),
            beforePushFrames,
          ),
        "local scene push acknowledgement",
      );

      const diskConflict = structuredClone(restored);
      diskConflict.elements[0] = bumpedElement(restored.elements[0], {
        x: 330,
        version: original.version + 3,
        nonce: original.versionNonce + 40,
      });
      writeFileSync(
        join(ctx.workspaceDir, FILE),
        JSON.stringify(diskConflict, null, 2),
      );
      const conflicted = await waitFor(async () => {
        const body = await apiRead();
        const scene = JSON.parse(body.content);
        return body.disk_conflicted === true && scene.elements[0]?.x === 220
          ? body
          : null;
      }, "retained scene conflict");
      record("conflict-retained", {
        authorityX: JSON.parse(conflicted.content).elements[0].x,
        diskX: JSON.parse(readFileSync(join(ctx.workspaceDir, FILE), "utf8")).elements[0].x,
        diskConflicted: conflicted.disk_conflicted,
      });

      const resolved = await page.evaluate(async (path) => {
        const token =
          sessionStorage.getItem("chan.token") ??
          new URLSearchParams(location.search).get("t") ??
          "";
        const response = await fetch(
          `/api/session-conflicts/resolve?t=${encodeURIComponent(token)}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ path, action: "reload" }),
          },
        );
        if (!response.ok) {
          throw new Error(`scene reload resolution: ${response.status} ${await response.text()}`);
        }
        return response.json();
      }, FILE);
      const resolvedScene = JSON.parse(resolved.content);
      if (resolved.disk_conflicted || resolvedScene.elements[0]?.x !== 330) {
        throw new Error("scene reload resolution did not adopt the retained disk side");
      }
      record("reload-resolution", {
        authorityX: resolvedScene.elements[0].x,
        diskConflicted: resolved.disk_conflicted,
      });
      return evidence;
    } finally {
      await page.evaluate(() => {
        window.__chanSceneReconcileSmoke?.socket?.close();
        delete window.__chanSceneReconcileSmoke;
      });
    }
  },
};
