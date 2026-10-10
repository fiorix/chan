// @vitest-environment jsdom

import { afterEach, describe, expect, test } from "vitest";
import { json } from "../../__tests__/fetch";
import { closeSettings, openSettings, settingsPreferences, settleSettings } from "../../__tests__/settings";

const TERMINAL = settingsPreferences().terminal as Record<string, unknown>;

function config(value?: boolean): Record<string, unknown> {
  const preferences = settingsPreferences();
  return value === undefined
    ? preferences
    : { ...preferences, terminal: { ...preferences.terminal, program_status: value } };
}

function row(target: HTMLElement): { toggle: HTMLInputElement; field: HTMLElement } {
  const pill = [...target.querySelectorAll<HTMLLabelElement>("label.pill")].find(
    (candidate) => candidate.textContent?.trim() === "Program status (OSC 7501)",
  )!;
  return { toggle: pill.querySelector("input")!, field: pill.closest<HTMLElement>(".field")! };
}

async function landed(requests: readonly unknown[], count: number): Promise<void> {
  for (let turn = 0; turn < 50 && requests.length < count; turn++) await settleSettings();
  expect(requests.length, "requests sent").toBe(count);
  await settleSettings();
  await settleSettings();
}

describe("Settings > Terminal > Program status", () => {
  afterEach(closeSettings);

  test.each([
    [undefined, true],
    [true, true],
    [false, false],
  ] as const)("reads stored value %s as %s", async (stored, expected) => {
    const { target, writes } = await openSettings("Terminal", config(stored));
    expect(row(target).toggle.checked).toBe(expected);
    expect(writes).toEqual([]);
  });

  test.each([
    [true, false],
    [false, true],
  ] as const)("writes %s to %s with the other terminal settings preserved", async (stored, next) => {
    const { target, writes, requests } = await openSettings("Terminal", config(stored));
    row(target).toggle.click();
    await landed(requests, requests.length + 2);
    expect(writes).toEqual([{ terminal: { ...TERMINAL, program_status: next } }]);
    expect(row(target).toggle.checked).toBe(next);
  });

  test("a refused PATCH leaves the stored choice and shows the refusal", async () => {
    const refused = "preferences.terminal.program_status: refused";
    const { target, writes, requests } = await openSettings("Terminal", config(false), (slice) =>
      (slice.terminal as Record<string, unknown>).program_status === true
        ? json({ error: refused }, { status: 422 })
        : null,
    );
    row(target).toggle.click();
    await landed(requests, requests.length + 3);
    expect(writes).toEqual([{ terminal: { ...TERMINAL, program_status: true } }]);
    expect(row(target).toggle.checked).toBe(false);
    expect(row(target).field.querySelector(".save-error")?.textContent?.trim()).toBe(`Not saved: ${refused}`);
  });
});
