import { describe, expect, test } from "vitest";
import fileEditorTab from "./FileEditorTab.svelte?raw";
import pane from "./Pane.svelte?raw";
import graphCanvas from "./GraphCanvas.svelte?raw";
import carousel from "./EmptyPaneCarousel.svelte?raw";
import indexingStatus from "../state/indexingStatus.svelte.ts?raw";

// Regression locks for two flip-related fixes (see the bug bodies inline).
// All assertions are source-pattern based, matching the existing
// `tabSwitchFocusFollow.test.ts` style: the browser is the source of
// truth for behavior, these pin the wiring so a refactor can't silently
// drop it.

// --- Bug #1: editor DOM focus must follow the active pane -------------
//
// `TerminalTab` already takes a `focused` prop and gates its xterm focus
// on it, so terminals follow pane focus. `FileEditorTab` did not: its
// pulse-driven focus effect was ungated, so in a multi-pane layout a
// single global `tabFocusPulse` bump focused EVERY mounted editor
// (last microtask wins), leaving the caret in a different pane from the
// focus highlight. The fix gives FileEditorTab the same `focused` gate
// and Pane.svelte feeds it `activePaneId === pane.id`.
describe("FileEditorTab focus follows the active pane", () => {
  test("declares a `focused` prop (defaulting false for non-pane hosts)", () => {
    // `active` joined `focused` with the keep-alive change (see
    // paneFileTabKeepAlive.test.ts); both default false so non-pane
    // hosts stay hidden-safe and never pull focus.
    expect(fileEditorTab).toMatch(
      /let \{ tab, active = false, focused = false \}: \{\s*tab: FileTab;\s*active\?: boolean;\s*focused\?: boolean;\s*\} = \$props\(\);/,
    );
  });

  test("focus effect bails when the pane is not active, before and inside the microtask", () => {
    // The leading `if (!focused) return;` makes `focused` a tracked dep
    // (so the effect re-runs on pane-focus change and flip-back); the
    // inner guard covers focus lost between the bump and the deferred
    // call. Both must be present.
    expect(fileEditorTab).toMatch(
      /\$effect\(\(\) => \{\s*if \(!focused\) return;\s*tabFocusPulse\.value;\s*queueMicrotask\(\(\) => \{\s*if \(!focused\) return;\s*focusActiveEditor\(\);/,
    );
    expect(fileEditorTab).toMatch(
      /function focusActiveEditor\(\): void \{\s*if \(tab\.mode === "wysiwyg"\) wysiwygRef\?\.focus\(\);\s*else if \(tab\.mode === "canvas"\) canvasRef\?\.focusCanvas\(\);\s*else sourceRef\?\.focus\(\);/,
    );
  });

  test("Pane.svelte gates FileEditorTab focus on active pane and visible side", () => {
    // With the keep-alive each-block (see paneFileTabKeepAlive.test.ts)
    // the gate short-circuits on pane mode, hidden A/B sides, non-active
    // sibling tabs, and non-active panes, mirroring terminals.
    expect(pane).toMatch(
      /<FileEditorTab\s+tab=\{t\}\s+active=\{[^}]*\}\s+focused=\{isLiveActive\(t\) && viewLayout\.activePaneId === pane\.id\}\s*\/>/,
    );
  });
});

// --- Bug #2: indexing graph must survive a flip ----------------------
//
// A Hybrid flip unmounts the whole front face (carousel + GraphCanvas).
// The poll result lived in local component state that reset to null on
// remount, so the flip-back mounted GraphCanvas on an empty node set,
// `start()` fit to nothing, and the async re-fetch never re-fit -> blank
// graph until a full window reload. Two complementary fixes:
//   1. a shared cache so the remount has data synchronously, and
//   2. a GraphCanvas empty->non-empty refit guard so any graph opened
//      before its data lands still frames itself.
describe("indexing graph survives a Hybrid flip", () => {
  test("shared indexingCache module exposes a last-response slot", () => {
    expect(indexingStatus).toMatch(
      /export const indexingCache = \$state<\{ last: IndexingStateResponse \| null \}>\(\{\s*last: null,\s*\}\);/,
    );
  });

  test("carousel seeds local indexing state from the cache on mount", () => {
    expect(carousel).toMatch(
      /import \{ indexingCache \} from "\.\.\/state\/indexingStatus\.svelte";/,
    );
    expect(carousel).toMatch(
      /let indexing = \$state<IndexingStateResponse \| null>\(indexingCache\.last\);/,
    );
  });

  test("carousel writes each successful poll back to the cache", () => {
    expect(carousel).toMatch(
      /indexing = await api\.indexingState\(\);\s*\/\/[^\n]*\n\s*indexingCache\.last = indexing;/,
    );
  });

  test("GraphCanvas refits when the node set transitions empty -> non-empty", () => {
    // Captures emptiness BEFORE rebuildWorkingSet reassigns dNodes, then
    // re-fits once the nodes have landed. This is what un-blanks a canvas
    // that opened (or remounted post-flip) before its data arrived.
    expect(graphCanvas).toMatch(/const wasEmpty = dNodes\.length === 0;/);
    expect(graphCanvas).toMatch(
      /if \(wasEmpty && dNodes\.length > 0\) \{\s*fitToContent\(24\);\s*\}/,
    );
  });
});
