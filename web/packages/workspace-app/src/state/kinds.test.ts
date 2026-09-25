import { describe, expect, test } from "vitest";

import {
  chipColorVar,
  colorVarFor,
  colorVarForBucket,
  fileBucket,
} from "./kinds";

// The graph canvas colours file nodes by EXTENSION (a `.rs` source node
// is royalblue) while the server projects a coarser wire kind (`.rs` and
// `.txt` both ride `text`). `fileBucket` is the extension classifier the
// canvas and the inspector kind bubble both read, so a blue source node
// opens a blue bubble. These tests pin its buckets, the path-aware chip
// colour, and a parity assertion that the bubble var equals the canvas
// node-fill var for every bucket.

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
    // path alone cannot say text.
    for (const p of ["archive.zip", "font.woff2", "blob.bin", "mystery.xyz"]) {
      expect(fileBucket(p)).toBe("binary");
    }
  });

  test("schema and hardware sources bucket as source, and a bmp as media", () => {
    expect(fileBucket("x.cs")).toBe("source");
    expect(fileBucket("x.proto")).toBe("source");
    expect(fileBucket("schema.graphql")).toBe("source");
    expect(fileBucket("top.vhdl")).toBe("source");
    expect(fileBucket("x.bmp")).toBe("img");
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
    // A pathless `text` chip keeps the document colour.
    expect(chipColorVar("text")).toBe("var(--g-doc)");
  });
});

describe("the bucket colour", () => {
  // The inspector bubble colours a file by colorVarForBucket; the canvas
  // fills the same node from the same variable. GraphCanvas.svelte.test.ts
  // checks the fill against this mapping for every bucket.
  test("names one palette variable per bucket", () => {
    expect(colorVarForBucket("doc")).toBe("var(--g-doc)");
    expect(colorVarForBucket("source")).toBe("var(--g-source)");
    expect(colorVarForBucket("img")).toBe("var(--g-img)");
    expect(colorVarForBucket("binary")).toBe("var(--g-binary)");
    expect(colorVarForBucket("contact")).toBe("var(--g-contact, var(--warn-text))");
  });
});
