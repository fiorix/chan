// @vitest-environment jsdom
import { flushSync, mount, unmount, type ComponentProps } from "svelte";
import { afterEach, expect, test, vi } from "vitest";
import { registerModalShell } from "./modalStack";
import Harness from "../__tests__/ModalStackHarness.svelte";
import { focusOrigin, press, recordDocumentKeys, settle } from "../__tests__/dialog";
import { pathPromptState, promptState, tree } from "../state/store.svelte";
import { confirmState } from "../state/confirm.svelte";
import { draftCloseState } from "../state/tabs.svelte";

let harness: ReturnType<typeof render> | undefined;
afterEach(async () => {
  if (harness) await unmount(harness);
  harness = undefined;
  promptState.open = pathPromptState.open = confirmState.open = draftCloseState.open = false;
  await settle();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function render(props: ComponentProps<typeof Harness> = {}) {
  const target = document.createElement("div");
  document.body.append(target);
  const instance = mount(Harness, { target, props });
  harness = instance;
  flushSync();
  return instance;
}
function panel(name: string): HTMLElement {
  const node = document.querySelector<HTMLElement>(`[aria-labelledby="${name}-title"]`);
  expect(node, `mounted ${name} panel`).not.toBeNull();
  return node!;
}
function control(name: string, selector = "input"): HTMLElement {
  return panel(name).querySelector<HTMLElement>(selector)!;
}
function layer(name: string): number {
  return Number(panel(name).parentElement!.style.zIndex);
}
async function open(name: "a" | "b") {
  harness!.show(name);
  await settle();
}

test("assigns later mounts higher layers despite opposite DOM order", async () => {
  render();
  await open("b");
  await open("a");
  expect(panel("a").compareDocumentPosition(panel("b")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(layer("a"), "new instance layer").toBeGreaterThan(layer("b"));
  expect(document.activeElement).toBe(panel("a"));
});

test("uses mount order for simultaneous opens and retains an instance across a collapsed toggle", async () => {
  render();
  harness!.show("a"); harness!.show("b");
  await settle();
  const top = panel("b");
  expect(layer("b"), "simultaneous registration order").toBeGreaterThan(layer("a"));
  harness!.show("a", false); harness!.show("a");
  await settle();
  expect(panel("b")).toBe(top);
  expect(layer("b")).toBeGreaterThan(layer("a"));
});

test("routes Escape from a lower panel to only the current top", async () => {
  const close = vi.fn();
  render({ onClose: close });
  await open("a"); await open("b");
  const reached = recordDocumentKeys();
  try {
    const event = press(control("a"), "Escape");
    expect(close.mock.calls, "top close only").toEqual([["b"]]);
    expect(event.defaultPrevented).toBe(true);
    expect(reached.keys).toEqual([]);
  } finally { reached.stop(); }
});

test("recovers Tab and Escape immediately after focused content is removed", async () => {
  const close = vi.fn();
  render({ onClose: close });
  await open("a");
  control("a").focus(); control("a").remove();
  expect(document.activeElement).toBe(document.body);
  const tab = press(document.body, "Tab");
  expect(document.activeElement, "outside Tab recovery").toBe(control("a", ".first"));
  expect(tab.defaultPrevented).toBe(true);
  control("a", ".first").remove();
  press(document.body, "Escape");
  expect(close, "body Escape routes to top").toHaveBeenCalledExactlyOnceWith("a");
});

test("normalizes a still-active disabled control before backward Tab", async () => {
  render(); await open("a");
  const input = control("a") as HTMLInputElement;
  input.focus(); input.disabled = true;
  expect(document.activeElement).toBe(input);
  const tab = press(input, "Tab", { shiftKey: true });
  expect(document.activeElement, "disabled origin normalized").toBe(control("a", ".last"));
  expect(tab.defaultPrevented).toBe(true);
});

test("repairs removed focused content without waiting for a key", async () => {
  render(); await open("a");
  control("a").focus(); await settle();
  control("a").remove();
  await settle();
  expect(document.activeElement, "child removal repair").toBe(panel("a"));
});

test("repairs disabled and hidden focus without waiting for a key", async () => {
  render(); await open("a");
  const input = control("a") as HTMLInputElement;
  input.focus(); await settle();
  input.disabled = true;
  await settle();
  expect(document.activeElement, "attribute repair").toBe(panel("a"));
  const first = control("a", ".first");
  first.focus(); await settle();
  first.hidden = true;
  await settle();
  expect(document.activeElement).toBe(panel("a"));
});

test("returns escaped focus to the top's last valid control", async () => {
  const outside = focusOrigin();
  render(); await open("a");
  control("a").focus(); outside.focus();
  await settle();
  expect(document.activeElement, "outside focus recovery").toBe(control("a"));
});

test("closing a lower shell does not request focus from the current top", async () => {
  const origin = focusOrigin();
  render(); await open("a");
  control("a").focus(); await open("b"); control("b").focus();
  const restore = vi.spyOn(origin, "focus");
  harness!.show("a", false); await settle();
  expect(document.activeElement, "lower close preserves focus").toBe(control("b"));
  expect(restore, "lower close never restores its opener").not.toHaveBeenCalled();
});

test("closing the top restores its valid opener in the remaining shell", async () => {
  render(); await open("a"); control("a").focus(); await open("b");
  harness!.show("b", false); await settle();
  expect(document.activeElement, "top close restoration").toBe(control("a"));
});

test("closing lower then upper inherits the original external opener", async () => {
  const origin = focusOrigin();
  render(); await open("a"); control("a").focus(); await open("b");
  harness!.show("a", false); await settle();
  harness!.show("b", false); await settle();
  expect(document.activeElement, "inherited valid opener").toBe(origin);
});

test("same-flush close and open invalidate pending restoration", async () => {
  const origin = focusOrigin();
  render(); await open("a");
  const restore = vi.spyOn(origin, "focus");
  harness!.show("a", false); harness!.show("b"); await settle();
  expect(document.activeElement).toBe(panel("b"));
  expect(restore, "stale restore cannot touch the opener").not.toHaveBeenCalled();
});

test("closing all shells in one flush restores the external opener once", async () => {
  const origin = focusOrigin();
  render(); await open("a"); control("a").focus(); await open("b");
  const restore = vi.spyOn(origin, "focus");
  harness!.show("a", false); harness!.show("b", false); await settle();
  expect(document.activeElement).toBe(origin);
  expect(restore, "one final restore").toHaveBeenCalledTimes(1);
});

test("all-close discards a stale upper restoration before the final shell restores", async () => {
  const origin = focusOrigin();
  render(); await open("b");
  // An external caller opens the next shell before deferred containment.
  const other = focusOrigin();
  flushSync(() => harness!.show("a")); await settle();
  const stale = vi.spyOn(other, "focus");
  harness!.show("a", false); harness!.show("b", false); await settle();
  expect(document.activeElement, "final shell owns restoration").toBe(origin);
  expect(stale, "stale upper restore invalidated").not.toHaveBeenCalled();
});

test("skips disconnected and disabled external openers", async () => {
  const origin = focusOrigin();
  render(); await open("a"); origin.remove();
  const restore = vi.spyOn(origin, "focus");
  harness!.show("a", false); await settle();
  expect(restore).not.toHaveBeenCalled();
  document.body.append(origin); origin.focus(); await open("a"); origin.disabled = true;
  harness!.show("a", false); await settle();
  expect(restore, "disabled opener is skipped").toHaveBeenCalledTimes(1);
});

test("preserves focus deliberately moved by a closing caller", async () => {
  const origin = focusOrigin();
  const other = document.createElement("button"); document.body.append(other);
  render({ onClose: () => { flushSync(() => harness!.show("a", false)); other.focus(); } });
  await open("a");
  press(panel("a"), "Escape"); await settle();
  expect(document.activeElement).toBe(other);
  expect(document.activeElement).not.toBe(origin);
});

test("re-reads the top when a focus callback mounts another shell", async () => {
  render(); await open("a");
  control("a").focus(); await open("b");
  control("a").addEventListener("focus", () => flushSync(() => harness!.show("b")), { once: true });
  harness!.show("b", false); await settle();
  expect(document.activeElement, "reentrant new top").toBe(panel("b"));
});

test("a refused close retains key ownership and body Enter is not forwarded", async () => {
  const close = vi.fn(); const key = vi.fn();
  render({ onClose: close, onKeydown: key }); await open("a");
  const reached = recordDocumentKeys();
  try {
    press(document.body, "Escape"); press(document.body, "Escape");
    expect(close, "refusal keeps the same shell active").toHaveBeenCalledTimes(2);
    expect(reached.keys).toEqual([]);
    press(document.body, "Enter");
    expect(key).not.toHaveBeenCalled();
  } finally { reached.stop(); }
});

test("ignores stale repair work and removes document listeners and observers when empty", async () => {
  const add = vi.spyOn(document, "addEventListener");
  const remove = vi.spyOn(document, "removeEventListener");
  const observe = vi.spyOn(MutationObserver.prototype, "observe");
  const disconnect = vi.spyOn(MutationObserver.prototype, "disconnect");
  const close = vi.fn();
  const origin = focusOrigin();
  render({ onClose: close }); await open("a");
  control("a").focus(); control("a").remove();
  flushSync(() => harness!.show("a", false));
  await settle();
  expect(document.activeElement).toBe(origin);
  const listenerTypes = new Set(["keydown", "focusin", "focusout"]);
  const owned = add.mock.calls.filter(([type, , capture]) => listenerTypes.has(type) && capture === true);
  expect(owned.length, "owned document listeners installed").toBe(3);
  for (const [type, listener, capture] of owned) expect(remove, "listener teardown").toHaveBeenCalledWith(type, listener, capture);
  expect(observe, "top panel observation installed").toHaveBeenCalled();
  expect(disconnect, "observer teardown").toHaveBeenCalled();
  press(document.body, "Escape"); expect(close).not.toHaveBeenCalled();
  await open("b"); press(document.body, "Escape");
  expect(close).toHaveBeenCalledExactlyOnceWith("b");
});

test("prompt opened over a draft owns the layer and preserves both callers' focus", async () => {
  render({ callers: true });
  Object.assign(draftCloseState, { open: true, target: "note.md", resolve: () => {} }); await settle();
  const draftInput = control("draft-close"); expect(document.activeElement).toBe(draftInput);
  Object.assign(promptState, { open: true, seq: promptState.seq + 1, defaultValue: "name" }); await settle();
  expect(layer("prompt"), "prompt above draft").toBeGreaterThan(layer("draft-close"));
  expect(document.activeElement).toBe(control("prompt"));
  promptState.open = false; await settle(); expect(document.activeElement).toBe(draftInput);
});

test("queued focus from actual lower callers cannot steal from a newer shell", async () => {
  render({ callers: true });
  tree.loadedDirs = { "": true }; tree.entries = [];
  Object.assign(pathPromptState, { open: true, defaultValue: "note.md", title: "Path" });
  Object.assign(promptState, { open: true, seq: promptState.seq + 1 });
  confirmState.open = true;
  draftCloseState.open = true;
  flushSync();
  const queued = [control("prompt"), control("path-prompt"), control("confirm", ".ok"), control("draft-close")]
    .map((node) => vi.spyOn(node, "focus"));
  harness!.show("a"); flushSync();
  const top = panel("a");
  await settle();
  for (const focus of queued) expect(focus, "actual caller queued its focus").toHaveBeenCalled();
  expect(document.activeElement, "queued caller focus stays under the new top").toBe(top);
});


test("disposing a registration twice restores once and leaves later shells usable", async () => {
  const origin = focusOrigin();
  const layer = document.createElement("div");
  const node = document.createElement("div"); node.tabIndex = -1;
  layer.append(node); document.body.append(layer);
  const close = vi.fn();
  const registration = registerModalShell({ layer, panel: node, opener: origin, onKeydown: close });
  node.focus();
  const restore = vi.spyOn(origin, "focus");
  registration.destroy(); registration.destroy(); layer.remove(); await settle();
  expect(document.activeElement, "idempotent final restore").toBe(origin);
  expect(restore, "one restoration per lifetime").toHaveBeenCalledTimes(1);
  press(document.body, "Escape"); expect(close).not.toHaveBeenCalled();
  render(); await open("a");
  expect(document.activeElement).toBe(panel("a"));
});
