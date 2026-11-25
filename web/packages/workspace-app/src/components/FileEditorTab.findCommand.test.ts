// @vitest-environment jsdom

import { afterEach, expect, test } from "vitest";

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
