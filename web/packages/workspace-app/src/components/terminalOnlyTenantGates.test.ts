import { describe, expect, test } from "vitest";
import app from "../App.svelte?raw";

// A workspace-less window is served by the slim terminal tenant, which mounts
// neither /api/preflight (workspace onboarding) nor the /api/screensaver
// routes (per-workspace config). The SPA must not call workspace-concept
// endpoints there -- before these gates, every such window logged a 404 for
// each at boot (local and devserver alike). The gate is the capability, not
// the narrower terminal-only flag: a standalone window that browses files has
// no workspace either.
//
// Static `?raw` source-pin (repo convention): pins both gates so an
// unconditional mount/call can't silently creep back. Real behaviour is
// browser-smoked.
describe("workspace-less windows skip workspace-concept endpoints", () => {
  test("PreflightOverlay mounts only in workspace windows", () => {
    expect(app).toMatch(
      /\{#if windowCaps\.workspace\}\s*<PreflightOverlay \/>/,
    );
    expect(app).not.toMatch(/^<PreflightOverlay \/>$/m);
  });

  test("screensaver state loads only in workspace windows", () => {
    expect(app).toMatch(
      /if \(windowCaps\.workspace\) \{\s*void loadScreensaverState\(\);/,
    );
  });

  test("the built-in search chord dispatches through the window-mode gate", () => {
    // The Cmd+Shift+S branch must not toggle the overlay directly: routing
    // through runCommand is what drops it in terminal-only windows (the slim
    // tenant serves no search routes, so the overlay would open dead).
    expect(app).toMatch(
      /if \(searchChord && !builtInChordSuperseded\("app\.search\.toggle"\)\) \{[\s\S]{0,400}runCommand\("app\.search\.toggle", \{\}\);/,
    );
    expect(app).not.toMatch(
      /if \(searchChord && !builtInChordSuperseded\("app\.search\.toggle"\)\) \{[\s\S]{0,400}searchPanel\.open = !searchPanel\.open;/,
    );
  });
});
