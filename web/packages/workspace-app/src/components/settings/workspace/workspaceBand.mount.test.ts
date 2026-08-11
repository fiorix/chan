// @vitest-environment jsdom

// Mount smoke for the per-workspace settings band. Nothing else in the
// tree mounts these six controls; this is the check that a migration
// fault (a bad snippet, a reactivity loop) fails loudly instead of
// shipping unseen. Endpoints are unreachable under jsdom, so every
// control lands in its loading or error state - which is exactly the
// state this asserts can render.

import { mount, tick, unmount } from "svelte";
import { describe, expect, test } from "vitest";
import WorkspaceSection from "./WorkspaceSection.svelte";

describe("workspace band mount", () => {
  test("mounts all six controls without a reactivity fault", async () => {
    const target = document.createElement("div");
    document.body.appendChild(target);
    const cmp = mount(WorkspaceSection, { target });
    await tick();
    await new Promise((r) => setTimeout(r, 50));
    const text = target.textContent ?? "";
    for (const label of [
      "Index",
      "Semantic search",
      "Excluded directories",
      "chan-reports",
      "Metadata archive",
      "Screen lock",
    ]) {
      expect(text).toContain(label);
    }
    unmount(cmp);
    target.remove();
  });
});
