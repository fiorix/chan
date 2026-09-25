import { describe, expect, test } from "vitest";
import wysiwyg from "../editor/Wysiwyg.svelte?raw";
import source from "../editor/Source.svelte?raw";
import rightClickNoSelectMod from "../editor/right_click_no_select.ts?raw";
import pathPromptModal from "./PathPromptModal.svelte?raw";

// Three small editor fixes:
// 1. Right-click selects a line/word before the context menu opens.
//    Fix: CodeMirror domEventHandler returns true on button === 2 mousedown.
// 2. Image-as-raw-text after tab switch. Fix: view.requestMeasure()
//    in focus() + onMount so image decorations re-evaluate.
// 3. New Directory dialog selects the whole pre-populated path.
//    Fix: cursor-at-end for kind="folder" mode="create".

describe("(1): right-click no select", () => {
  test("right_click_no_select extension returns true on button===2 mousedown", () => {
    expect(rightClickNoSelectMod).toMatch(
      /export function rightClickNoSelect\(\)[\s\S]*?mousedown\(e\)[\s\S]*?if \(e\.button === 2\) return true;/,
    );
  });

  test("Wysiwyg includes rightClickNoSelect() in its extensions list", () => {
    expect(wysiwyg).toMatch(/import \{ rightClickNoSelect \} from "\.\/right_click_no_select";/);
    expect(wysiwyg).toMatch(/rightClickNoSelect\(\),/);
  });

  test("Source includes rightClickNoSelect() in its extensions list", () => {
    expect(source).toMatch(/import \{ rightClickNoSelect \} from "\.\/right_click_no_select";/);
    expect(source).toMatch(/rightClickNoSelect\(\),/);
  });
});

describe("(2): image-as-text re-render on tab focus", () => {
  test("Wysiwyg focus() export calls view.requestMeasure() so image decorations re-evaluate", () => {
    expect(wysiwyg).toMatch(
      /export function focus\(\): boolean \{[\s\S]*?view\.focus\(\);[\s\S]*?view\.requestMeasure\(\);/,
    );
  });

  test("Source focus() export mirrors the requestMeasure() call for parity", () => {
    expect(source).toMatch(
      /export function focus\(\): boolean \{[\s\S]*?view\.focus\(\);[\s\S]*?view\.requestMeasure\(\);/,
    );
  });

  test("Wysiwyg onMount also forces a requestMeasure() after view creation", () => {
    // Animate-in panes can mount the editor against a zero-size
    // host; the post-mount measure fires the decoration pass.
    expect(wysiwyg).toMatch(
      /view = new EditorView\(\{ state, parent: host \}\);[\s\S]*?view\.requestMeasure\(\);/,
    );
  });
});

describe("(3): New Directory dialog cursor at end", () => {
  test("PathPromptModal places cursor at end for folder+create (no select-all)", () => {
    expect(pathPromptModal).toMatch(
      /pathPromptState\.kind === "folder" &&\s*pathPromptState\.mode === "create"[\s\S]*?const end = pathPromptState\.defaultValue\.length;[\s\S]*?inputEl\?\.setSelectionRange\(end, end\);/,
    );
  });

  test("file+create stem selection preserved (case unchanged)", () => {
    // The existing file+create case must not regress.
    expect(pathPromptModal).toMatch(
      /pathPromptState\.kind === "file" &&\s*pathPromptState\.mode === "create"[\s\S]*?setSelectionRange\(\s*stemStart/,
    );
  });

  test("default select-all branch still exists for other kinds/modes", () => {
    // Move / attach / file-non-default-name fall through to the
    // original select-all behavior - preserved.
    expect(pathPromptModal).toMatch(/} else \{[\s\S]*?inputEl\?\.select\(\);/);
  });
});
