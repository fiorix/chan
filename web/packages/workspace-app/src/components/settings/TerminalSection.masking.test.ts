// @vitest-environment jsdom
//
// The secret masking row of Settings > Terminal: a choice of On, Off and
// Default. It reads the stored choice, and Default while none is stored,
// whatever kind of window shows it. On and Off store a choice; Default
// removes it with a write of `null`. The fetch stand-in answers in the turn
// it is asked, so no case waits on a timer.

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

function field(target: HTMLElement): HTMLElement {
  return target.querySelector<HTMLElement>('[role="radiogroup"][aria-label="Secret masking"]')!.closest<HTMLElement>(
    ".field",
  )!;
}

function options(target: HTMLElement): HTMLInputElement[] {
  return [...field(target).querySelectorAll<HTMLInputElement>('[role="radiogroup"] input[type="radio"]')];
}

/// The pill of the option worded `word`.
function option(target: HTMLElement, word: string): HTMLInputElement {
  return options(target).find((input) => input.closest("label")?.textContent?.trim() === word)!;
}

/// What the row shows: the options in order, the one it holds, and the
/// refusal it reports.
function row(target: HTMLElement): { options: string[]; held: string[]; refusal: string | null } {
  const word = (input: HTMLInputElement): string => input.closest("label")?.textContent?.trim() ?? "";
  return {
    options: options(target).map(word),
    held: options(target)
      .filter((input) => input.checked)
      .map(word),
    refusal: field(target).querySelector(".save-error")?.textContent?.trim() ?? null,
  };
}

function holds(word: string, refusal: string | null = null): ReturnType<typeof row> {
  return { options: ["On", "Off", "Default"], held: [word], refusal };
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
    ["a control terminal", true],
    ["another window", false],
  ] as const)("with no choice stored, in %s the row holds Default and writes nothing", async (_window, control) => {
    ui.terminalControl = control;
    const { target, writes } = await openSettings("Terminal", config());

    expect(row(target)).toEqual(holds("Default"));
    expect(writes).toEqual([]);
  });

  test.each([
    ["Off", "a control terminal", true, false],
    ["On", "a control terminal", true, true],
    ["On", "another window", false, true],
    ["Off", "another window", false, false],
  ] as const)("with %s stored, in %s the row holds the choice", async (word, _window, control, choice) => {
    ui.terminalControl = control;
    const { target } = await openSettings("Terminal", config(choice));

    expect(row(target)).toEqual(holds(word));
  });

  test.each([
    ["On", true],
    ["Off", false],
  ] as const)("%s stores the choice, which the row then holds", async (word, choice) => {
    const { target, writes, requests } = await openSettings("Terminal", config());

    option(target, word).click();
    await landed(requests, requests.length + 2);

    expect(writes).toEqual([{ terminal: { ...TERMINAL, secret_masking: choice } }]);
    expect(row(target)).toEqual(holds(word));
  });

  test.each([
    ["On", true],
    ["Off", false],
  ] as const)("with %s stored, Default sends null for the choice, and the row holds Default", async (word, choice) => {
    const { target, writes, requests } = await openSettings("Terminal", config(choice));
    expect(row(target), "the stored choice").toEqual(holds(word));

    option(target, "Default").click();
    await landed(requests, requests.length + 2);

    expect(writes).toEqual([{ terminal: { ...TERMINAL, secret_masking: null } }]);
    expect(row(target)).toEqual(holds("Default"));
  });

  test("a write of another terminal setting after Default names no masking choice", async () => {
    const { target, writes, requests } = await openSettings("Terminal", config(false));
    option(target, "Default").click();
    await landed(requests, requests.length + 2);

    const mcp = [...target.querySelectorAll<HTMLLabelElement>("label.pill")]
      .find((pill) => pill.textContent?.trim() === "Enable in new terminals")!
      .querySelector("input")!;
    mcp.click();
    await landed(requests, requests.length + 2);

    expect(writes.at(-1)).toEqual({ terminal: { ...TERMINAL, mcp_env: true } });
    expect(row(target)).toEqual(holds("Default"));
  });

  test("a server that does not take null for the choice leaves the row holding the stored choice and says so", async () => {
    const refused = "preferences.terminal.secret_masking: invalid type: null, expected a boolean";
    const { target, writes, requests } = await openSettings("Terminal", config(false), (slice) =>
      (slice.terminal as Record<string, unknown>).secret_masking === null
        ? json({ error: refused }, { status: 422 })
        : null,
    );
    expect(row(target)).toEqual(holds("Off"));

    option(target, "Default").click();
    // The read before the write, the refused write, and the read that puts
    // the server's value back.
    await landed(requests, requests.length + 3);

    expect(writes).toEqual([{ terminal: { ...TERMINAL, secret_masking: null } }]);
    expect(row(target)).toEqual(holds("Off", `Not saved: ${refused}`));
  });
});
