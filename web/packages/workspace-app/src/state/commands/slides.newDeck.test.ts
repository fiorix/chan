import { describe, expect, test } from "vitest";
import slides from "./slides.ts?raw";

// New slide deck opens with the caret at the END of the seed's "# Slide 1"
// heading, ready to type. Without an explicit caret request the open falls
// back to the editor's document-start default (inside the frontmatter
// block), and the post-load saved-caret restore (openInPane ->
// restoreSavedCaretAfterLoad -> readCaret) can land a stale per-path
// offset when a deleted draft's untitled-N name is reused. The offset
// computation itself is proven behaviorally in editor/slides.test.ts
// (firstSlideHeadingCaret over the real server seed); the caret-command
// channel is proven in caretCommandChannel.test.ts + newFileCaret.test.ts.
// These pins lock the command wiring between the two.

describe("createSlidesAndOpen lands the caret at the first heading", () => {
  test("the caret request is issued after the open resolves (so it wins over the saved-caret restore)", () => {
    expect(slides).toMatch(
      /await openInActivePane\(path\);\s*landCaretAtFirstHeading\(path\);/,
    );
  });

  test("the offset comes from the loaded document via firstSlideHeadingCaret, not a hard-coded number", () => {
    expect(slides).toMatch(
      /import \{ firstSlideHeadingCaret \} from "\.\.\/\.\.\/editor\/slides";/,
    );
    expect(slides).toMatch(
      /const at = firstSlideHeadingCaret\(tab\.content\);\s*if \(at === null\) return;\s*issueCaretCommand\(tab, at, at\);/,
    );
  });

  test("the placement targets the freshly opened tab (active pane, path match)", () => {
    expect(slides).toMatch(
      /const tab = activeTabInPane\(node\);\s*if \(!tab \|\| tab\.kind !== "file" \|\| tab\.path !== path\) return;/,
    );
  });
});
