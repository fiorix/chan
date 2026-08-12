import { describe, expect, test } from "vitest";
import source from "./FileEditorTab.svelte?raw";

describe("slide editor shortcuts", () => {
  // The capture-phase mount exists on BOTH editor hosts. The chord's
  // ordering contract (one claimant per press, containment) is
  // behavior-pinned by editor/wysiwygModEnter.test.ts, but that suite
  // exercises a local mirror of the claim's shape, not this component,
  // so every gate the mirror does not carry is source-pinned below.
  test("captures the slide chord before CodeMirror on both editor hosts", () => {
    expect(source).toMatch(
      /<div[\s\S]{0,240}class="editor-host"[\s\S]{0,240}onkeydowncapture=\{onSlideShortcutKeydown\}[\s\S]{0,800}<Wysiwyg/,
    );
    expect(source).toMatch(
      /<div[\s\S]{0,240}class="editor-host"[\s\S]{0,240}onkeydowncapture=\{onSlideShortcutKeydown\}[\s\S]{0,800}<Source/,
    );
  });

  // The frontmatter/loading gates, the rebind supersede, and the Shift
  // routing to present vs preview only exist in the production handler;
  // inverting any of them keeps the mirror-based behavior suite green.
  test("gates on slide frontmatter, the rebind supersede, and routes Shift to present", () => {
    expect(source).toContain('import { parseSlidesSpec } from "../editor/slides";');
    expect(source).toContain("const slidesSpec = $derived(parseSlidesSpec(tab.content));");
    expect(source).toMatch(
      /function onSlideShortcutKeydown\(e: KeyboardEvent\): void \{[\s\S]*?if \(!slidesSpec \|\| tab\.loading \|\| e\.key !== "Enter" \|\| e\.altKey\) return;[\s\S]*?if \(!slideShortcutModifierPressed\(e\)\) return;[\s\S]*?if \(shouldIgnoreSlideShortcutTarget\(e\.target\)\) return;[\s\S]*?const slideAction = e\.shiftKey \? "app\.slides\.present" : "app\.slides\.preview";[\s\S]*?if \(builtInChordSuperseded\(slideAction\)\) return;[\s\S]*?e\.preventDefault\(\);[\s\S]*?e\.stopPropagation\(\);[\s\S]*?if \(e\.shiftKey\) playSlides\(\);[\s\S]*?else previewSlides\(\);/,
    );
  });

  // The mirror accepts Ctrl OR Meta and any event target; the handler
  // resolves ONE platform Mod and stands down for form-control targets
  // outside the editor, so both gates need a pin of their own.
  test("uses the platform Mod and ignores form-control targets outside the editor", () => {
    expect(source).toMatch(
      /return slideShortcutOS === "mac" \? e\.metaKey : e\.ctrlKey;/,
    );
    expect(source).toMatch(
      /function shouldIgnoreSlideShortcutTarget\(target: EventTarget \| null\): boolean \{[\s\S]*?if \(target\.closest\("\.cm-editor"\)\) return false;[\s\S]*?return target\.closest\("input, textarea, select, button, \[role='button'\]"\) !== null;/,
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
