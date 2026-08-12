// @vitest-environment jsdom

import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, test } from "vitest";
import shortcuts from "./shortcuts.ts?raw";
import app from "../App.svelte?raw";
import screenLock from "../components/settings/workspace/ScreenLockControl.svelte?raw";
import numberField from "../components/settings/NumberField.svelte?raw";
import NumberField from "../components/settings/NumberField.svelte";
import {
  SCREENSAVER_MAX_TIMEOUT_SECS,
  SCREENSAVER_MIN_TIMEOUT_SECS,
} from "./screensaver";

// Screensaver settings UI + Hybrid Nav lock chord. Tests pin the ownership:
// Screen Lock + Screensaver controls live in Settings > This workspace, in
// settings/workspace/ScreenLockControl.svelte.

describe("Hybrid Nav lock chord", () => {
  test("screen lock has no built-in chord in the registry (no-defaults)", () => {
    // The Mod+. L default was dropped in the no-defaults round. Screen lock
    // stays reachable through the Settings workspace tab and the launcher, and
    // is assignable in the config UI, so no app.screensaver.lock entry remains
    // in SHORTCUTS. Plain Mod+L is likewise never claimed.
    expect(shortcuts).not.toContain('id: "app.screensaver.lock"');
    expect(shortcuts).not.toMatch(/web: "Mod\+L"[\s\S]{1,80}native: "Mod\+L"/);
  });

  test("App.svelte runCommand branch routes app.screensaver.lock through lockNow", () => {
    expect(app).toMatch(
      /case "app\.screensaver\.lock":[\s\S]{1,60}lockNow\(\);/,
    );
  });

  test("App.svelte does not claim plain Mod+L", () => {
    expect(app).not.toMatch(/e\.code === "KeyL"[\s\S]{1,160}lockNow\(\);/);
  });

  test("App.svelte no longer binds a Hybrid Nav L handler", () => {
    // The no-defaults round dropped the Mod+. L screen-lock binding; lock is
    // reached via the app.screensaver.lock command and the launcher.
    expect(app).not.toMatch(/case "l":[\s\S]{1,40}case "L":[\s\S]{1,220}lockNow\(\);/);
  });

  test("App.svelte imports lockNow alongside the tracker + loader", () => {
    expect(app).toMatch(
      /import \{[\s\S]{1,400}lockNow,[\s\S]{1,200}\} from "\.\/state\/screensaver\.svelte";/,
    );
  });
});

describe("Screen lock + Screensaver UI in Settings workspace tab", () => {
  test("ScreenLockControl imports hashPin + bounds + lock helpers", () => {
    expect(screenLock).toMatch(
      /import \{[\s\S]{1,400}hashPin,[\s\S]{1,200}SCREENSAVER_MAX_TIMEOUT_SECS,[\s\S]{1,80}SCREENSAVER_MIN_TIMEOUT_SECS,[\s\S]{1,40}\} from "\.\.\/\.\.\/\.\.\/state\/screensaver";/,
    );
    expect(screenLock).toMatch(
      /import \{[\s\S]{1,200}loadScreensaverState,[\s\S]{1,80}lockNow,[\s\S]{1,80}screensaver,[\s\S]{1,40}\} from "\.\.\/\.\.\/\.\.\/state\/screensaver\.svelte";/,
    );
  });

  test("ScreenLockControl carries the screensaver-settings reactive state vars", () => {
    expect(screenLock).toMatch(
      /let screensaverEnabled = \$state<boolean \| null>\(null\);/,
    );
    expect(screenLock).toMatch(/let screensaverTimeoutSecs = \$state<number>\(300\);/);
    expect(screenLock).toMatch(/let screensaverTheme = \$state<ScreensaverTheme>\("plain"\);/);
    expect(screenLock).toMatch(/let screensaverPinSet = \$state\(false\);/);
    expect(screenLock).toMatch(/let screensaverBusy = \$state\(false\);/);
    expect(screenLock).toMatch(/let screensaverError = \$state<string \| null>\(null\);/);
    expect(screenLock).toMatch(
      /let pinDialog = \$state<\{ pin1: string; pin2: string \} \| null>\(null\);/,
    );
  });

  test("loadScreenLockState fetches screensaver state via api.screensaverState", () => {
    expect(screenLock).toMatch(
      /const s = await api\.screensaverState\(\);[\s\S]{1,200}screensaverEnabled = s\.enabled;[\s\S]{1,200}screensaverTimeoutSecs = s\.timeout_secs;[\s\S]{1,200}screensaverTheme = s\.theme;[\s\S]{1,200}screensaverPinSet = s\.pin_set;/,
    );
  });

  test("theme picker persists plain/matrix through screensaverPatch", () => {
    expect(screenLock).toMatch(/type ScreensaverTheme/);
    expect(screenLock).toMatch(
      /async function commitScreensaverTheme\(e: Event\): Promise<void> \{[\s\S]{1,700}api\.screensaverPatch\(\{ theme \}\);[\s\S]{1,300}await loadScreensaverState\(\);/,
    );
    expect(screenLock).toMatch(
      /<select[\s\S]{1,300}bind:value=\{screensaverTheme\}[\s\S]{1,200}onchange=\{commitScreensaverTheme\}[\s\S]{1,300}<option value="plain">Default<\/option>[\s\S]{1,120}<option value="matrix">Matrix<\/option>/,
    );
  });

  test("Test button reloads state and locks immediately (no overlay open/close dance)", () => {
    // The Settings overlay survives the screensaver cover, so testScreenLock
    // simply reloads state + calls lockNow. No returnToSettingsAfterTest.
    expect(screenLock).toMatch(
      /async function testScreenLock\(\): Promise<void> \{[\s\S]{1,400}await loadScreensaverState\(\);[\s\S]{1,200}if \(!screensaver\.loaded\) \{[\s\S]{1,200}screen lock state unavailable[\s\S]{1,200}lockNow\(\);/,
    );
    expect(screenLock).not.toMatch(/returnToSettingsAfterTest/);
    expect(screenLock).toMatch(
      /<button type="button" onclick=\{testScreenLock\} disabled=\{screensaverBusy\}>[\s\S]{1,80}Test[\s\S]{1,80}<\/button>/,
    );
  });

  test("toggle handler patches enabled + reloads singleton", () => {
    expect(screenLock).toMatch(
      /async function toggleScreensaverEnabled\(\): Promise<void> \{[\s\S]{1,600}api\.screensaverPatch\(\{ enabled: target \}\);[\s\S]{1,400}await loadScreensaverState\(\);/,
    );
  });

  test("commit timeout clamps to MIN/MAX + patches + reloads", () => {
    // The clamp mechanics live in the NumberField primitive, fed the
    // same bounds; the handler keeps the clamp-then-save-with-message
    // policy and the reload.
    expect(screenLock).toMatch(/min=\{SCREENSAVER_MIN_TIMEOUT_SECS\}/);
    expect(screenLock).toMatch(/max=\{SCREENSAVER_MAX_TIMEOUT_SECS\}/);
    expect(screenLock).toMatch(
      /async function commitTimeout\([\s\S]{1,200}clampedTo[\s\S]{1,800}SCREENSAVER_MIN_TIMEOUT_SECS[\s\S]{1,400}SCREENSAVER_MAX_TIMEOUT_SECS[\s\S]{1,400}api\.screensaverPatch\(\{ timeout_secs: next \}\);[\s\S]{1,400}await loadScreensaverState\(\);/,
    );
  });

  test("clamp onto the stored timeout warns without a redundant patch", () => {
    // NumberField reports a clamp even when the clamped number equals
    // the committed value, and commitTimeout raises the warning before
    // its unchanged-value guard, so an out-of-range entry at the bound
    // shows the message while the PATCH is skipped.
    expect(numberField).toMatch(/if \(n === value && clampedTo === null\) return;/);
    expect(screenLock).toMatch(
      /Timeout must be at most[\s\S]{1,400}if \(next === screensaverTimeoutSecs\) return;[\s\S]{1,400}api\.screensaverPatch\(\{ timeout_secs: next \}\);/,
    );
  });

  test("commit PIN validates match + hashes with workspace root salt + posts", () => {
    expect(screenLock).toMatch(
      /async function commitPin\(\): Promise<void> \{[\s\S]{1,600}if \(pin1 !== pin2\) \{[\s\S]{1,200}screensaverError = "PINs don't match";[\s\S]{1,400}const salt = workspace\.info\?\.root \?\? "";[\s\S]{1,200}const hash = await hashPin\(pin1, salt\);[\s\S]{1,200}api\.screensaverSetPin\(hash\);[\s\S]{1,400}await loadScreensaverState\(\);/,
    );
  });

  test("clearPin calls screensaverClearPin + reloads", () => {
    expect(screenLock).toMatch(
      /async function clearPin\(\): Promise<void> \{[\s\S]{1,400}api\.screensaverClearPin\(\);[\s\S]{1,400}await loadScreensaverState\(\);/,
    );
  });

  test("markup renders the screen-lock row with the enable toggle", () => {
    expect(screenLock).toMatch(/<SettingField[\s\S]{1,120}label="Screen lock"/);
    expect(screenLock).toMatch(/<PillToggle[\s\S]{1,400}toggleScreensaverEnabled/);
  });

  test("timeout input + PIN buttons gated on enabled=true", () => {
    expect(screenLock).toMatch(
      /\{#if screensaverEnabled === true\}[\s\S]{1,4000}<NumberField/,
    );
    expect(screenLock).toMatch(/onclick=\{openPinDialog\}/);
    expect(screenLock).toMatch(/onclick=\{clearPin\}/);
  });

  test("Theme picker renders INSIDE the screen lock enabled gate", () => {
    // The screensaver theme picker must live inside the
    // `{#if screensaverEnabled === true}` block of the Screen lock
    // SettingField, not as a standalone section sibling. Toggling
    // Screen lock OFF hides the theme picker and timeout/PIN controls
    // together.
    expect(screenLock).toMatch(
      /<SettingField[\s\S]{1,200}label="Screen lock"[\s\S]{1,4000}\{#if screensaverEnabled === true\}[\s\S]{1,4000}bind:value=\{screensaverTheme\}[\s\S]{1,4000}\{\/if\}[\s\S]{1,200}<\/SettingField>/,
    );
    expect(screenLock).not.toMatch(/<section class="screensaver">/);
    expect(screenLock).not.toMatch(/<h3>Screensaver<\/h3>/);
  });

  test("inline PIN dialog binds pin1/pin2 + wires save+cancel", () => {
    expect(screenLock).toMatch(
      /\{#if pinDialog === null\}[\s\S]{1,4000}\{:else\}[\s\S]{1,2000}bind:value=\{pinDialog\.pin1\}[\s\S]{1,400}bind:value=\{pinDialog\.pin2\}[\s\S]{1,400}onclick=\{commitPin\}[\s\S]{1,200}onclick=\{cancelPinDialog\}/,
    );
  });
});

// The timeout field mounted with the screensaver bounds. The commit
// contract commitTimeout relies on: an out-of-range entry clamps back
// onto the stored bound yet still fires with the bound named, so the
// handler can show its warning and skip the write itself.
describe("NumberField timeout clamp at the stored bound", () => {
  let target: HTMLDivElement;
  let cleanups: (() => void)[] = [];

  afterEach(() => {
    for (const cleanup of cleanups) cleanup();
    cleanups = [];
    target?.remove();
  });

  function mountTimeoutField(value: number): [number | null, string | null][] {
    const commits: [number | null, string | null][] = [];
    target = document.createElement("div");
    document.body.appendChild(target);
    const cmp = mount(NumberField, {
      target,
      props: {
        value,
        min: SCREENSAVER_MIN_TIMEOUT_SECS,
        max: SCREENSAVER_MAX_TIMEOUT_SECS,
        ariaLabel: "Inactivity timeout in seconds",
        oncommit: (v: number | null, c: string | null) => commits.push([v, c]),
      },
    });
    cleanups.push(() => unmount(cmp));
    return commits;
  }

  function enterAndBlur(text: string): HTMLInputElement {
    const input = target.querySelector("input") as HTMLInputElement;
    input.value = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
    return input;
  }

  test("out-of-range entry with the stored value at the min still reports the clamp", async () => {
    const commits = mountTimeoutField(SCREENSAVER_MIN_TIMEOUT_SECS);
    await tick();
    const input = enterAndBlur(String(SCREENSAVER_MIN_TIMEOUT_SECS - 5));
    await tick();
    expect(commits).toEqual([[SCREENSAVER_MIN_TIMEOUT_SECS, "min"]]);
    expect(input.value).toBe(String(SCREENSAVER_MIN_TIMEOUT_SECS));
  });

  test("cleared field with the stored value at the min still reports the clamp", async () => {
    // Not nullable and no invalidFallback: empty text falls back onto
    // the min bound and is reported as a min clamp.
    const commits = mountTimeoutField(SCREENSAVER_MIN_TIMEOUT_SECS);
    await tick();
    enterAndBlur("");
    await tick();
    expect(commits).toEqual([[SCREENSAVER_MIN_TIMEOUT_SECS, "min"]]);
  });

  test("re-entering the stored in-range value commits nothing", async () => {
    const commits = mountTimeoutField(300);
    await tick();
    enterAndBlur("300");
    await tick();
    expect(commits).toEqual([]);
  });
});
