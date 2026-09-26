// @vitest-environment jsdom
//
// The warning reader's positive control. The tests that assert no ownership
// warning pass just as well against a reader that sees nothing, so this one
// makes a component write a prop it does not own and requires the reader to
// report it.

import { flushSync, mount, unmount } from "svelte";
import { expect, test, vi } from "vitest";

import UnownedPropOwner from "./UnownedPropOwner.svelte";
import { ownershipWarnings } from "./svelteWarnings";

test("reports a component writing a prop it does not own", () => {
  // Armed with no mock of its own, so the reader listens through the same spy
  // every pin does; quiet, so a count of these warnings in a gate log counts
  // only the ones nobody meant.
  const warnings = ownershipWarnings({ quiet: true });
  const target = document.createElement("div");
  document.body.append(target);
  const app = mount(UnownedPropOwner, { target });
  try {
    const button = target.querySelector("button")!;
    button.click();
    flushSync();
    expect(button.textContent).toBe("1");
    expect(warnings()).toEqual([expect.stringMatching(/^ownership_invalid_mutation: /)]);
  } finally {
    unmount(app);
    target.remove();
    vi.restoreAllMocks();
  }
});
