import { describe, expect, test } from "vitest";
import source from "./FileEditorTab.svelte?raw";

describe("slide editor shortcuts", () => {
  // The one claim this file is uniquely good at: the capture-phase mount
  // exists on BOTH editor hosts. The handler body is behavior-pinned by
  // editor/wysiwygModEnter.test.ts instead of by source regexes.
  test("captures the slide chord before CodeMirror on both editor hosts", () => {
    expect(source).toMatch(
      /<div[\s\S]{0,240}class="editor-host"[\s\S]{0,240}onkeydowncapture=\{onSlideShortcutKeydown\}[\s\S]{0,800}<Wysiwyg/,
    );
    expect(source).toMatch(
      /<div[\s\S]{0,240}class="editor-host"[\s\S]{0,240}onkeydowncapture=\{onSlideShortcutKeydown\}[\s\S]{0,800}<Source/,
    );
  });

  test("refocuses the editor after closing slide preview", () => {
    // `tick` drives the deferred refocus; tolerate other svelte imports
    // on the same line (e.g. untrack for the doc-session effect).
    expect(source).toMatch(/import \{[^}]*\btick\b[^}]*\} from "svelte";/);
    expect(source).toMatch(
      /function refocusAfterSlidePreviewClose\(\): void \{[\s\S]*?void tick\(\)\.then\(\(\) => \{[\s\S]*?if \(!active \|\| !focused\) return;[\s\S]*?focusActiveEditor\(\);/,
    );
    expect(source).toMatch(
      /onClose: \(\) => \{[\s\S]*?setTabSlidePreviewOpen\(tab, false\);[\s\S]*?slidePreviewHandle = null;[\s\S]*?refocusAfterSlidePreviewClose\(\);[\s\S]*?\},/,
    );
  });
});
