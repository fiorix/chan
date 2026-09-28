// @vitest-environment jsdom
//
// The session handover card takes the keyboard when it appears and gives it back
// when it goes, to the element that held it, unless focus has moved on. A
// textarea stands in for the terminal's.

import { flushSync, mount, unmount } from "svelte";
import { afterEach, expect, test } from "vitest";

import SessionHandoverBubble from "./SessionHandoverBubble.svelte";
import { sessionState } from "../state/session.svelte";

let app: Record<string, unknown> | null = null;

afterEach(() => {
  sessionState.handover = null;
  flushSync();
  if (app) unmount(app);
  app = null;
  document.body.replaceChildren();
});

function focused(): HTMLTextAreaElement {
  const terminal = document.createElement("textarea");
  document.body.append(terminal);
  terminal.focus();
  app = mount(SessionHandoverBubble, { target: document.body.appendChild(document.createElement("div")) });
  sessionState.handover = { requestId: "h1", fromWindowId: "w-2", fromName: null, busy: false };
  flushSync();
  expect(document.activeElement, "the card takes the keyboard").toBe(document.querySelector(".hb-card"));
  return terminal;
}

test("gives the keyboard back to the element that held it when the card goes", () => {
  const terminal = focused();

  sessionState.handover = null;
  flushSync();

  expect(document.activeElement, "typing reaches the terminal again").toBe(terminal);
});

test("leaves the keyboard where the user moved it while the card was up", () => {
  focused();
  const other = document.body.appendChild(document.createElement("input"));
  other.focus();

  sessionState.handover = null;
  flushSync();

  expect(document.activeElement).toBe(other);
});
