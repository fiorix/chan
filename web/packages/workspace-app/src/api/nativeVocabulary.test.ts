import { afterEach, describe, expect, test, vi } from "vitest";

import {
  hostVocabulary,
  isAclRefusal,
  resetHostVocabularyForTests,
} from "./nativeVocabulary";

type W = Window & typeof globalThis & { __TAURI_INTERNALS__?: unknown };

function asDesktop(invoke: (cmd: string, args?: unknown) => Promise<unknown>): void {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    value: { invoke },
    configurable: true,
  });
}

afterEach(() => {
  delete (window as W).__TAURI_INTERNALS__;
  vi.restoreAllMocks();
  resetHostVocabularyForTests();
});

describe("isAclRefusal", () => {
  test("recognises every Tauri rejection form for the named command", () => {
    expect(isAclRefusal("create_library_window", "Command create_library_window not allowed by ACL")).toBe(true);
    expect(isAclRefusal("create_library_window", "create_library_window not allowed. Command not found")).toBe(true);
    expect(
      isAclRefusal(
        "create_library_window",
        "create_library_window explicitly denied on origin https://a--b.c.usr.example",
      ),
    ).toBe(true);
  });

  test("needs both the command name and the refusal wording", () => {
    // A handler's own failure can carry either half; only both mean the ACL
    // rejected the invoke before the handler ran.
    expect(isAclRefusal("create_library_window", "create_library_window timed out")).toBe(false);
    expect(isAclRefusal("create_library_window", 'picked file name is not allowed: ".."')).toBe(false);
  });
});

describe("hostVocabulary", () => {
  test("is null outside a Tauri webview", async () => {
    expect(await hostVocabulary()).toBeNull();
  });

  test("returns the advertised commands as a set", async () => {
    asDesktop(async () => ({
      version: "0.86.0",
      build: "0123abcd4567",
      commands: ["create_library_window", "focus_library_window"],
    }));

    const vocabulary = await hostVocabulary();

    expect(vocabulary?.has("create_library_window")).toBe(true);
    expect(vocabulary?.has("read_dropped_paths")).toBe(false);
  });

  test("an app that cannot answer, or answers garbage, yields null", async () => {
    // An app old enough to lack a command is also old enough to lack this
    // query, so null means "interpret the refusal", never "nothing granted".
    asDesktop(async () => {
      throw new Error("Command native_vocabulary not allowed by ACL");
    });
    expect(await hostVocabulary()).toBeNull();

    asDesktop(async () => null);
    expect(await hostVocabulary()).toBeNull();

    asDesktop(async () => ({ version: "0.86.0", build: "x", commands: "nope" }));
    expect(await hostVocabulary()).toBeNull();
  });
});
