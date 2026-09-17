import { describe, expect, test } from "vitest";
import panel from "./GraphPanel.svelte?raw";
import tagInfo from "./TagInfoBody.svelte?raw";

// A mention node's "Graph from here" is available for EVERY mention,
// resolved or not. GraphPanel's inspector wiring scopes a mention that
// resolves to a contact note to `contact:<path>` through
// `openGraphForContact`, and one that does not to the mention lens
// (`mention:@@Name`) through `openGraphForMention`, so the button has a
// scope to open either way. The mention lens itself (bidirectional BFS)
// is pinned separately in graphMentionLensBidirectionalBfs.test.ts.

describe("GraphPanel wires a mention's 'Graph from here' for both branches", () => {
  test("GraphPanel imports openGraphForMention", () => {
    expect(panel).toMatch(/openGraphForMention,/);
  });

  test("a resolved mention keeps the contact scope", () => {
    // When the mention resolves to a contact note on disk
    // (selectedContactPath is set), "Graph from here" opens the contact
    // lens, unchanged from before.
    expect(panel).toMatch(
      /inspectorSelection\?\.kind === "mention"[\s\S]{1,600}?selectedContactPath\s*\?\s*\(\) => openGraphForContact\(selectedContactPath!\)/,
    );
  });

  test("an unresolved mention falls back to the mention meta-node lens", () => {
    // No contact note: scope to the mention node itself so the
    // button is available for any mention (was `undefined` before).
    expect(panel).toMatch(
      /:\s*\(\) =>\s*openGraphForMention\(\s*inspectorSelection\.nodeId,\s*inspectorSelection\.label,?\s*\)/,
    );
  });

  test("the onSetAsScope mention arm no longer gates the button on a resolved contact", () => {
    // The old wiring gated the whole onSetAsScope mention arm on
    // `mention" && selectedContactPath`, so an unresolved mention fell
    // through to `undefined` and the button vanished. The onSetAsScope
    // arm now opens on `kind === "mention"` alone and branches inside on
    // selectedContactPath. (The onOpen handler legitimately keeps the
    // `&& selectedContactPath` gate: an unresolved mention has no file
    // to open.)
    expect(panel).toMatch(
      /inspectorSelection\?\.kind === "mention"\s*\?\s*\/\/ The mention inspector's "Graph from here" always/,
    );
  });
});

describe("TagInfoBody's kind-chip routes each kind to its own scope", () => {
  test("TagInfoBody imports openGraphForMention", () => {
    expect(tagInfo).toMatch(
      /import \{ openGraphForMention, openGraphForTag \} from "\.\.\/state\/store\.svelte";/,
    );
  });

  test("a tag chip opens a tag scope", () => {
    expect(tagInfo).toMatch(
      /kind === "tag"\s*\?\s*\(\) => openGraphForTag\(nodeId, label\)/,
    );
  });

  test("a mention chip opens a mention scope, not a bogus tag scope", () => {
    expect(tagInfo).toMatch(
      /kind === "mention"\s*\?[\s\S]{0,240}?\(\) => openGraphForMention\(nodeId, label\)/,
    );
    // The pre-fix chip routed BOTH kinds through openGraphForTag, minting
    // a bogus `tag:@@Name` when a mention chip was clicked.
    expect(tagInfo).not.toMatch(
      /kind === "tag" \|\| kind === "mention"\s*\?\s*\(\) => openGraphForTag/,
    );
  });
});
