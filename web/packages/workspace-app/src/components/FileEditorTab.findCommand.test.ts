// @vitest-environment jsdom

import { afterEach, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/xterm")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/xterm")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/xterm")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/xterm")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/xterm")).webLinksAddonModule());

import { hostCommand, mountApp, settle, stubAppEnvironment, unmountApp } from "../__tests__/app";
import { fileTab, readTab, resetLayout } from "../__tests__/tabs";

stubAppEnvironment();
afterEach(async () => { await unmountApp(); });

test("the find close command returns focus to the file editor", async () => {
  await mountApp();
  resetLayout([fileTab({ id: "find-doc" })]);
  await settle();
  hostCommand("app.find.open");
  await settle();
  expect(document.activeElement).toBe(document.querySelector(".find-input"));
  expect(readTab("find-doc")?.find?.open).toBe(true);

  hostCommand("app.find.close");
  await settle();

  expect(readTab("find-doc")?.find?.open).toBe(false);
  expect(document.querySelector(".cm-content")!.contains(document.activeElement)).toBe(true);
});
