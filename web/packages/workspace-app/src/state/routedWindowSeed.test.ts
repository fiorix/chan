import { describe, expect, test } from "vitest";
import store from "./store.svelte.ts?raw";
import app from "../App.svelte?raw";

// A window minted BY a routed `cs open` must not seed itself with a default
// terminal: the tab it is about to be handed IS its content. Everything else,
// including `cs window new`, keeps seeding one, because that is what those
// mean.
//
// The delivery this depends on is take-once and unacknowledged -- `ws.rs`
// removes every parked frame from the map before sending any of them -- so the
// window also needs a way back if nothing arrives.
describe("routed standalone window seeding", () => {
  test("a seed=0 window does not open the default terminal", () => {
    expect(store).toMatch(
      /if \(!hasAnyTab\(\) && !mintedWithoutSeed\(\)\) \{\s*\n\s*openTerminalInActivePane\(\{\}\);/,
    );
    // Read from the URL, like `kind` and `lib`, so it is answerable before any
    // request completes.
    expect(store).toMatch(
      /searchParams\.get\("seed"\) === "0"/,
    );
  });

  test("the routed browser window is minted with the same marker", () => {
    // The desktop watcher appends `seed=0` from the host's routed-mint mark;
    // the browser path mints its own URL and must agree.
    expect(store).toMatch(/url\.searchParams\.set\("seed", "0"\)/);
  });

  test("a seed=0 window falls back to a terminal if nothing arrives", () => {
    // Without this a lost frame leaves a window that is empty AND cannot close
    // itself, because arming waits for a first tab.
    expect(store).toMatch(/const ROUTED_SEED_FALLBACK_MS = /);
    expect(store).toMatch(
      /if \(mintedWithoutSeed\(\)\) \{[\s\S]{0,200}if \(!hasAnyTab\(\)\) openTerminalInActivePane\(\{\}\);[\s\S]{0,80}ROUTED_SEED_FALLBACK_MS/,
    );
  });

  test("close-when-empty arms on the first tab of any kind", () => {
    // Not at the end of bootstrap: a seed=0 window boots with no tab, and
    // arming there would let it close itself -- reaping its own session blob --
    // before its content arrived.
    expect(app).toMatch(
      /if \(windowCaps\.workspace \|\| ui\.terminalArmed\) return;\s*\n\s*if \(hasAnyTab\(\)\) ui\.terminalArmed = true;/,
    );
    // And bootstrap no longer arms unconditionally.
    expect(store).not.toMatch(/ui\.terminalArmed = true;/);
  });

  test("workspace windows are untouched by any of it", () => {
    // Both effects bail on a workspace window before doing anything, so this
    // whole mechanism is standalone-only.
    const guards = app.match(/if \(windowCaps\.workspace[ |)]/g);
    expect(guards?.length).toBeGreaterThanOrEqual(2);
  });
});
