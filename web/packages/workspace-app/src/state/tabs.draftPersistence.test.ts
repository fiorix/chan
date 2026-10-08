// A draft's path in a saved layout. The layout is written to the session
// blob, the reload snapshot and the location hash, and is read back from
// each; a person can write the hash by hand. So the saved form is the
// server's path with the lifetime id beside it, never the marked client
// string, and a marked string where a workspace path belongs is refused.

import { afterEach, describe, expect, test, vi } from "vitest";

import { api } from "../api/client";
import { draftClientPath } from "../api/fileIdentity";
import { fileTab, resetLayout, terminalTab } from "../__tests__/tabs";
import {
  activePane,
  reconcileLayout,
  restoreLayout,
  serializeLayout,
  type FileTab,
  type TerminalTab,
} from "./tabs.svelte";

const MARK = String.fromCharCode(0);
const DRAFT = draftClientPath({ path: "untitled/draft.md", draft_id: "v1:abc" });
const PROMPT = draftClientPath({ path: "untitled-2/draft.md", draft_id: "v1:def" });

function savedText(): string {
  return JSON.stringify(serializeLayout({ terminalSessions: true }));
}

function fileTabs(): FileTab[] {
  return activePane().tabs.filter((t): t is FileTab => t.kind === "file");
}

function terminals(): TerminalTab[] {
  return activePane().tabs.filter((t): t is TerminalTab => t.kind === "terminal");
}

function noServer(): void {
  vi.spyOn(api, "read").mockRejectedValue(new Error("no server in this test"));
  vi.spyOn(api, "readStream").mockRejectedValue(new Error("no server in this test"));
}

afterEach(() => {
  vi.restoreAllMocks();
  resetLayout();
});

describe("a draft in a saved layout", () => {
  test("is written as the server's path with its lifetime id, without the mark", () => {
    resetLayout([fileTab({ path: DRAFT }), terminalTab({ richPromptDraftPath: PROMPT })]);

    const text = savedText();

    expect(text.includes(MARK), "the raw mark").toBe(false);
    expect(text.includes("u0000"), "the escaped mark").toBe(false);
    expect(text, "the draft tab").toContain('"p":"untitled/draft.md","di":"v1:abc"');
    expect(text, "the bound prompt draft").toContain('"rpd":"untitled-2/draft.md","rpi":"v1:def"');
  });

  test("restores to the same client paths", async () => {
    noServer();
    resetLayout([fileTab({ path: DRAFT }), terminalTab({ richPromptDraftPath: PROMPT })]);
    const saved = JSON.parse(savedText());
    resetLayout();

    await restoreLayout(saved);

    expect(fileTabs().map((t) => t.path), "the draft tab").toEqual([DRAFT]);
    expect(terminals().map((t) => t.richPromptDraftPath), "the bound prompt draft").toEqual([
      PROMPT,
    ]);
  });

  test("leaves a workspace tab's saved form as it was", () => {
    resetLayout([fileTab({ path: "notes/a.md" })]);

    const text = savedText();

    expect(text, "the path").toContain('"p":"notes/a.md"');
    expect(text.includes('"di"'), "no lifetime id").toBe(false);
  });

  test("matches a saved draft tab to the open one when a layout is reconciled", () => {
    resetLayout([fileTab({ path: DRAFT })]);
    const open = fileTabs()[0]!;
    const saved = JSON.parse(savedText());

    reconcileLayout(saved);

    expect(fileTabs().map((t) => t.id), "the same tab, not a new one").toEqual([open.id]);
    expect(fileTabs()[0]!.path, "its path").toBe(DRAFT);
  });
});

describe("a marked string where a saved layout holds a workspace path", () => {
  test("is refused for a file tab", async () => {
    noServer();
    resetLayout();

    await restoreLayout({ k: "l", t: [{ p: DRAFT, a: 1 }] });

    expect(fileTabs().map((t) => t.path), "a workspace-typed entry").toEqual([""]);
  });

  test("is refused for a file tab that names a lifetime too", async () => {
    noServer();
    resetLayout();

    await restoreLayout({ k: "l", t: [{ p: DRAFT, di: "v1:abc", a: 1 }] });

    expect(fileTabs().map((t) => t.path), "a draft-typed entry").toEqual([""]);
  });

  test("is refused for a terminal's bound prompt draft", async () => {
    noServer();
    resetLayout();

    await restoreLayout({ k: "l", t: [{ k: "t", n: "Terminal", rpd: PROMPT, a: 1 }] });

    expect(terminals().map((t) => t.richPromptDraftPath), "the bound prompt draft").toEqual([
      undefined,
    ]);
  });
});
