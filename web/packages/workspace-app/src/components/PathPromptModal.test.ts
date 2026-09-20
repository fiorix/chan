import { describe, expect, test } from "vitest";
import modal from "./PathPromptModal.svelte?raw";

// PathPromptModal `attach` mode: an existing directory should not
// trigger an "overwrites" warning, and a missing absolute path should
// not surface a "creates new directory" preamble (the SPA cannot see
// the OS filesystem; the backend creates on demand).

describe("PathPromptModal attach mode", () => {
  test("modal renders 'attach watcher to' label in attach mode", () => {
    expect(modal).toMatch(/status\.mode === "attach"[\s\S]{0,40}attach watcher to/);
  });

  test("existing-folder branch skips the overwrite warning in attach mode", () => {
    // The status derivation has a `mode === "attach"` branch that
    // returns a creates-shaped status with empty ancestors.
    expect(modal).toMatch(/if \(pathPromptState\.mode === "attach"\) \{/);
    expect(modal).toMatch(/newAncestors: \[\]/);
  });

  test("absolute-path branch suppresses the ancestor preamble", () => {
    // Absolute paths bypass tree.entries, so we don't fabricate a
    // mint-green ancestor chain that doesn't correspond to workspace
    // state.
    expect(modal).toMatch(
      /pathPromptState\.mode === "attach" && path\.startsWith\("\/"\)/,
    );
  });

  test("pathSegments demotes the final segment when attaching to an existing dir", () => {
    // tailIsExisting flips the "new" colouring off so the segment
    // reads as context rather than a fresh-create cue.
    expect(modal).toMatch(/const tailIsExisting =\s+s\.mode === "attach"/);
  });
});

describe("PathPromptModal notice line", () => {
  // The save-from-draft flow passes a `notice` to explain that the
  // draft directory is being saved as a folder. It renders above the
  // input as a non-blocking info line (never gates submit).
  test("modal renders the notice above the input when present", () => {
    expect(modal).toMatch(/\{#if pathPromptState\.notice\}/);
    expect(modal).toMatch(/<div class="notice">\{pathPromptState\.notice\}<\/div>/);
  });

  test("notice uses the muted info hue, not the error/warn colours", () => {
    // The status row owns err/warn colours; the notice is contextual.
    expect(modal).toMatch(/\.notice \{[\s\S]{0,120}var\(--info-text/);
  });
});

describe("PathPromptModal progressive autocomplete", () => {
  // tree.entries is loaded lazily (workspace root + File-Browser-expanded
  // dirs only), so a dialog opened without first browsing to the target
  // directory (e.g. save-from-draft) would show no suggestions for a deep
  // path. The modal walks the typed ancestor chain and loads the children
  // of each directory known to exist, so the next segment can be
  // suggested. Gated on folderSet so a mistyped segment can't 404.
  test("modal lazily loads typed ancestor directories for suggestions", () => {
    expect(modal).toContain("loadTreeDir");
    // That the load is gated on the directory already existing, so a mistyped
    // segment never asks the server, is asserted behaviourally in
    // pathPromptFailedAncestor.test.ts.
  });
});
