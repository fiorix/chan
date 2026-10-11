import { expect, test } from "vitest";
import { EMPTY_PANE_ANIMATIONS } from "../../workspace-app/src/components/emptyPaneAnimations";
import credits from "./animation-credits.json";

test("every workspace animation has exactly one public credit under its current name", () => {
  expect(credits.map(({ id, name }) => ({ id, name }))).toEqual(
    EMPTY_PANE_ANIMATIONS.map(({ id, name }) => ({ id, name })),
  );
  for (const animation of credits) {
    expect(animation.credit.trim()).not.toBe("");
    expect(animation.references.length).toBeGreaterThan(0);
    for (const reference of animation.references) {
      expect(reference.label.trim()).not.toBe("");
      expect(new URL(reference.url).protocol).toBe("https:");
    }
  }
});

test("continuations and secondary geometry references remain credited", () => {
  expect(credits.find(({ id }) => id === "mutual-force-starburst")?.references.map(({ url }) => url)).toEqual([
    "https://x.com/hisadan/status/1937852453929783400",
    "https://x.com/hisadan/status/1937852456584814776",
  ]);
  expect(credits.find(({ id }) => id === "segmented-torus")?.references.map(({ url }) => url)).toEqual([
    "https://x.com/scinaturenews/status/2107967191652192475",
    "https://discourse.threejs.org/t/twisted-torus-parametric/56492",
  ]);
});
