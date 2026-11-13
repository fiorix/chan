import { describe, expect, it } from "vitest";
import {
  fuzzyDeckScore,
  matchDeckItems,
  rankDeckItems,
  SESSION_DECK_DRAFT_KEY,
  type DeckItem,
} from "./model";

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

  it("matches a compact abbreviation of the title, below every whole hit", () => {
    const items = [
      row("terminal", "Terminal settings"),
      row("close", "Close window"),
      row("keyword", "Zoom", { searchText: "xtrmnlx" }),
    ];
    // t, r, m, n and l cover eight characters of "terminal"; ten are allowed.
    expect(ids(rankDeckItems(items, "trmnl"))).toEqual(["keyword", "terminal"]);
    // c, l, s and w cover seven characters of "close window"; eight are allowed.
    expect(ids(rankDeckItems(items, "clsw"))).toEqual(["close"]);
    expect(ids(rankDeckItems(items, "clsw trmnl")), "no row abbreviates both").toEqual([]);
  });

  it("allows an abbreviation's letters a stretch of twice its length and no more", () => {
    const items = [row("new", "New terminal"), row("spread", "The release machine")];
    // n, w, t and m cover exactly eight characters of "new terminal".
    expect(ids(rankDeckItems(items, "nwtm"))).toEqual(["new"]);
    // n to t covers five; a two-letter word is allowed four.
    expect(ids(rankDeckItems(items, "nt"))).toEqual([]);
    // "new terminal" holds term whole. In "the release machine" t, e, r and m
    // stand in order across thirteen characters, and four letters get eight.
    expect(ids(rankDeckItems(items, "term"))).toEqual(["new"]);
  });

  it("takes the tightest stretch, not the first", () => {
    // From the first t the letters cover nine characters; from the third, four.
    expect(ids(rankDeckItems([row("start", "Start terminal")], "trm"))).toEqual(["start"]);
    const items = [row("late", "Stage two trim"), row("early", "Trim stage two")];
    expect(ids(rankDeckItems(items, "trm")), "an earlier stretch of the same length leads").toEqual([
      "early",
      "late",
    ]);
  });

  it("drops a row that holds a word's letters in order only outside its title", () => {
    const items = [
      // Close together, as a title would have to hold them.
      row("near", "Window 1", { searchText: "tee room" }),
      row("crumb", "Hide window", { breadcrumb: "tee room" }),
      row("sub", "Open window", { subtitle: "tee room" }),
      // Far apart, as a path or a keyword list holds them.
      row("far", "Close window", { searchText: "/home/alex/notes the release machine geekom" }),
      row("whole", "Focus window", { searchText: "terminal" }),
    ];
    expect(ids(rankDeckItems(items, "term"))).toEqual(["whole"]);
  });

  it("matches a word of one letter only where the letter stands", () => {
    const items = [
      row("title", "Zoom"),
      row("keyword", "Alpha", { searchText: "jazz" }),
      row("none", "Split right", { searchText: "pane" }),
    ];
    expect(ids(rankDeckItems(items, "z"))).toEqual(["title", "keyword"]);
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

  it("ranks a title that is the whole query above every title that only holds its words", () => {
    const rows = [
      row("forward", "New graph"),
      row("longer", "Graph new here"),
      row("exact", "Graph new"),
    ];
    // The words match in either order, and by where they sit and how long
    // the title is `New graph` would lead a query of `graph new`.
    expect(ids(rankDeckItems(rows, "graph new"))).toEqual(["exact", "forward", "longer"]);
    expect(ids(rankDeckItems(rows, "  GRAPH   new "))[0], "case and outer space aside").toBe("exact");
    expect(ids(rankDeckItems(rows, "graph ne"))[0], "a query that is not the whole title").toBe("forward");
  });

  it("still lists a row titled as the query after the rows that can run when it cannot", () => {
    const rows = [row("exact", "Close", { disabled: true }), row("longer", "Close tab")];
    expect(ids(rankDeckItems(rows, "close"))).toEqual(["longer", "exact"]);
  });
});

describe("matchDeckItems", () => {
  const items = [
    row("abbreviation", "D-e-p-l-o-y"),
    row("other-inside", "Beta", { breadcrumb: "Redeployment" }),
    row("other-start", "Alpha", { searchText: "deploy" }),
    row("inside", "Redeploy"),
    row("start", "Deploy now"),
    row("none", "Split right"),
  ];

  it("reports the kind of hit with each match, best first", () => {
    expect(matchDeckItems(items, "deploy").map((match) => [match.item.id, match.kind])).toEqual([
      ["start", 4],
      ["inside", 3],
      ["other-start", 2],
      ["other-inside", 1],
      ["abbreviation", 0],
    ]);
  });

  it("sums the kinds over the words of the query", () => {
    const two = [
      row("both", "Close window"),
      row("split", "Close tab", { searchText: "window" }),
      row("loose", "Reclose", { subtitle: "the windows" }),
    ];
    expect(matchDeckItems(two, "window close").map((match) => [match.item.id, match.kind])).toEqual([
      ["both", 8],
      ["split", 6],
      ["loose", 5],
    ]);
  });

  it("puts a title that is the whole query in a kind of its own, above every other", () => {
    const rows = [row("exact", "Close window"), row("longer", "Close window 2"), row("one", "Close")];
    expect(matchDeckItems(rows, " close WINDOW ").map((match) => [match.item.id, match.kind])).toEqual([
      ["exact", 10],
      ["longer", 8],
    ]);
    expect(matchDeckItems(rows, "close").map((match) => [match.item.id, match.kind])).toEqual([
      ["one", 5],
      ["exact", 4],
      ["longer", 4],
    ]);
  });

  it("orders by a score that falls with the kind, and hands back the rows it was given", () => {
    const matches = matchDeckItems(items, "deploy");
    const scores = matches.map((match) => match.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(new Set(scores).size).toBe(scores.length);
    expect(matches.map((match) => match.item)).toEqual(rankDeckItems(items, "deploy"));
    expect(matches[0]!.item, "the row itself, not a copy").toBe(items[4]);
  });

  it("matches every row of an empty query, as given", () => {
    expect(matchDeckItems(items, " ")).toEqual(items.map((item) => ({ item, kind: 0, score: 0 })));
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
