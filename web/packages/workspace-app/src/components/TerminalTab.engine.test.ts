// @vitest-environment jsdom
//
// Every terminal opens on Ghostty, whatever the served preferences say of
// the retired engine key: a payload that still carries `ghostty` false or
// true, as a server or a stored record from before its retirement could,
// opens the same widget as one without it. A TerminalTab is mounted through
// the shared fixture, whose loader serves the vendored core, and the
// terminal it opens is read back: the widget, and no xterm.js.

import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("../terminal/backend", async (importOriginal) =>
  (await import("../__tests__/ghosttyTab")).ghosttyBackendModule(importOriginal));

import TerminalTab from "./TerminalTab.svelte";
import type { TerminalPreferences } from "../api/types";
import { __testSetStandalonePreferences } from "../state/store.svelte";
import { ghosttyFixture } from "../__tests__/ghosttyTab";
import { terminalPreferences } from "../__tests__/standalone";
import {
  installTerminalDom,
  mountTerminal,
  resetTerminals,
  seatTerminals,
  terminalTab,
  xterm,
} from "../__tests__/terminalTab";

installTerminalDom();

afterEach(() => {
  resetTerminals();
  __testSetStandalonePreferences(null);
});

/// The terminal block as a payload carrying the retired key would hold it;
/// the key is no longer part of the type.
function servedEngineKey(value: boolean | undefined): Partial<TerminalPreferences> {
  return (value === undefined ? {} : { ghostty: value }) as Partial<TerminalPreferences>;
}

describe("the engine of a terminal", () => {
  test.each([
    ["false", "a new terminal", false, undefined],
    ["absent", "a new terminal", undefined, undefined],
    ["true", "a new terminal", true, undefined],
    ["false", "a restored terminal", false, "sess-1"],
    ["absent", "a restored terminal", undefined, "sess-1"],
    ["true", "a restored terminal", true, "sess-1"],
  ] as const)("served ghostty %s: %s opens on the widget", async (_label, _which, value, sessionId) => {
    __testSetStandalonePreferences(terminalPreferences(servedEngineKey(value)));
    const [tab] = seatTerminals([terminalTab(sessionId ? { terminalSessionId: sessionId } : {})]);

    await mountTerminal(TerminalTab, tab!);

    await vi.waitFor(() => expect(ghosttyFixture.terminals).toHaveLength(1));
    expect(xterm.terminals).toHaveLength(0);
  });
});
