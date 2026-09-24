import { describe, expect, test } from "vitest";
import canvas from "../components/GraphCanvas.svelte?raw";
import kinds from "./kinds.ts?raw";

import {
  chipColorVar,
  colorVarFor,
  colorVarForBucket,
  fileBucket,
  type FileBucket,
} from "./kinds";

// The graph canvas colours file nodes by EXTENSION (a `.rs` source node
// is royalblue) while the server projects a coarser wire kind (`.rs` and
// `.txt` both ride `text`). The inspector kind bubble used to colour by
// wire kind, so a blue source node opened an orange bubble. `fileBucket`
// is the shared extension classifier both surfaces now read; these tests
// pin its buckets, the path-aware chip colour, and a parity assertion
// that the bubble var equals the canvas node-fill var for every bucket.

describe("fileBucket", () => {
  test("markdown extensions bucket as doc", () => {
    for (const p of ["note.md", "readme.txt", "a/b/c.MD", "plan.TXT"]) {
      expect(fileBucket(p)).toBe("doc");
    }
  });

  test("recognised source / config extensions bucket as source", () => {
    for (const p of [
      "lib.rs",
      "main.py",
      "app.tsx",
      "server.go",
      "Config.toml",
      "styles.css",
      "index.html",
      "data.json",
      "deploy.yaml",
      "query.sql",
    ]) {
      expect(fileBucket(p)).toBe("source");
    }
  });

  test("image + pdf extensions bucket as img (media)", () => {
    for (const p of ["photo.png", "pic.JPG", "icon.svg", "anim.gif", "shot.webp", "paper.pdf"]) {
      expect(fileBucket(p)).toBe("img");
    }
  });

  test("the rest of the server's text class buckets as source", () => {
    // FileClass::Text on the server (wire kind `text`) is one class, so
    // data, markup, build files and well-known basenames paint as source
    // beside code.
    for (const p of ["data.csv", "board.excalidraw", "notes.rst", "app.scala", "Makefile", "LICENSE"]) {
      expect(fileBucket(p)).toBe("source");
    }
  });

  test("extensions the server's classifier does not know bucket as binary", () => {
    // Unknown to FileClass, so the server sniffs their content and the
    // path alone cannot say text: `.proto`, `.graphql` and `.cs` included.
    for (const p of ["archive.zip", "font.woff2", "blob.bin", "mystery.xyz", "api.proto", "schema.graphql", "Main.cs"]) {
      expect(fileBucket(p)).toBe("binary");
    }
  });

  test("contact discriminator wins over markdown / source, but media still wins first", () => {
    expect(fileBucket("alice.md", "contact")).toBe("contact");
    expect(fileBucket("bob", "contact")).toBe("contact");
    // A contact-flagged image is still media (branch order pins this).
    expect(fileBucket("avatar.png", "contact")).toBe("img");
  });
});

describe("chipColorVar (path-aware bubble colour)", () => {
  test("file kinds with a path follow the extension bucket", () => {
    // Wire kind `text` splits by extension: source blue vs doc orange.
    expect(chipColorVar("text", "lib.rs")).toBe("var(--g-source)");
    expect(chipColorVar("text", "notes.txt")).toBe("var(--g-doc)");
    expect(chipColorVar("document", "readme.md")).toBe("var(--g-doc)");
    expect(chipColorVar("media", "photo.png")).toBe("var(--g-img)");
    expect(chipColorVar("media", "paper.pdf")).toBe("var(--g-img)");
    expect(chipColorVar("binary", "archive.zip")).toBe("var(--g-binary)");
    expect(chipColorVar("contact", "alice.md")).toBe("var(--g-contact, var(--warn-text))");
    // Excalidraw + csv: text wire kind, source node, source bubble.
    expect(chipColorVar("text", "board.excalidraw")).toBe("var(--g-source)");
    expect(chipColorVar("text", "data.csv")).toBe("var(--g-source)");
  });

  test("pending stays neutral even with a path (excluded from bucketing)", () => {
    expect(chipColorVar("pending", "weird.xyz")).toBe("var(--text-secondary)");
    expect(chipColorVar("pending", "note.md")).toBe("var(--text-secondary)");
  });

  test("non-file kinds ignore the path and keep the wire-kind colour", () => {
    expect(chipColorVar("tag", "irrelevant.md")).toBe("var(--g-tag)");
    expect(chipColorVar("mention", "irrelevant.md")).toBe("var(--g-contact, var(--warn-text))");
    expect(chipColorVar("folder", "some/dir")).toBe("var(--g-folder)");
    expect(chipColorVar("date")).toBe("var(--text-secondary)");
  });

  test("without a path, every kind falls back to colorVarFor", () => {
    for (const kind of ["document", "text", "media", "binary", "contact", "tag", "mention", "folder", "date", "pending"] as const) {
      expect(chipColorVar(kind)).toBe(colorVarFor(kind));
    }
    // The specific regression: a pathless `text` chip is still orange.
    expect(chipColorVar("text")).toBe("var(--g-doc)");
  });
});

describe("bubble / canvas node-fill parity", () => {
  // For each bucket: [bucket, canvas paint-switch source pin, canvas
  // readTheme source pin, the CSS var]. The canvas paints
  // bucket -> theme slot (paint switch) then theme slot -> CSS var
  // (readTheme); the bubble reads colorVarForBucket. If either canvas
  // side changes, its source pin breaks; if the bubble side changes,
  // the value assert breaks. The two cannot silently drift apart.
  const PARITY: Array<[FileBucket, RegExp, RegExp, string]> = [
    ["doc", /n\.kind === "doc" \? theme\.doc/, /doc: v\("--g-doc"/, "var(--g-doc)"],
    ["source", /n\.kind === "source" \? theme\.source/, /source: v\("--g-source"/, "var(--g-source)"],
    ["img", /n\.kind === "img" \? theme\.img/, /img: v\("--g-img"/, "var(--g-img)"],
    ["binary", /n\.kind === "binary" \? theme\.binary/, /binary: v\("--g-binary"/, "var(--g-binary)"],
    ["contact", /n\.kind === "contact" \? theme\.mention/, /mention: v\("--g-contact", v\("--warn-text"/, "var(--g-contact, var(--warn-text))"],
  ];

  for (const [bucket, paintPin, themePin, cssVar] of PARITY) {
    test(`${bucket}: bubble var === canvas node fill (${cssVar})`, () => {
      expect(canvas).toMatch(paintPin);
      expect(canvas).toMatch(themePin);
      expect(colorVarForBucket(bucket)).toBe(cssVar);
    });
  }
});

describe("file-class colour scheme wiring", () => {
  // Rehomed from the deleted HybridGraphConfig.test.ts (the legend
  // component it described never mounted; these pins track the canvas /
  // kinds side of the bucket scheme, not the legend). They pin the
  // wiring shape so a refactor can't silently drop the bucket split.
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

  test("fileBucket keeps no extension list of its own", () => {
    // The buckets come from classifyPath, the classifier that mirrors the
    // server's; a second list here is how the chips and the canvas drifted.
    expect(kinds).not.toMatch(/_EXT_RE\s*=/);
    expect(kinds).toMatch(/export function fileBucket\([\s\S]*?classifyPath\(path\)/);
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
