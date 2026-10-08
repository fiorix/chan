// @vitest-environment jsdom
//
// RequestCard, mounted with a probe body: the keys and buttons that answer a
// request, what the busy flag turns off, and the keyboard the card takes while
// a request is up and gives back when the request goes. A textarea stands in
// for the terminal's.

import { createRawSnippet, flushSync, mount, unmount, type ComponentProps } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";

import RequestCard from "./RequestCard.svelte";

type Props = ComponentProps<typeof RequestCard>;

const body = createRawSnippet(() => ({ render: () => `<strong>someone</strong>` }));

const mounted: Array<Record<string, unknown>> = [];

function render(overrides: Partial<Props> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  const props = $state<Props>({
    label: "Probe request",
    title: "Probe",
    closeLabel: "Cancel probe",
    confirmLabel: "Yes",
    cancelLabel: "No",
    busy: false,
    requestId: "r1",
    onConfirm,
    onCancel,
    children: body,
    ...overrides,
  });
  mounted.push(mount(RequestCard, { target: document.body.appendChild(document.createElement("div")), props }));
  flushSync();
  return { props, onConfirm, onCancel };
}

afterEach(() => {
  for (const card of mounted.splice(0)) unmount(card);
  document.body.replaceChildren();
});

function dialog(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[role="dialog"][aria-label="Probe request"]');
}

// The focusable card inside the dialog.
function cardIn(): HTMLElement | null {
  return dialog()?.querySelector<HTMLElement>('[tabindex="-1"]') ?? null;
}

function button(name: string): HTMLButtonElement {
  const buttons = [...dialog()!.querySelectorAll<HTMLButtonElement>("button")];
  return buttons.find((b) => (b.getAttribute("aria-label") ?? b.textContent) === name)!;
}

// Press `key` on the card and say whether a listener on the document saw it.
function press(key: string): { event: KeyboardEvent; reachedDocument: boolean } {
  const seen = vi.fn();
  document.addEventListener("keydown", seen);
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  cardIn()!.dispatchEvent(event);
  document.removeEventListener("keydown", seen);
  return { event, reachedDocument: seen.mock.calls.length > 0 };
}

describe("RequestCard", () => {
  test("delegated focus leaves the owner's keyboard lifetime alone", () => {
    const terminal = document.body.appendChild(document.createElement("textarea"));
    terminal.focus();
    const { props } = render({ manageFocus: false });
    expect(document.activeElement).toBe(terminal);
    cardIn()!.focus();
    props.requestId = null;
    flushSync();
    expect(document.activeElement).not.toBe(terminal);
  });

  test("shows the owner's title, body and button labels", () => {
    render();
    expect(dialog()!.querySelector("span")?.textContent).toBe("Probe");
    expect(dialog()!.querySelector("p > strong")?.textContent).toBe("someone");
    expect(button("Cancel probe").textContent).toBe("\u00d7");
    expect(button("Yes").disabled).toBe(false);
    expect(button("No").disabled).toBe(false);
  });

  test("Enter confirms once and the key goes no further", () => {
    const { onConfirm, onCancel } = render();
    const { event, reachedDocument } = press("Enter");
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
    expect(reachedDocument).toBe(false);
  });

  test("Escape cancels once and the key goes no further", () => {
    const { onConfirm, onCancel } = render();
    const { event, reachedDocument } = press("Escape");
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
    expect(reachedDocument, "an Escape the card handled closes nothing else").toBe(false);
  });

  test("the buttons answer: confirm confirms, cancel and close cancel", () => {
    const { onConfirm, onCancel } = render();
    button("Yes").click();
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
    button("No").click();
    expect(onCancel).toHaveBeenCalledTimes(1);
    button("Cancel probe").click();
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  test("while busy the three buttons are disabled and the keys answer nothing", () => {
    const { onConfirm, onCancel } = render({ busy: true });
    expect(button("Cancel probe").disabled).toBe(true);
    expect(button("Yes").disabled).toBe(true);
    expect(button("No").disabled).toBe(true);
    press("Enter");
    press("Escape");
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  test("takes the keyboard when a request appears and gives it back when the request goes", () => {
    const terminal = document.body.appendChild(document.createElement("textarea"));
    terminal.focus();
    const { props } = render({ requestId: null });
    expect(dialog(), "no request, no card").toBeNull();
    expect(document.activeElement).toBe(terminal);

    props.requestId = "r1";
    flushSync();
    expect(cardIn()).not.toBeNull();
    expect(document.activeElement, "the card takes the keyboard").toBe(cardIn());

    props.requestId = null;
    flushSync();
    expect(dialog()).toBeNull();
    expect(document.activeElement, "typing reaches the terminal again").toBe(terminal);
  });

  test("a request that replaces another takes the keyboard again", () => {
    const { props } = render();
    const other = document.body.appendChild(document.createElement("input"));
    other.focus();
    expect(document.activeElement).toBe(other);

    props.requestId = "r2";
    flushSync();
    expect(document.activeElement).toBe(cardIn());
  });
});
