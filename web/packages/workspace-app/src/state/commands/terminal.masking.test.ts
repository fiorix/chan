// @vitest-environment jsdom
//
// Secret masking (this terminal) as a catalog toggle. Whether a terminal
// masks is held on its tab: its own choice, seeded as its shell spawns, the
// mark its masker leaves when it fails, and Privacy mode's override over
// both. The command reports that state for the focused terminal and flips
// the terminal's own choice.

import { afterEach, describe, expect, test } from "vitest";

import { privacy } from "@chan/web-shared/privacy";
import { resetLayout, terminalTab } from "../../__tests__/tabs";
import { allCommands, commandState, type Command } from "../commands";
import { ui } from "../store.svelte";
import {
  closeTab,
  failTerminalSecretMasking,
  layout,
  reopenClosedTab,
  seedTerminalSecretMasking,
  selectTabInPane,
  terminalSecretMaskingOn,
  type LeafNode,
  type TerminalTab,
} from "../tabs.svelte";
import "./install";

const MASKING = "app.terminal.secretMasking.toggle";

function masking(): Command {
  const found = allCommands().find((candidate) => candidate.id === MASKING);
  if (!found) throw new Error(`no command ${MASKING}`);
  return found;
}

const PANE = "terminal-masking-pane";

function seat(tabs: TerminalTab[]): TerminalTab[] {
  return resetLayout(tabs, { id: PANE }).tabs as TerminalTab[];
}

afterEach(() => {
  privacy.enabled = false;
  privacy.mask_terminal_secrets = false;
  resetLayout();
});

describe("Secret masking (this terminal)", () => {
  test("is a toggle that reports the focused terminal's masking", () => {
    expect(masking()).toMatchObject({
      title: "Secret masking (this terminal)",
      category: "Terminal",
      scope: "app",
      surface: "terminal",
      kind: "toggle",
    });
    const [first, second] = seat([terminalTab({ id: "first" }), terminalTab({ id: "second" })]);
    expect(commandState(MASKING), "a terminal nothing seeded masks nothing").toBe(false);

    seedTerminalSecretMasking(first!, true);
    expect(commandState(MASKING)).toBe(true);
    selectTabInPane(PANE, second!.id);
    expect(commandState(MASKING), "the other terminal keeps its own choice").toBe(false);
  });

  test("reports nothing with no terminal focused", () => {
    resetLayout();
    expect(commandState(MASKING)).toBeNull();
  });

  test("flips the terminal's own choice and says so", () => {
    const [tab] = seat([terminalTab()]);
    seedTerminalSecretMasking(tab!, false);

    masking().run();
    expect([tab!.secretMasking, commandState(MASKING), ui.status]).toEqual([
      true,
      true,
      "Secret masking enabled for this terminal",
    ]);

    masking().run();
    expect([tab!.secretMasking, commandState(MASKING), ui.status]).toEqual([
      false,
      false,
      "Secret masking disabled for this terminal",
    ]);
  });

  test("Privacy mode holds masking on over the terminal's choice, and the toggle leaves the choice alone", () => {
    const [tab] = seat([terminalTab()]);
    seedTerminalSecretMasking(tab!, false);
    privacy.enabled = true;
    expect(commandState(MASKING), "Privacy mode alone does not mask terminals").toBe(false);
    privacy.mask_terminal_secrets = true;
    expect(commandState(MASKING)).toBe(true);

    masking().run();
    expect([tab!.secretMasking, commandState(MASKING), ui.status]).toEqual([
      false,
      true,
      "Secret masking is enabled by Privacy mode",
    ]);

    privacy.enabled = false;
    expect(commandState(MASKING)).toBe(false);
  });

  test("a masker that failed leaves masking off whatever asks for it, until the toggle tries again", () => {
    const [tab] = seat([terminalTab()]);
    seedTerminalSecretMasking(tab!, true);
    failTerminalSecretMasking(tab!);
    expect([tab!.secretMasking, terminalSecretMaskingOn(tab!)]).toEqual([false, false]);

    privacy.enabled = true;
    privacy.mask_terminal_secrets = true;
    expect(commandState(MASKING), "not even Privacy mode's override").toBe(false);

    masking().run();
    expect([tab!.secretMasking, tab!.secretMaskingFailed, commandState(MASKING)]).toEqual([true, false, true]);
  });

  test("a closed terminal reopens without its choice or its failure, for its new shell to seed", async () => {
    const [tab] = seat([terminalTab()]);
    tab!.secretMasking = true;
    tab!.secretMaskingFailed = true;

    await closeTab(PANE, tab!.id, { force: true });
    expect(reopenClosedTab()).toBe(true);
    const reopened = (layout.nodes[PANE] as LeafNode).tabs[0] as TerminalTab;
    expect(reopened.kind).toBe("terminal");
    expect([reopened.secretMasking, reopened.secretMaskingFailed]).toEqual([undefined, undefined]);
  });
});
