// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from "vitest";
import {
  applyEditorFontSize,
  clampEditorFontSize,
  resolvedEditorThemeBodySizePx,
} from "./editorTheme";

const BODY_SIZE = "--chan-editor-body-size";
const SOURCE_SIZE = "--chan-editor-source-size";

afterEach(() => {
  document.documentElement.style.removeProperty(BODY_SIZE);
  document.documentElement.style.removeProperty(SOURCE_SIZE);
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("editor font-size override", () => {
  test("clamps integer pixels and applies the body/source pair", () => {
    expect(clampEditorFontSize(9)).toBe(10);
    expect(clampEditorFontSize(20.4)).toBe(20);
    expect(clampEditorFontSize(99)).toBe(32);

    applyEditorFontSize(20);
    expect(document.documentElement.style.getPropertyValue(BODY_SIZE)).toBe("20px");
    expect(document.documentElement.style.getPropertyValue(SOURCE_SIZE)).toBe("18px");

    applyEditorFontSize(null);
    expect(document.documentElement.style.getPropertyValue(BODY_SIZE)).toBe("");
    expect(document.documentElement.style.getPropertyValue(SOURCE_SIZE)).toBe("");
  });

  test("theme placeholder resolution ignores and restores the user override", () => {
    applyEditorFontSize(20);
    vi.spyOn(globalThis, "getComputedStyle").mockImplementation(() => {
      expect(document.documentElement.style.getPropertyValue(BODY_SIZE)).toBe("");
      return { fontSize: "14.67px" } as CSSStyleDeclaration;
    });

    expect(resolvedEditorThemeBodySizePx()).toBe(14.67);
    expect(document.documentElement.style.getPropertyValue(BODY_SIZE)).toBe("20px");
    expect(document.documentElement.style.getPropertyValue(SOURCE_SIZE)).toBe("18px");
  });

  test("restores inline overrides when theme resolution fails", () => {
    const root = document.documentElement;
    root.style.setProperty(BODY_SIZE, "21px", "important");
    root.style.setProperty(SOURCE_SIZE, "19px", "important");
    const childCount = root.children.length;
    vi.spyOn(globalThis, "getComputedStyle").mockImplementation(() => {
      throw new Error("style probe failed");
    });

    expect(() => resolvedEditorThemeBodySizePx()).toThrow("style probe failed");
    expect(root.children).toHaveLength(childCount);
    expect(root.style.getPropertyValue(BODY_SIZE)).toBe("21px");
    expect(root.style.getPropertyPriority(BODY_SIZE)).toBe("important");
    expect(root.style.getPropertyValue(SOURCE_SIZE)).toBe("19px");
    expect(root.style.getPropertyPriority(SOURCE_SIZE)).toBe("important");
  });
});
