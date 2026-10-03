// @vitest-environment jsdom
//
// PathPromptModal, mounted. The dialog opens through uiPathPrompt over a
// fixed tree; each test types a path and reads the status row, the notice and
// the OK button, or the directory listings the dialog asks for.

import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const listed = vi.hoisted(() => ({
  calls: [] as string[],
  children: {} as Record<string, Array<{ path: string; is_dir: boolean; mtime: null; size: number }>>,
}));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      list: vi.fn(async (dir: string) => {
        listed.calls.push(dir);
        return listed.children[dir] ?? [];
      }),
    },
  };
});

import PathPromptModal from "./PathPromptModal.svelte";
import {
  clickBackdrop,
  dialogIn,
  dialogName,
  focusOrigin,
  press,
  recordDocumentKeys,
} from "../__tests__/dialog";
import {
  resolvePathPrompt,
  tree,
  uiPathPrompt,
  type PathPromptKind,
  type PathPromptMode,
} from "../state/store.svelte";
import { workspace } from "../state/workspace.svelte";

const mounted: Array<Record<string, unknown>> = [];

function mountModal(): HTMLElement {
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(PathPromptModal, { target }) as Record<string, unknown>);
  return target;
}

async function settle(turns = 4): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await tick();
    await new Promise((r) => setTimeout(r, 0));
  }
}

type Prompt = {
  kind: PathPromptKind;
  mode: PathPromptMode;
  defaultValue?: string;
  allowAbsolute?: boolean;
  notice?: string;
  sourcePath?: string;
};

/// Open the dialog and type `text`. The resolve promise rides back inside an
/// object so the caller's `await` does not block on the open dialog.
async function openDialog(
  target: HTMLElement,
  prompt: Prompt,
  text: string,
): Promise<{ promise: Promise<string | null> }> {
  const promise = uiPathPrompt({ title: "path", ...prompt });
  await tick();
  await type(target, text);
  return { promise };
}

async function type(target: HTMLElement, text: string): Promise<void> {
  const input = target.querySelector("input")!;
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await tick();
}

function statusText(target: HTMLElement): string {
  return target.querySelector(".status")!.textContent!.replace(/\s+/g, " ").trim();
}

function statusRow(target: HTMLElement): HTMLElement {
  return target.querySelector<HTMLElement>(".status")!;
}

/// The rendered path, one entry per segment: its text and whether it is
/// coloured as new.
function segments(target: HTMLElement): Array<[string, boolean]> {
  return [...target.querySelectorAll<HTMLElement>(".status .seg")].map((s) => [
    s.textContent ?? "",
    s.classList.contains("isnew"),
  ]);
}

function okButton(target: HTMLElement): HTMLButtonElement {
  return target.querySelector(".actions .ok")!;
}

beforeEach(() => {
  listed.calls = [];
  listed.children = {};
  tree.entries = [
    { path: "docs", is_dir: true, mtime: null, size: 0 },
    { path: "docs/watch", is_dir: true, mtime: null, size: 0 },
    { path: "notes.md", is_dir: false, mtime: null, size: 3 },
  ];
  tree.loadedDirs = { "": true, docs: true };
  tree.loadingDirs = {};
  tree.dirErrors = {};
});

afterEach(() => {
  resolvePathPrompt(null);
  for (const c of mounted.splice(0)) unmount(c);
  document.body.innerHTML = "";
  tree.entries = [];
  tree.loadedDirs = {};
  workspace.info = null;
  vi.clearAllMocks();
});

describe("attach mode", () => {
  test("an existing directory is the target, with no overwrite warning", async () => {
    const target = mountModal();
    const { promise } = await openDialog(target, { kind: "folder", mode: "attach" }, "docs/watch");

    expect(statusText(target)).toBe("→ attach watcher to docs/watch/");
    expect(statusRow(target).classList.contains("warn")).toBe(false);
    expect(segments(target), "the existing directory is not coloured as new").toEqual([
      ["docs/", false],
      ["watch/", false],
    ]);
    okButton(target).click();
    await expect(promise).resolves.toBe("docs/watch");
  });

  test("a missing directory under a missing parent names the ancestor", async () => {
    const target = mountModal();
    await openDialog(target, { kind: "folder", mode: "attach" }, "logs/app");

    expect(statusText(target)).toBe("⚠ attach watcher to logs/app/");
    expect(statusRow(target).classList.contains("warn")).toBe(true);
    expect(segments(target)).toEqual([
      ["logs/", true],
      ["app/", true],
    ]);
  });

  test("an absolute path gets no ancestor preamble", async () => {
    const target = mountModal();
    await openDialog(target, { kind: "folder", mode: "attach", allowAbsolute: true }, "/var/log/app");

    expect(statusText(target)).toBe("→ attach watcher to /var/log/app/");
    expect(statusRow(target).classList.contains("warn")).toBe(false);
    expect(okButton(target).disabled).toBe(false);
  });

  test("an existing file cannot take a watcher", async () => {
    const target = mountModal();
    await openDialog(target, { kind: "folder", mode: "attach" }, "notes.md");

    expect(statusText(target)).toBe("✗ 'notes.md' is an existing file, can't attach a watcher to a directory");
    expect(okButton(target).disabled).toBe(true);
  });
});

describe("the notice line", () => {
  test("sits above the input, apart from the status row, and never blocks OK", async () => {
    const target = mountModal();
    await openDialog(
      target,
      { kind: "folder", mode: "create", notice: "The whole draft is saved as a directory." },
      "saved",
    );
    const notice = target.querySelector<HTMLElement>(".notice");

    expect(notice?.textContent).toBe("The whole draft is saved as a directory.");
    expect(notice!.compareDocumentPosition(target.querySelector("input")!)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(notice!.closest(".status")).toBeNull();
    expect(okButton(target).disabled).toBe(false);
  });

  test("is absent when the caller gives none", async () => {
    const target = mountModal();
    await openDialog(target, { kind: "folder", mode: "create" }, "saved");
    expect(target.querySelector(".notice")).toBeNull();
  });
});

describe("suggestions for a deep path", () => {
  test("list each typed directory the tree knows but has not loaded", async () => {
    tree.entries.push({ path: "docs/watch/deep", is_dir: true, mtime: null, size: 0 });
    listed.children["docs/watch"] = [{ path: "docs/watch/deep", is_dir: true, mtime: null, size: 0 }];
    const target = mountModal();
    await openDialog(target, { kind: "file", mode: "create" }, "docs/watch/deep/x");
    await settle();

    expect(listed.calls, "docs is loaded already").toEqual(["docs/watch", "docs/watch/deep"]);
    expect(tree.loadedDirs["docs/watch"]).toBe(true);
    expect(tree.loadedDirs["docs/watch/deep"]).toBe(true);
  });

  test("never list a typed segment the tree does not know", async () => {
    const target = mountModal();
    await openDialog(target, { kind: "file", mode: "create" }, "nowhere/deeper/x");
    await settle();

    expect(listed.calls).toEqual([]);
  });

  test("offer the children the listing brought in", async () => {
    listed.children["docs/watch"] = [{ path: "docs/watch/inbox", is_dir: true, mtime: null, size: 0 }];
    const target = mountModal();
    await openDialog(target, { kind: "file", mode: "create" }, "docs/watch/");
    await settle();
    await type(target, "docs/watch/in");

    const options = [...target.querySelectorAll("[role='option']")].map((li) => li.textContent?.trim());
    expect(options).toContain("docs/watch/inbox/");
  });
});

describe("move mode", () => {
  test("an existing directory is no target: the dialog asks for a new path", async () => {
    const target = mountModal();
    await openDialog(target, { kind: "folder", mode: "move", sourcePath: "old" }, "docs");

    expect(statusText(target)).toBe("✗ 'docs' is an existing directory; choose a new path");
    expect(okButton(target).disabled).toBe(true);
  });
});

describe("a backslash in a typed path", () => {
  const REFUSED = "✗ \\ cannot be added to a name";

  beforeEach(() => {
    tree.entries = [
      ...tree.entries,
      { path: "a\\b.md", is_dir: false, mtime: null, size: 1 },
      { path: "x\\y", is_dir: true, mtime: null, size: 0 },
    ];
  });

  test("a rename of a file whose name holds one opens accepted, and the new name may keep it", async () => {
    const target = mountModal();
    const { promise } = await openDialog(
      target,
      { kind: "file", mode: "move", defaultValue: "a\\b.md", sourcePath: "a\\b.md" },
      "a\\b.md",
    );
    expect(statusText(target), "the file's own path is not refused").toBe("unchanged");

    await type(target, "a\\c.md");
    expect(statusText(target)).toBe("→ moves to a\\c.md");
    expect(okButton(target).disabled).toBe(false);
    okButton(target).click();
    await expect(promise).resolves.toBe("a\\c.md");
  });

  test.each([
    ["a move into a directory whose name holds one", "move", "notes.md", "x\\y/notes.md", "→ moves to x\\y/notes.md"],
    ["a new file in a directory whose name holds one", "create", undefined, "x\\y/new.md", "→ new file x\\y/new.md"],
    ["an existing file whose name holds one, opened", "open", undefined, "a\\b.md", "→ opens a\\b.md"],
  ] as const)("%s is accepted", async (_name, mode, sourcePath, typed, status) => {
    const target = mountModal();
    await openDialog(target, { kind: "file", mode, sourcePath }, typed);

    expect(statusText(target)).toBe(status);
    expect(okButton(target).disabled).toBe(false);
  });

  test.each([
    ["a rename to a name that gains one", "move", "notes.md", "no\\tes.md"],
    ["a rename to a name that holds one more", "move", "a\\b.md", "a\\b\\c.md"],
    ["a new file whose name holds one", "create", undefined, "p\\q.md"],
    ["a new directory whose name holds one, on the way to a file", "create", undefined, "p\\q/new.md"],
    ["a path to open that would create a name that holds one", "open", undefined, "p\\q.md"],
  ] as const)("%s is refused", async (_name, mode, sourcePath, typed) => {
    const target = mountModal();
    await openDialog(target, { kind: "file", mode, sourcePath }, typed);

    expect(statusText(target)).toBe(REFUSED);
    expect(okButton(target).disabled).toBe(true);
  });

  test("a move onto an existing name that holds one reads as a move onto any existing file", async () => {
    const target = mountModal();
    await openDialog(target, { kind: "file", mode: "move", sourcePath: "notes.md" }, "a\\b.md");

    expect(statusText(target)).toBe("\u26a0 overwrites existing file a\\b.md");
  });

  test("a path through a directory whose parent could not be listed says that, and not that a backslash cannot be added", async () => {
    tree.entries = [...tree.entries, { path: "deep", is_dir: true, mtime: null, size: 0 }];
    tree.dirErrors = { deep: "permission denied" };
    const target = mountModal();
    await openDialog(target, { kind: "file", mode: "create" }, "deep/x\\y/new.md");
    await settle();

    expect(statusText(target)).toBe("\u26a0 cannot list deep: permission denied");
    expect(okButton(target).disabled).toBe(true);
  });

  test("a path through a directory whose parent is being listed says so, and not that a backslash cannot be added", async () => {
    tree.entries = [...tree.entries, { path: "deep", is_dir: true, mtime: null, size: 0 }];
    tree.loadingDirs = { deep: true };
    const target = mountModal();
    await openDialog(target, { kind: "file", mode: "create" }, "deep/x\\y/new.md");
    await settle();

    expect(statusText(target)).toBe("listing deep...");
    expect(okButton(target).disabled).toBe(true);
  });

  test("a directory that holds one is accepted once the listing that names it has come", async () => {
    tree.entries = [...tree.entries, { path: "deep", is_dir: true, mtime: null, size: 0 }];
    listed.children.deep = [{ path: "deep/x\\y", is_dir: true, mtime: null, size: 0 }];
    const target = mountModal();
    await openDialog(target, { kind: "file", mode: "create" }, "deep/x\\y/new.md");
    await settle();

    expect(listed.calls).toContain("deep");
    expect(statusText(target)).toBe("→ new file deep/x\\y/new.md");
    expect(okButton(target).disabled).toBe(false);
  });

  describe("on a Windows server", () => {
    beforeEach(() => {
      workspace.info = { root: "C:\\ws" } as typeof workspace.info;
    });

    test.each([
      ["a new file", "create", undefined, "notes\\new.md", "→ new file notes\\new.md"],
      ["a rename", "move", "notes.md", "docs\\notes.md", "→ moves to docs\\notes.md"],
      ["a path to open", "open", undefined, "docs\\new.md", "→ creates and opens docs\\new.md"],
    ] as const)("%s typed in the server's spelling is accepted and answered as typed", async (_name, mode, sourcePath, typed, status) => {
      const target = mountModal();
      const { promise } = await openDialog(target, { kind: "file", mode, sourcePath }, typed);

      expect({ told: statusText(target), refused: okButton(target).disabled }).toEqual({ told: status, refused: false });
      okButton(target).click();
      await expect(promise).resolves.toBe(typed);
    });
  });

  describe("on a Unix server, an absolute path under the root", () => {
    beforeEach(() => {
      workspace.info = { root: "/abs/root" } as typeof workspace.info;
    });

    /// What the status row and the OK button say of the typed path.
    function told(target: HTMLElement): { rule: boolean; refused: boolean } {
      return { rule: statusText(target) === REFUSED, refused: okButton(target).disabled };
    }

    test("to an entry whose name holds a backslash is accepted and answered as typed", async () => {
      const target = mountModal();
      const typed = "/abs/root/a\\b.md";
      const { promise } = await openDialog(target, { kind: "file", mode: "open", allowAbsolute: true }, typed);

      expect(told(target)).toEqual({ rule: false, refused: false });
      okButton(target).click();
      await expect(promise).resolves.toBe(typed);
    });

    test("that would create a name that holds a backslash is refused", async () => {
      const target = mountModal();
      await openDialog(target, { kind: "file", mode: "open", allowAbsolute: true }, "/abs/root/p\\q.md");

      expect(told(target)).toEqual({ rule: true, refused: true });
    });

    test("through a directory that holds a backslash is accepted once the listing that names it has come", async () => {
      tree.entries = [...tree.entries, { path: "deep", is_dir: true, mtime: null, size: 0 }];
      listed.children.deep = [{ path: "deep/x\\y", is_dir: true, mtime: null, size: 0 }];
      const target = mountModal();
      await openDialog(target, { kind: "file", mode: "open", allowAbsolute: true }, "/abs/root/deep/x\\y/new.md");
      await settle();

      // The prompt lists every known directory on the way, as it does for a
      // relative path; the one the rule waits for is the parent.
      expect({ parentListed: listed.calls.includes("deep"), ...told(target) }).toEqual({
        parentListed: true,
        rule: false,
        refused: false,
      });
    });

    test("through a directory whose parent is being listed says so, and not that a backslash cannot be added", async () => {
      tree.entries = [...tree.entries, { path: "deep", is_dir: true, mtime: null, size: 0 }];
      tree.loadingDirs = { deep: true };
      const target = mountModal();
      await openDialog(target, { kind: "file", mode: "open", allowAbsolute: true }, "/abs/root/deep/x\\y/new.md");
      await settle();

      expect(statusText(target)).toBe("listing deep...");
      expect(okButton(target).disabled).toBe(true);
    });
  });
});

describe("the file-or-directory kind", () => {
  test("invites both shapes in its placeholder", async () => {
    const target = mountModal();
    await openDialog(target, { kind: "either", mode: "create" }, "");
    expect(target.querySelector("input")!.placeholder).toBe("file/path or directory/path/");
  });

  test("a trailing slash is a directory, taken as typed", async () => {
    const target = mountModal();
    const { promise } = await openDialog(target, { kind: "either", mode: "create" }, "docs/new/");

    expect(statusText(target)).toBe("→ new directory docs/new/");
    expect(target.querySelector(".status .seg.auto")).toBeNull();
    okButton(target).click();
    await expect(promise).resolves.toBe("docs/new/");
  });

  test("no trailing slash is a file, with .md added when no extension is typed", async () => {
    const target = mountModal();
    const { promise } = await openDialog(target, { kind: "either", mode: "create" }, "docs/plan");

    expect(statusText(target)).toBe("→ new file docs/plan.md");
    expect(target.querySelector(".status .seg.auto")?.textContent).toBe(".md");
    okButton(target).click();
    await expect(promise).resolves.toBe("docs/plan.md");
  });

  test("a directory over an existing file is a kind mismatch", async () => {
    const target = mountModal();
    await openDialog(target, { kind: "either", mode: "create" }, "notes.md/");

    expect(statusText(target)).toBe("✗ 'notes.md' is an existing file, can't create a directory");
    expect(okButton(target).disabled).toBe(true);
  });
});

describe("the text selected when the dialog opens", () => {
  async function openWith(prompt: Prompt & { defaultValue: string }): Promise<HTMLInputElement> {
    const target = mountModal();
    void uiPathPrompt({ title: "path", ...prompt });
    await settle(2);
    return target.querySelector("input")!;
  }

  test("New Directory puts the caret after the parent path, selecting nothing", async () => {
    const input = await openWith({ kind: "folder", mode: "create", defaultValue: "docs/" });
    expect([input.selectionStart, input.selectionEnd]).toEqual([5, 5]);
  });

  test("New File or Directory does the same", async () => {
    const input = await openWith({ kind: "either", mode: "create", defaultValue: "docs/" });
    expect([input.selectionStart, input.selectionEnd]).toEqual([5, 5]);
  });

  test("New File selects the proposed file name, not its directory", async () => {
    const input = await openWith({ kind: "file", mode: "create", defaultValue: "docs/untitled.md" });
    expect([input.selectionStart, input.selectionEnd]).toEqual([5, 16]);
  });

  test("a move selects the whole path", async () => {
    const input = await openWith({ kind: "file", mode: "move", defaultValue: "docs/old.md", sourcePath: "docs/old.md" });
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 11]);
  });
});

describe("the dialog itself", () => {
  test("is modal and named by its title", async () => {
    const target = mountModal();
    await openDialog(target, { kind: "file", mode: "create" }, "docs/new.md");
    const dialog = dialogIn(target)!;
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialogName(dialog)).toBe("path");
  });
});

describe("dismissal", () => {
  test("Escape in the input answers null", async () => {
    const target = mountModal();
    const { promise } = await openDialog(target, { kind: "file", mode: "create" }, "docs/new.md");
    const escape = press(target.querySelector("input")!, "Escape");
    await expect(promise).resolves.toBeNull();
    expect(escape.defaultPrevented).toBe(true);
  });

  test("the Escape that cancels goes no further than the dialog", async () => {
    const target = mountModal();
    const { promise } = await openDialog(target, { kind: "file", mode: "create" }, "docs/new.md");
    const reached = recordDocumentKeys();
    press(target.querySelector("input")!, "Escape");
    reached.stop();
    await expect(promise).resolves.toBeNull();
    expect(reached.keys, "keys that reached the document").toEqual([]);
  });

  test("closing returns focus to where it was when the dialog opened", async () => {
    const target = mountModal();
    const origin = focusOrigin();
    const { promise } = await openDialog(target, { kind: "file", mode: "create" }, "docs/new.md");
    target.querySelector<HTMLButtonElement>(".actions .cancel")!.click();
    await promise;
    await settle();
    expect(document.activeElement).toBe(origin);
  });

  test("a click on the backdrop answers null and a click inside the panel does not", async () => {
    const target = mountModal();
    const { promise } = await openDialog(target, { kind: "file", mode: "create" }, "docs/new.md");
    let settled = false;
    void promise.then(() => (settled = true));

    statusRow(target).click();
    await settle();
    expect(settled, "a click inside the panel leaves the dialog open").toBe(false);
    expect(dialogIn(target)).not.toBeNull();

    clickBackdrop(target);
    await expect(promise).resolves.toBeNull();
  });
});
