// @vitest-environment jsdom
//
// The secret masking row of Settings > Terminal. It reads what a new terminal
// of this window starts with: the stored choice, or with none stored the
// window's default, on in a control terminal and off in every other window.
// Its toggle stores a choice, and "Use default", offered only while a choice
// is stored, removes it with a write of `null`. The fetch stand-in answers in
// the turn it is asked, so no case waits on a timer.

import { afterEach, describe, expect, test } from "vitest";
import { json } from "../../__tests__/fetch";
import { closeSettings, openSettings, settingsPreferences, settleSettings } from "../../__tests__/settings";
import { ui } from "../../state/store.svelte";

const TERMINAL = settingsPreferences().terminal as Record<string, unknown>;
const startControl = ui.terminalControl;

/// A fresh config, with the masking choice stored when one is given.
function config(choice?: boolean): Record<string, unknown> {
  const preferences = settingsPreferences();
  if (choice === undefined) return preferences;
  return { ...preferences, terminal: { ...preferences.terminal, secret_masking: choice } };
}

function rowParts(target: HTMLElement): { toggle: HTMLInputElement; useDefault: HTMLButtonElement | null; field: HTMLElement } {
  const pill = [...target.querySelectorAll<HTMLLabelElement>("label.pill")].find(
    (candidate) => candidate.textContent?.trim() === "Mask secrets in new terminals",
  )!;
  const field = pill.closest<HTMLElement>(".field")!;
  const useDefault =
    [...field.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Use default",
    ) ?? null;
  return { toggle: pill.querySelector("input")!, useDefault, field };
}

/// What the row shows: its reading, whether "Use default" is offered, and
/// the refusal it reports.
function row(target: HTMLElement): { on: boolean; useDefault: boolean; refusal: string | null } {
  const { toggle, useDefault, field } = rowParts(target);
  return {
    on: toggle.checked,
    useDefault: useDefault !== null,
    refusal: field.querySelector(".save-error")?.textContent?.trim() ?? null,
  };
}

/// Let a write's round trip land: turns of the microtask queue until
/// `requests` has grown to `count`, then the answer and the DOM.
async function landed(requests: readonly unknown[], count: number): Promise<void> {
  for (let turn = 0; turn < 50 && requests.length < count; turn++) await settleSettings();
  expect(requests.length, "requests sent").toBe(count);
  await settleSettings();
  await settleSettings();
}

describe("Settings > Terminal > Secret masking", () => {
  afterEach(() => {
    closeSettings();
    ui.terminalControl = startControl;
  });

  test.each([
    ["a control terminal", true, true],
    ["another window", false, false],
  ] as const)("with no choice stored, in %s the row reads the window's default and offers nothing to clear", async (_window, control, on) => {
    ui.terminalControl = control;
    const { target, writes } = await openSettings("Terminal", config());

    expect(row(target)).toEqual({ on, useDefault: false, refusal: null });
    expect(writes).toEqual([]);
  });

  test.each([
    ["off", "a control terminal", true, false],
    ["on", "a control terminal", true, true],
    ["on", "another window", false, true],
    ["off", "another window", false, false],
  ] as const)("with %s stored, in %s the row reads the choice and offers Use default", async (_choice, _window, control, choice) => {
    ui.terminalControl = control;
    const { target } = await openSettings("Terminal", config(choice));

    expect(row(target)).toEqual({ on: choice, useDefault: true, refusal: null });
  });

  test.each([
    ["a control terminal", true],
    ["another window", false],
  ] as const)("in %s the toggle stores a choice against the window's default, which the row then reads", async (_window, control) => {
    ui.terminalControl = control;
    const { target, writes, requests } = await openSettings("Terminal", config());
    expect(row(target).on, "the window's default").toBe(control);

    rowParts(target).toggle.click();
    await landed(requests, requests.length + 2);

    expect(writes).toEqual([{ terminal: { ...TERMINAL, secret_masking: !control } }]);
    expect(row(target)).toEqual({ on: !control, useDefault: true, refusal: null });
  });

  test.each([
    ["a control terminal", true],
    ["another window", false],
  ] as const)("in %s Use default sends null for the choice, and the row reads the window's default again", async (_window, control) => {
    ui.terminalControl = control;
    const { target, writes, requests } = await openSettings("Terminal", config(!control));
    expect(row(target), "the stored choice").toEqual({ on: !control, useDefault: true, refusal: null });

    rowParts(target).useDefault?.click();
    await landed(requests, requests.length + 2);

    expect(writes).toEqual([{ terminal: { ...TERMINAL, secret_masking: null } }]);
    expect(row(target)).toEqual({ on: control, useDefault: false, refusal: null });
  });

  test("a write of another terminal setting after Use default names no masking choice", async () => {
    ui.terminalControl = true;
    const { target, writes, requests } = await openSettings("Terminal", config(false));
    expect(row(target).useDefault, "Use default is offered").toBe(true);
    rowParts(target).useDefault?.click();
    await landed(requests, requests.length + 2);

    const mcp = [...target.querySelectorAll<HTMLLabelElement>("label.pill")]
      .find((pill) => pill.textContent?.trim() === "Enable in new terminals")!
      .querySelector("input")!;
    mcp.click();
    await landed(requests, requests.length + 2);

    expect(writes.at(-1)).toEqual({ terminal: { ...TERMINAL, mcp_env: true } });
    expect(row(target)).toEqual({ on: true, useDefault: false, refusal: null });
  });

  test("a server that does not take null for the choice leaves the row reading the stored choice and says so", async () => {
    ui.terminalControl = true;
    const refused = "preferences.terminal.secret_masking: invalid type: null, expected a boolean";
    const { target, writes, requests } = await openSettings("Terminal", config(false), (slice) =>
      (slice.terminal as Record<string, unknown>).secret_masking === null
        ? json({ error: refused }, { status: 422 })
        : null,
    );
    expect(row(target).useDefault, "Use default is offered").toBe(true);

    rowParts(target).useDefault?.click();
    // The read before the write, the refused write, and the read that puts
    // the server's value back.
    await landed(requests, requests.length + 3);

    expect(writes).toEqual([{ terminal: { ...TERMINAL, secret_masking: null } }]);
    expect(row(target)).toEqual({ on: false, useDefault: true, refusal: `Not saved: ${refused}` });
  });
});
