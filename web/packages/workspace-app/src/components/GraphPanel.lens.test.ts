import { describe, expect, test } from "vitest";
import graphPanel from "./GraphPanel.svelte?raw";

// The tag lens BFS was forward-only. Because the backend emits tag
// edges as `source: <file>, target: <tagId>`, seeding from the tag
// node never traversed the incoming edges and the lens rendered empty.
// The fix is a bidirectional BFS, matching the contact arm's shape.

describe("tag lens BFS is bidirectional", () => {
  test("tag arm walks edges in both directions", () => {
    // Asserted as a string shape because computeScopedNodeSet is a
    // $derived inside the Svelte component, not a pure function.
    expect(graphPanel).toMatch(
      /if \(currentScope\.kind === "tag"\) \{[\s\S]{1,1600}if \(frontier\.has\(e\.source\) && !visited\.has\(e\.target\)\) \{[\s\S]{1,200}next\.add\(e\.target\);[\s\S]{1,200}visited\.add\(e\.target\);[\s\S]{1,300}if \(frontier\.has\(e\.target\) && !visited\.has\(e\.source\)\) \{[\s\S]{1,200}next\.add\(e\.source\);[\s\S]{1,200}visited\.add\(e\.source\);[\s\S]{1,200}if \(next\.size === 0\) break;/,
    );
  });

  test("tag arm no longer carries the forward-only rationale comment", () => {
    // The old comment described forward-only semantics that no longer apply.
    expect(graphPanel).not.toMatch(
      /forward-only BFS \(outgoing edges only\)/,
    );
  });
});
