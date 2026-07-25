import { describe, expect, test } from "vitest";
import source from "./HybridGraphConfig.svelte?raw";
import canvas from "./GraphCanvas.svelte?raw";
import kinds from "../state/kinds.ts?raw";
import app from "../App.svelte?raw";
import shell from "./HybridSurfaceConfigShell.svelte?raw";

// Markdown / source / binary / media colour scheme + Hybrid Graph legend grid.
// Tests pin the wiring shape so a future refactor can't silently
// drop the bucket split or the legend swatches.
//
// The bucket classifier + its extension regexes live in the shared
// state/kinds.ts module (`fileBucket`), so the inspector kind bubble
// can match the graph node fill. The canvas imports it back and calls
// it in the working-set build; the pins below track both sides.

describe("file-class colour scheme", () => {
  test("fileBucket returns the 5 buckets (doc/img/contact/source/binary)", () => {
    expect(kinds).toMatch(
      /export function fileBucket\([\s\S]*?\): FileBucket/,
    );
    expect(kinds).toMatch(
      /export type FileBucket = "doc" \| "img" \| "contact" \| "source" \| "binary"/,
    );
  });

  test("canvas routes file nodes through the shared fileBucket", () => {
    expect(canvas).toMatch(/import \{ fileBucket \} from "\.\.\/state\/kinds"/);
    expect(canvas).toMatch(/fileBucket\(n\.path, n\.node_kind\)/);
  });

  test("markdown extension regex covers .md and .txt", () => {
    expect(kinds).toMatch(/MARKDOWN_EXT_RE = \/\\\.\(md\|txt\)\$\/i/);
  });

  test("source extension regex covers common code + config extensions", () => {
    expect(kinds).toMatch(/SOURCE_EXT_RE\s*=\s*\n?\s*\/\\\.\(rs\|py\|ts\|tsx/);
    expect(kinds).toMatch(/toml\|yaml\|yml\|json/);
  });

  test("media extension regex covers image + pdf", () => {
    expect(kinds).toMatch(/MEDIA_EXT_RE = \/\\\.\(png\|jpe\?g\|gif\|webp\|svg\|avif\|bmp\|pdf\)/);
  });

  test("fileBucket dispatches MEDIA first, then contact, then markdown, then source, else binary", () => {
    // Order matters: image extensions on a contact-flagged file
    // should still bucket as media (existing behaviour). The
    // function's branch order encodes this. Behaviour is unit-tested
    // in state/kinds.test.ts; this pins the source branch order.
    expect(kinds).toMatch(/if \(MEDIA_EXT_RE\.test\(path\)\) return "img"/);
    expect(kinds).toMatch(
      /if \(nodeKind === "contact"\) return "contact"[\s\S]*?if \(MARKDOWN_EXT_RE\.test\(path\)\) return "doc"/,
    );
    expect(kinds).toMatch(/if \(SOURCE_EXT_RE\.test\(path\)\) return "source"/);
    expect(kinds).toMatch(/return "binary"/);
  });

  test("ThemeColors carries source + binary slots", () => {
    expect(canvas).toMatch(/source: string;/);
    expect(canvas).toMatch(/binary: string;/);
  });

  test("Theme reader pulls --g-source + --g-binary from CSS", () => {
    expect(canvas).toMatch(/source: v\("--g-source",/);
    expect(canvas).toMatch(/binary: v\("--g-binary",/);
  });

  test("Canvas paint dispatches source + binary kinds to their theme slots", () => {
    expect(canvas).toMatch(/n\.kind === "source" \? theme\.source/);
    expect(canvas).toMatch(/n\.kind === "binary" \? theme\.binary/);
  });

  test("DKind union includes the new source + binary kinds", () => {
    expect(canvas).toMatch(
      /type DKind =[\s\S]*?\| "source"[\s\S]*?\| "binary"/,
    );
  });
});

describe("CSS palette", () => {
  test("dark-mode declares --g-source + --g-binary", () => {
    // Dark theme :root block ships royalblue + grey.
    expect(app).toMatch(/--g-source: #4169e1/);
    expect(app).toMatch(/--g-binary: #5e5e62/);
  });

  test("light-mode declares deeper-hue counterparts", () => {
    expect(app).toMatch(/--g-source: #2851c4/);
    expect(app).toMatch(/--g-binary: #4e4e54/);
  });

  test("folder kept distinct from binary (no visual collapse)", () => {
    // `--g-folder` stays the medium grey #8e8e93 (dark) / #6c6c70
    // (light) - distinct from `--g-binary`'s darker greys above.
    expect(app).toMatch(/--g-folder: #8e8e93/);
    expect(app).toMatch(/--g-folder: #6c6c70/);
  });
});

describe("Hybrid Graph legend grid", () => {
  test("legend renders the Files group with all 5 file kinds", () => {
    expect(source).toContain('"Markdown"');
    expect(source).toContain('"Source code"');
    expect(source).toContain('"Binary"');
    expect(source).toContain('"Media"');
    expect(source).toContain('"Contact"');
  });

  test("legend renders the Containers group with the Directory entry", () => {
    expect(source).toMatch(/title: "Containers"[\s\S]*?label: "Directory"/);
  });

  test("legend renders the Graph relations group (Hashtag / Mention / Language)", () => {
    expect(source).toMatch(/title: "Graph relations"/);
    expect(source).toContain('"Hashtag"');
    expect(source).toContain('"Mention"');
    expect(source).toContain('"Language"');
  });

  test("each legend row uses a CSS var token for the swatch background", () => {
    // The swatch background reads the central palette so light/dark +
    // per-Hybrid theme override cascade through automatically.
    expect(source).toMatch(/cssVar: "--g-doc"/);
    expect(source).toMatch(/cssVar: "--g-source"/);
    expect(source).toMatch(/cssVar: "--g-binary"/);
    expect(source).toMatch(/cssVar: "--g-img"/);
    expect(source).toMatch(/cssVar: "--g-folder"/);
    expect(source).toMatch(/cssVar: "--g-tag"/);
    expect(source).toMatch(/cssVar: "--g-language"/);
  });

  test("swatch CSS reads var() inline so the SPA theme cascade works", () => {
    expect(source).toMatch(/style="background: var\(\{row\.cssVar\}\)"/);
  });

  test("the OK button routes through onDone", () => {
    expect(source).toMatch(/let \{ onDone \}: \{ onDone\?: \(\) => void \} = \$props\(\)/);
    expect(source).toMatch(
      /<HybridSurfaceConfigShell title="Hybrid Graph" \{onDone\}>/,
    );
    expect(shell).toMatch(
      /<button type="button" class="config-ok" onclick=\{\(\) => onDone\?\.\(\)\}>OK<\/button>/,
    );
  });
});
