import { describe, expect, test } from "vitest";
import client from "../../api/client.ts?raw";
import types from "../../api/types.ts?raw";
import wiki from "./wiki.ts?raw";

describe("wiki file completion uses graph link targets", () => {
  test("typed API client exposes /api/link-targets with q and limit", () => {
    expect(types).toMatch(/export type LinkTarget = \{/);
    expect(client).toMatch(
      /linkTargets: \(q: string, limit = 10\) => \{[\s\S]*?new URLSearchParams\(\{ q, limit: String\(limit\) \}\)[\s\S]*?req<LinkTarget\[\]>\("GET", `\/api\/link-targets\?\$\{params\}`\)/,
    );
  });

  test("file-mode wiki bubble calls api.linkTargets instead of api.search", () => {
    expect(wiki).toMatch(/\.linkTargets\(term, SEARCH_LIMIT\)/);
    expect(wiki).not.toMatch(/\.search\(query, SEARCH_LIMIT/);
  });

  test("raw mode searches the URL basename, not the verbatim path", () => {
    // Editing an existing `[label](url)` slot: link_targets ranks on
    // basename/title, so the verbatim `../../x/y.md` matched nothing
    // ("No matches"). rawSearchTerm reduces it to the last segment so
    // the linked file surfaces and the pill is openable / re-pickable.
    expect(wiki).toMatch(/function rawSearchTerm\(q: string\): string \{/);
    // "raw" (a markdown URL slot) and "code" (an inline-code link) both fill
    // an existing slot, so basename search + file-only mode key off the
    // shared slotMode flag.
    expect(wiki).toMatch(
      /const slotMode =\s*opts\.templateMode === "raw" \|\| opts\.templateMode === "code";/,
    );
    expect(wiki).toMatch(/const term = slotMode \? rawSearchTerm\(query\) : query;/);
    // Slot mode never enters heading/block authoring modes (the `#`/`^`
    // there belong to the URL/anchor, not the picker).
    expect(wiki).toMatch(/slotMode \? \{ kind: "file" \} : classifyQuery\(/);
  });

  test("file-mode wiki bubble keeps file and heading targets", () => {
    expect(wiki).toMatch(/let fileHits: LinkTarget\[\] = \[\];/);
    expect(wiki).toMatch(/fileHits = results;/);
    expect(wiki).not.toMatch(/\.filter\(\(hit\) => hit\.kind === "File"\)/);
  });

  test("`[[` completes workspace paths (BOTH: names + paths, additive)", () => {
    // The LinkTarget wire type carries a "Path" kind alongside
    // File / Heading.
    expect(types).toMatch(/kind: "File" \| "Heading" \| "Path";/);
    // The picker renders a "Path" row leading with the full workspace
    // path so a `[[dir/sub` query surfaces path candidates.
    expect(wiki).toMatch(/else if \(t\.kind === "Path"\)/);
    expect(wiki).toMatch(/tag\.textContent = "PATH";/);
  });

  test("path candidates are synthesized CLIENT-SIDE off the file tree", () => {
    // No backend link-targets change: paths come from the existing
    // /api/fs listing (api.list), filtered + tagged "Path" here.
    expect(wiki).toMatch(/function computePathHits\(/);
    // api.list() may be formatted as a method chain (api\n.list()).
    expect(wiki).toMatch(/api\s*\.list\(\)/);
    expect(wiki).toMatch(/kind: "Path" as const,/);
    // Merged AFTER the link-target hits, deduped against same-path file
    // rows (a file matched by both name and path lists once).
    expect(wiki).toMatch(/const extras = pathHits\.filter\(/);
  });

  test("file-mode commit extracts the heading anchor and defers to fileLinkInsert", () => {
    expect(wiki).toMatch(
      /const lt = hit as LinkTarget;[\s\S]*?const anchor = lt\.kind === "Heading" \? \(lt\.anchor \?\? null\) : null;[\s\S]*?insert = fileLinkInsert\(lt\.path, anchor, raw\);/,
    );
  });

  test("fileLinkInsert emits relative markdown by default and keeps wiki links only in a wiki-mode file", () => {
    // Default (markdown-mode file): relative markdown via links.ts.
    expect(wiki).toMatch(
      /return wikiLinkToMarkdown\(\s*path,\s*undefined,\s*anchor \?\? undefined,\s*opts\.fromPath \?\? undefined,\s*\);/,
    );
    // Wiki-mode file: preserve the `[[path#anchor]]` form.
    expect(wiki).toMatch(
      /if \(fileUsesWikiLinks\) \{[\s\S]*?const ref = anchor \? `\$\{path\}#\$\{anchor\}` : path;[\s\S]*?return `\[\[\$\{ref\}\]\]`;/,
    );
    // The per-file style snapshot is a complete `[[...]]` match.
    expect(wiki).toMatch(/const fileUsesWikiLinks = WIKI_LINK_RE\.test\(/);
  });

  test("heading-mode commit relativizes the typed target via fileLinkInsert", () => {
    // The explicit `#` mode no longer emits a verbatim `[[target#anchor]]`;
    // it routes through fileLinkInsert so the on-disk link is relative
    // markdown (or wiki form in a wiki-mode file), same as a file hit.
    expect(wiki).toMatch(
      /const h = hit as HeadingHit;\s*insert = fileLinkInsert\(mode\.target, h\.anchor, raw\);/,
    );
    expect(wiki).not.toMatch(/const ref = `\$\{mode\.target\}#\$\{h\.anchor\}`;/);
  });

  test("block-mode commit emits a #^id anchor via fileLinkInsert", () => {
    // The block ref is now a `#^id` fragment routed through
    // fileLinkInsert (relative markdown / wiki form), not the old
    // unresolvable `[[target^id]]`.
    expect(wiki).toMatch(
      /const insert = fileLinkInsert\(target, `\^\$\{anchorId\}`, raw\);/,
    );
    expect(wiki).not.toMatch(/const ref = `\$\{target\}\^\$\{anchorId\}`;/);
  });
});

describe("raw-mode self-link (open the link in the slot)", () => {
  test("resolves the raw URL slot via parseInternalLink, gated on raw + file + open handler", () => {
    expect(wiki).toMatch(
      /import \{ parseInternalLink \} from "\.\.\/widgets\/wikilink";/,
    );
    expect(wiki).toMatch(
      /function selfHit\(\): SelfHit \| null \{[\s\S]*?if \(!opts\.onOpenLink\) return null;[\s\S]*?!slotMode \|\| mode\.kind !== "file"[\s\S]*?doc\.sliceString\(opts\.triggerStart, triggerEnd\)[\s\S]*?parseInternalLink\(literal, "", opts\.fromPath \?\? null\)/,
    );
    // External / anchor-only slots resolve to null -> no Self row.
    expect(wiki).toMatch(/if \(!parsed\) return null;/);
  });

  test("activeHits prepends the Self row before file + path hits", () => {
    expect(wiki).toMatch(
      /return self \? \[self, \.\.\.fileHits, \.\.\.extras\] : \[\.\.\.fileHits, \.\.\.extras\];/,
    );
  });

  test("commit routes a Self hit to onOpenLink and NEVER to fileLinkInsert (doc-corruption guard)", () => {
    expect(wiki).toMatch(
      /function commit\(hit: [^)]*SelfHit\): void \{\s*if \(isSelfHit\(hit\)\) \{[\s\S]*?opts\.onOpenLink\(hit\.target, hit\.anchor\);[\s\S]*?dismiss\(\);[\s\S]*?return;/,
    );
  });

  test("openSelected opens a Self hit before the LinkTarget cast", () => {
    expect(wiki).toMatch(
      /const hit = hits\[selectedIndex\];\s*if \(isSelfHit\(hit\)\) \{\s*opts\.onOpenLink\(hit\.target, hit\.anchor\);/,
    );
  });

  test("the selectedIndex clamp counts the full active list, not just fileHits", () => {
    expect(wiki).toMatch(
      /if \(selectedIndex >= activeHits\(\)\.length\) selectedIndex = 0;/,
    );
    expect(wiki).not.toMatch(
      /if \(selectedIndex >= fileHits\.length\) selectedIndex = 0;/,
    );
  });
});
