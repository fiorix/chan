import { describe, expect, it } from "vitest";
import { fuzzyDeckScore, rankDeckItems, SESSION_DECK_DRAFT_KEY, type DeckItem } from "./model";

describe("SESSION_DECK_DRAFT_KEY", () => {
  it("names the launcher draft under the cloned-session prefix", () => {
    expect(SESSION_DECK_DRAFT_KEY).toBe("chan.command-launcher.v1:contextual");
  });
});

function row(id: string, title: string, over: Partial<DeckItem> = {}): DeckItem {
  return { id, title, breadcrumb: "", searchText: "", scope: "window", ...over };
}

const ids = (items: DeckItem[]): string[] => items.map((item) => item.id);

describe("rankDeckItems", () => {
  it("returns the rows as given for an empty query", () => {
    const items = [row("b", "Beta", { disabled: true }), row("a", "Alpha")];
    const ranked = rankDeckItems(items, "   ");
    expect(ids(ranked)).toEqual(["b", "a"]);
    expect(ranked).not.toBe(items);
  });

  it("matches the words of a query in either order", () => {
    const items = [
      row("close-tab", "Close tab"),
      row("close-pane", "Close pane"),
      row("next-tab", "Next tab"),
    ];
    expect(ids(rankDeckItems(items, "tab close"))).toEqual(["close-tab"]);
    expect(ids(rankDeckItems(items, "close tab"))).toEqual(["close-tab"]);
  });

  it("drops a row that misses one of the words", () => {
    const items = [row("split", "Split right"), row("close", "Close pane")];
    expect(ids(rankDeckItems(items, "split zebra"))).toEqual([]);
    expect(ids(rankDeckItems(items, "split"))).toEqual(["split"]);
  });

  it("reads the breadcrumb, the subtitle and the search text", () => {
    const items = [
      row("crumb", "Restart", { breadcrumb: "Tab > Terminal" }),
      row("sub", "Focus window", { subtitle: "geekom" }),
      row("keyword", "Reload window", { searchText: "refresh" }),
      row("none", "Split right"),
    ];
    expect(ids(rankDeckItems(items, "terminal"))).toEqual(["crumb"]);
    expect(ids(rankDeckItems(items, "geekom"))).toEqual(["sub"]);
    expect(ids(rankDeckItems(items, "refresh"))).toEqual(["keyword"]);
    // Each word may come from a different field of the same row.
    expect(ids(rankDeckItems(items, "geekom focus"))).toEqual(["sub"]);
  });

  it("ranks a title hit above a hit elsewhere", () => {
    const items = [
      row("keyword", "Appearance", { searchText: "theme" }),
      row("title", "Editor body theme"),
    ];
    expect(ids(rankDeckItems(items, "theme"))).toEqual(["title", "keyword"]);
  });

  it("ranks the start of a word above the middle of one", () => {
    const items = [row("inside", "Retab file"), row("start", "Next tab")];
    expect(ids(rankDeckItems(items, "tab"))).toEqual(["start", "inside"]);
    // The same holds outside the title.
    const elsewhere = [
      row("inside", "Alpha", { searchText: "retab" }),
      row("start", "Beta", { searchText: "tab" }),
    ];
    expect(ids(rankDeckItems(elsewhere, "tab"))).toEqual(["start", "inside"]);
  });

  it("ranks a title hit inside a word above a word start elsewhere", () => {
    const items = [
      row("elsewhere", "Alpha", { searchText: "tab" }),
      row("title", "Retab file"),
    ];
    expect(ids(rankDeckItems(items, "tab"))).toEqual(["title", "elsewhere"]);
  });

  it("keeps a loose subsequence match, below every contiguous one", () => {
    const items = [
      row("loose", "New terminal"),
      row("keyword", "Zoom", { searchText: "print" }),
    ];
    expect(ids(rankDeckItems(items, "nt"))).toEqual(["keyword", "loose"]);
  });

  it("lists rows that can run before disabled ones", () => {
    const items = [
      row("disabled", "Close tab", { disabled: true }),
      row("enabled", "Close all tabs in pane"),
    ];
    expect(ids(rankDeckItems(items, "close tab"))).toEqual(["enabled", "disabled"]);
  });

  it("breaks ties by title, then by id", () => {
    const items = [
      row("b", "Theme", { breadcrumb: "Settings" }),
      row("a", "Theme", { breadcrumb: "Settings" }),
      row("c", "Sheme", { searchText: "theme" }),
      row("d", "Aheme", { searchText: "theme" }),
    ];
    expect(ids(rankDeckItems(items, "theme"))).toEqual(["a", "b", "d", "c"]);
  });

  it("matches without regard to case", () => {
    expect(ids(rankDeckItems([row("a", "Close Tab")], "CLOSE tab"))).toEqual(["a"]);
  });
});

describe("fuzzyDeckScore", () => {
  it("orders a prefix, a substring, then a subsequence, and refuses the rest", () => {
    const prefix = fuzzyDeckScore("new", "New terminal");
    const substring = fuzzyDeckScore("term", "New terminal");
    const subsequence = fuzzyDeckScore("nwt", "New terminal");
    expect(prefix).not.toBeNull();
    expect(substring).not.toBeNull();
    expect(subsequence).not.toBeNull();
    expect(prefix!).toBeGreaterThan(substring!);
    expect(substring!).toBeGreaterThan(subsequence!);
    expect(fuzzyDeckScore("xyz", "New terminal")).toBeNull();
    expect(fuzzyDeckScore("  ", "New terminal")).toBe(0);
  });
});
