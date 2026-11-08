import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import Harness from "./components/PrivateField.test-harness.svelte";
import { privacy, setPrivacy, privateText } from "./privacy.svelte";

let target: HTMLElement;
let component: ReturnType<typeof mount> | undefined;

beforeEach(async () => {
  const page = (globalThis as unknown as { jsdom: { window: Window } }).jsdom.window;
  Object.defineProperty(window, "localStorage", { value: page.localStorage, configurable: true });
  Object.defineProperty(window, "sessionStorage", { value: page.sessionStorage, configurable: true });
  target = document.createElement("div");
  document.body.append(target);
  await setPrivacy({ enabled: false, mask_terminal_secrets: false });
});
afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  target.remove();
  vi.restoreAllMocks();
});

test("conceals text, input values and hover titles on first render; reveals only one field", async () => {
  await setPrivacy({ enabled: true });
  component = mount(Harness, { target });
  flushSync();
  expect(target.innerHTML).not.toContain("private.example");
  expect(target.querySelector("input")).toBeNull();
  (target.querySelector('[aria-label="Reveal address"]') as HTMLButtonElement).click();
  flushSync();
  expect(target.textContent).toContain("https://private.example");
  expect(target.querySelector("input")).toBeNull();
  expect(privateText("private-token")).toBe("Hidden");

  await unmount(component);
  component = mount(Harness, { target });
  flushSync();
  expect(target.textContent).toContain("https://private.example");
  expect(JSON.parse(window.sessionStorage.getItem("chan.privacy.reveals.v1")!)["test:address"]).toBe(privacy.revision);
  expect(window.sessionStorage.getItem("chan.privacy.reveals.v1")).not.toContain("private.example");

  await setPrivacy({ enabled: false });
  flushSync();
  expect(target.querySelector("input")?.value).toBe("private-token");
  await setPrivacy({ enabled: true });
  flushSync();
  expect(target.innerHTML).not.toContain("private.example");
});

test("persists the preference and follows another page's changes", async () => {
  await setPrivacy({ enabled: true });
  expect(JSON.parse(window.localStorage.getItem("chan.privacy.v1")!).enabled).toBe(true);
  window.localStorage.setItem("chan.privacy.v1", JSON.stringify({ enabled: false, mask_terminal_secrets: true, revision: privacy.revision + 1 }));
  window.dispatchEvent(new StorageEvent("storage", { key: "chan.privacy.v1" }));
  expect(privacy.enabled).toBe(false);
  expect(privacy.mask_terminal_secrets).toBe(true);
});

test("a failed save keeps the current privacy policy and reports the failure", async () => {
  await setPrivacy({ enabled: true });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("full"); });
  await setPrivacy({ enabled: false });
  expect(privacy.enabled).toBe(true);
  expect(privacy.error).toContain("Could not save");
});
