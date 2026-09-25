import { describe, expect, test } from "vitest";
import source from "./screensaver.svelte.ts?raw";
import overlay from "../components/ScreensaverOverlay.svelte?raw";

// When the workspace has no PIN set, any keypress or click on
// the screensaver backdrop dismisses the lock. The helper
// text already promises this; unlockWithoutPin makes the
// mechanism match the text.

describe("no-PIN unlock: state machine helper", () => {
  test("unlockWithoutPin is exported", () => {
    expect(source).toMatch(/export function unlockWithoutPin\(\): void \{/);
  });

  test("unlockWithoutPin short-circuits when pin_set is true", () => {
    expect(source).toMatch(
      /export function unlockWithoutPin\(\): void \{[\s\S]{1,200}if \(screensaver\.pin_set\) return;/,
    );
  });

  test("unlockWithoutPin flips locked + rearms timer", () => {
    expect(source).toMatch(
      /export function unlockWithoutPin\(\): void \{[\s\S]{1,400}screensaver\.locked = false;[\s\S]{1,80}armInactivityTimer\(\);/,
    );
  });
});

describe("no-PIN unlock: overlay branching", () => {
  test("overlay imports unlockWithoutPin", () => {
    expect(overlay).toMatch(
      /import \{[\s\S]{1,200}unlockWithoutPin,[\s\S]{1,80}\} from "\.\.\/state\/screensaver\.svelte";/,
    );
  });

  test("onBackdropKey wakes first, then guards on pin_set + calls unlockWithoutPin", () => {
    expect(overlay).toMatch(
      /function onBackdropKey\(e: KeyboardEvent\): void \{[\s\S]{1,200}if \(!cardVisible\) \{[\s\S]{1,120}cardVisible = true;[\s\S]{1,400}if \(screensaver\.pin_set\) return;[\s\S]{1,200}unlockWithoutPin\(\);/,
    );
  });

  test("onBackdropPointer wakes first, then guards on pin_set + calls unlockWithoutPin", () => {
    expect(overlay).toMatch(
      /function onBackdropPointer\(\): void \{[\s\S]{1,200}if \(!cardVisible\) \{[\s\S]{1,120}cardVisible = true;[\s\S]{1,400}if \(screensaver\.pin_set\) return;[\s\S]{1,200}unlockWithoutPin\(\);/,
    );
  });

  test("backdrop wires onkeydown + onclick for any-input dismiss", () => {
    expect(overlay).toMatch(/onkeydown=\{onBackdropKey\}/);
    expect(overlay).toMatch(/onclick=\{onBackdropPointer\}/);
  });

  test("markup branches on screensaver.pin_set inside the locked block", () => {
    expect(overlay).toMatch(
      /\{#if screensaver\.locked\}[\s\S]{1,1200}\{#if cardVisible\}[\s\S]{1,800}\{#if screensaver\.pin_set\}[\s\S]{1,4000}\{:else\}[\s\S]{1,800}No PIN set on this workspace\. Press any key or click to[\s\S]{1,40}unlock\./,
    );
  });

  test("no-PIN branch does NOT render the PIN input", () => {
    // Pinning the structure: the password input + Unlock
    // button live inside the `pin_set === true` arm only.
    expect(overlay).toMatch(
      /\{#if screensaver\.pin_set\}[\s\S]{1,4000}<input[\s\S]{1,400}type="password"[\s\S]{1,4000}\{:else\}/,
    );
  });
});
