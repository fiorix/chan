import { describe, expect, test } from "vitest";
import richPromptSrc from "./RichPrompt.svelte?raw";
import wysiwygSrc from "../editor/Wysiwyg.svelte?raw";

// The Rich Prompt composer floats over a terminal, so it
// themes on the "terminal" hybrid surface, not the "editor" surface it would
// inherit from Wysiwyg's default. Only visible in split light/dark hybrid
// themes; pinned here against an accidental revert to the editor surface.
describe("RichPrompt composer theme surface", () => {
  test("RichPrompt mounts Wysiwyg with surface=terminal", () => {
    expect(richPromptSrc).toMatch(/<Wysiwyg[\s\S]{1,400}surface="terminal"/);
  });

  test("Wysiwyg drives its theme off the surface prop, not a hardcoded editor surface", () => {
    expect(wysiwygSrc).toMatch(/surface\?: "editor" \| "terminal"/);
    expect(wysiwygSrc).toMatch(/effectiveHybridSurfaceTheme\(surface\)/);
    expect(wysiwygSrc).not.toMatch(/effectiveHybridSurfaceTheme\("editor"\)/);
  });
});
