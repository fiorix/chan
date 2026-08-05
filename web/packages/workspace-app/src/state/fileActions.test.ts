import { describe, expect, test } from "vitest";

import {
  classifyFileActions,
  fileMediaKind,
  type FileActionCapabilities,
  type FileActionFacts,
} from "./fileActions";

// Table-driven pins for the shared file-action policy. Both the
// inspector and the file browser context menu consume
// classifyFileActions, so these tables ARE the parity contract:
// applicability per path/type/content fact, capability omissions, the
// draft exclusion, and the guarantee that no destructive action ever
// appears.

const ALL_CAPS: Required<FileActionCapabilities> = {
  open: true,
  reveal: true,
  graph: true,
  upload: true,
};

function facts(partial: Partial<FileActionFacts> & { path: string }): FileActionFacts {
  return { isDir: false, isDraft: false, ...partial };
}

describe("classifyFileActions per-type tables", () => {
  const cases: Array<{
    name: string;
    facts: FileActionFacts;
    main: string;
    secondary: string[];
  }> = [
    {
      name: "directory",
      facts: facts({ path: "docs", isDir: true }),
      main: "open",
      secondary: ["upload", "download", "newTerminal", "graphFromHere"],
    },
    {
      name: "workspace root directory",
      facts: facts({ path: "", isDir: true }),
      main: "open",
      secondary: ["upload", "download", "newTerminal", "graphFromHere"],
    },
    {
      name: "markdown document",
      facts: facts({ path: "notes/a.md", serverKind: "document" }),
      main: "open",
      secondary: ["showFile", "download", "newTerminal", "exportPdf", "graphFromHere"],
    },
    {
      name: "markdown slide deck",
      facts: facts({ path: "talks/roadmap.slides.md", serverKind: "document" }),
      main: "open",
      secondary: ["showFile", "download", "newTerminal", "exportPdf", "graphFromHere"],
    },
    {
      name: "excalidraw diagram (editable text, no PDF export)",
      facts: facts({ path: "sketches/arch.excalidraw", serverKind: "text" }),
      main: "open",
      secondary: ["showFile", "download", "newTerminal", "graphFromHere"],
    },
    {
      name: "ordinary source file",
      facts: facts({ path: "src/main.rs", serverKind: "text" }),
      main: "open",
      secondary: ["showFile", "download", "newTerminal", "graphFromHere"],
    },
    {
      name: "odd-suffix plaintext sniffed text by the server",
      facts: facts({ path: "data/BUILD.bazel", serverKind: "text" }),
      main: "open",
      secondary: ["showFile", "download", "newTerminal", "graphFromHere"],
    },
    {
      name: "same odd suffix without a server kind falls back to binary",
      facts: facts({ path: "data/BUILD.bazel" }),
      main: "download",
      secondary: ["graphFromHere"],
    },
    {
      name: "image",
      facts: facts({ path: "pics/cat.png", serverKind: "media" }),
      main: "viewMedia",
      secondary: ["download", "newTerminal", "graphFromHere"],
    },
    {
      name: "PDF",
      facts: facts({ path: "papers/paper.pdf", serverKind: "media" }),
      main: "viewMedia",
      secondary: ["download", "newTerminal", "graphFromHere"],
    },
    {
      name: "video (binary wire kind)",
      facts: facts({ path: "clips/demo.mp4", serverKind: "binary" }),
      main: "viewMedia",
      secondary: ["download", "newTerminal", "graphFromHere"],
    },
    {
      name: "audio (binary wire kind)",
      facts: facts({ path: "music/track.mp3", serverKind: "binary" }),
      main: "viewMedia",
      secondary: ["download", "newTerminal", "graphFromHere"],
    },
    {
      name: "binary archive",
      facts: facts({ path: "dist/bundle.zip", serverKind: "binary" }),
      main: "download",
      secondary: ["graphFromHere"],
    },
    {
      name: "extension-less binary",
      facts: facts({ path: "bin/tool", serverKind: "binary" }),
      main: "download",
      secondary: ["graphFromHere"],
    },
    {
      name: "drafts directory",
      facts: facts({ path: ".Drafts", isDir: true, isDraft: true }),
      main: "newTerminal",
      secondary: [],
    },
    {
      name: "draft file",
      facts: facts({ path: ".Drafts/draft-1/draft.md", isDraft: true }),
      main: "newTerminal",
      secondary: [],
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      expect(classifyFileActions(c.facts, ALL_CAPS)).toEqual({
        main: c.main,
        secondary: c.secondary,
      });
    });
  }
});

describe("classifyFileActions capability omissions", () => {
  const md = facts({ path: "notes/a.md", serverKind: "document" });

  test("no open handler: reveal becomes main", () => {
    expect(classifyFileActions(md, { ...ALL_CAPS, open: false })).toEqual({
      main: "showFile",
      secondary: ["download", "newTerminal", "exportPdf", "graphFromHere"],
    });
  });

  test("neither open nor reveal: download becomes main and never repeats", () => {
    expect(classifyFileActions(md, { ...ALL_CAPS, open: false, reveal: false })).toEqual({
      main: "download",
      secondary: ["newTerminal", "exportPdf", "graphFromHere"],
    });
  });

  test("open without reveal drops the showFile secondary", () => {
    expect(classifyFileActions(md, { ...ALL_CAPS, reveal: false })).toEqual({
      main: "open",
      secondary: ["download", "newTerminal", "exportPdf", "graphFromHere"],
    });
  });

  test("no graph handler drops graphFromHere on every category", () => {
    const caps = { ...ALL_CAPS, graph: false };
    const samples = [
      facts({ path: "docs", isDir: true }),
      facts({ path: "pics/cat.png", serverKind: "media" }),
      md,
      facts({ path: "dist/bundle.zip", serverKind: "binary" }),
    ];
    for (const f of samples) {
      const set = classifyFileActions(f, caps);
      expect(set.main).not.toBe("graphFromHere");
      expect(set.secondary).not.toContain("graphFromHere");
    }
  });

  test("uploads disallowed drop the directory upload row only", () => {
    const set = classifyFileActions(facts({ path: "docs", isDir: true }), {
      ...ALL_CAPS,
      upload: false,
    });
    expect(set).toEqual({
      main: "open",
      secondary: ["download", "newTerminal", "graphFromHere"],
    });
  });

  test("main never repeats inside secondary", () => {
    const samples = [
      facts({ path: "docs", isDir: true }),
      facts({ path: "pics/cat.png", serverKind: "media" }),
      md,
      facts({ path: "dist/bundle.zip", serverKind: "binary" }),
      facts({ path: ".Drafts", isDir: true, isDraft: true }),
    ];
    for (const f of samples) {
      const set = classifyFileActions(f, ALL_CAPS);
      expect(set.secondary).not.toContain(set.main);
      expect(new Set(set.secondary).size).toBe(set.secondary.length);
    }
  });
});

describe("classifyFileActions destructive separation", () => {
  test("the policy cannot emit destructive or path-mutation actions", () => {
    const banned = ["delete", "remove", "rename", "copyPath", "move"];
    const samples: FileActionFacts[] = [
      facts({ path: "docs", isDir: true }),
      facts({ path: "notes/a.md", serverKind: "document" }),
      facts({ path: "pics/cat.png", serverKind: "media" }),
      facts({ path: "dist/bundle.zip", serverKind: "binary" }),
      facts({ path: ".Drafts/draft-1/draft.md", isDraft: true }),
    ];
    for (const f of samples) {
      const { main, secondary } = classifyFileActions(f, ALL_CAPS);
      for (const id of [main, ...secondary]) {
        expect(banned).not.toContain(id);
      }
    }
  });
});

describe("fileMediaKind", () => {
  test("discriminates the four media families by path", () => {
    expect(fileMediaKind("a.png")).toBe("image");
    expect(fileMediaKind("a.pdf")).toBe("pdf");
    expect(fileMediaKind("a.mp4")).toBe("video");
    expect(fileMediaKind("a.mp3")).toBe("audio");
    expect(fileMediaKind("a.md")).toBeNull();
    expect(fileMediaKind("a.zip")).toBeNull();
  });
});
