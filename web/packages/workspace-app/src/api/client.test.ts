// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from "vitest";
import {
  api,
  clientNonce,
  dragScopeMimeToken,
  filesMutationSuffix,
  sessionPath,
  sessionWindowId,
  windowDragScope,
  windowLibraryId,
} from "./client";

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
  window.sessionStorage.clear();
});

describe("files-mode request markers", () => {
  test("mutations carry the writing window, and nothing outside a files window", () => {
    window.history.replaceState(null, "", "/?t=token&w=w-files&kind=files");
    expect(filesMutationSuffix(false)).toBe("?w=w-files");
    expect(filesMutationSuffix(true)).toBe("&w=w-files");
    // The upload path serves two contracts, so it also names the app.
    expect(filesMutationSuffix(false, { app: true })).toBe("?app=files&w=w-files");

    // A workspace window and a standalone terminal add nothing: their
    // routes have one contract each and their own echo suppression.
    window.history.replaceState(null, "", "/?t=token&w=w-ws");
    expect(filesMutationSuffix(false, { app: true })).toBe("");
    window.history.replaceState(null, "", "/?t=token&w=w-term&kind=terminal");
    expect(filesMutationSuffix(false)).toBe("");
  });

  test("the session blob is namespaced only in a files window", () => {
    window.history.replaceState(null, "", "/?t=token&w=w-files&kind=files");
    expect(sessionPath()).toBe(
      `/api/session?w=w-files&client=${clientNonce()}&app=files`,
    );
    window.history.replaceState(null, "", "/?t=token&w=w-term&kind=terminal");
    expect(sessionPath()).toBe(`/api/session?w=w-term&client=${clientNonce()}`);
  });
});

describe("sessionWindowId", () => {
  test("uses per-tab sessionStorage without a window id", () => {
    window.history.replaceState(null, "", "/?t=token");

    window.sessionStorage.setItem("chan.session.window", "tab-a1b2c3d4");

    expect(sessionWindowId()).toBe("tab-a1b2c3d4");
    expect(sessionPath()).toBe(`/api/session?w=tab-a1b2c3d4&client=${clientNonce()}`);
  });

  test("generates and reuses a per-tab sessionStorage id", () => {
    window.history.replaceState(null, "", "/?t=token");

    const first = sessionWindowId();
    const second = sessionWindowId();

    expect(first).toMatch(/^[0-9a-f]{8}$/);
    expect(second).toBe(first);
  });

  test("uses the chan-desktop window id from the URL", () => {
    window.history.replaceState(null, "", "/?t=token&w=workspace-notes-7");

    expect(sessionWindowId()).toBe("workspace-notes-7");
    expect(sessionPath()).toBe(`/api/session?w=workspace-notes-7&client=${clientNonce()}`);
  });

  test("encodes unusual window labels before calling the session API", () => {
    window.history.replaceState(null, "", "/?w=tunnel%20a/workspace%201");

    expect(sessionWindowId()).toBe("tunnel a/workspace 1");
    expect(sessionPath()).toBe(
      `/api/session?w=tunnel%20a%2Fworkspace%201&client=${clientNonce()}`,
    );
  });
});

describe("clientNonce", () => {
  test("is stable across calls within one SPA instance", () => {
    expect(clientNonce()).toBe(clientNonce());
    expect(clientNonce().length).toBeGreaterThan(0);
  });

  test("rides every session-blob request so the server can echo the writer", () => {
    window.history.replaceState(null, "", "/?w=w-1");
    const url = new URLSearchParams(sessionPath().split("?")[1]);
    expect(url.get("client")).toBe(clientNonce());
    expect(url.get("w")).toBe("w-1");
  });
});

describe("windowLibraryId", () => {
  test("reads the chan-library id from the ?lib= URL param", () => {
    window.history.replaceState(null, "", "/?t=token&lib=lib-abc123");
    expect(windowLibraryId()).toBe("lib-abc123");
  });

  test("defaults to local when ?lib= is absent", () => {
    window.history.replaceState(null, "", "/?t=token");
    expect(windowLibraryId()).toBe("local");
  });

  test("defaults to local when ?lib= is blank", () => {
    window.history.replaceState(null, "", "/?lib=%20%20");
    expect(windowLibraryId()).toBe("local");
  });
});

describe("windowDragScope", () => {
  test("a workspace window scopes on its library + stable workspace identity", () => {
    expect(
      windowDragScope({ libraryId: "local", terminalOnly: false, files: false, workspaceKey: "wk-deadbeef" }),
    ).toBe("lib:local|workspace:wk-deadbeef");
  });

  test("a terminal window scopes on its library", () => {
    expect(
      windowDragScope({ libraryId: "local", terminalOnly: true, files: false, workspaceKey: null }),
    ).toBe("lib:local|terminal");
    expect(
      windowDragScope({ libraryId: "lib-abc123", terminalOnly: true, files: false, workspaceKey: null }),
    ).toBe("lib:lib-abc123|terminal");
  });

  test("two windows of the SAME workspace in the SAME library get the SAME scope", () => {
    // The two windows have different `?w=` ids but the same library + workspace.
    const win1 = windowDragScope({
      libraryId: "local",
      terminalOnly: false,
      files: false,
      workspaceKey: "wk-deadbeef",
    });
    const win2 = windowDragScope({
      libraryId: "local",
      terminalOnly: false,
      files: false,
      workspaceKey: "wk-deadbeef",
    });
    expect(win1).toBe(win2);
  });

  test("different workspaces in the same library get DIFFERENT scopes", () => {
    const a = windowDragScope({ libraryId: "local", terminalOnly: false, files: false, workspaceKey: "wk-aaaa" });
    const b = windowDragScope({ libraryId: "local", terminalOnly: false, files: false, workspaceKey: "wk-bbbb" });
    expect(a).not.toBe(b);
  });

  test("terminal↔workspace in the same library get DISTINCT scopes", () => {
    const term = windowDragScope({ libraryId: "local", terminalOnly: true, files: false, workspaceKey: null });
    const ws = windowDragScope({
      libraryId: "local",
      terminalOnly: false,
      files: false,
      workspaceKey: "wk-deadbeef",
    });
    expect(term).not.toBe(ws);
  });

  test("a workspace window with no identity falls back to a stable sentinel", () => {
    expect(
      windowDragScope({ libraryId: "local", terminalOnly: false, files: false, workspaceKey: null }),
    ).toBe("lib:local|workspace:unknown");
  });

  // Rule 1: a standalone terminal accepts a dropped tab only from a terminal in
  // the SAME chan-library.
  test("terminals in the SAME library match; in DIFFERENT libraries do NOT", () => {
    const a1 = windowDragScope({ libraryId: "local", terminalOnly: true, files: false, workspaceKey: null });
    const a2 = windowDragScope({ libraryId: "local", terminalOnly: true, files: false, workspaceKey: null });
    const b = windowDragScope({ libraryId: "lib-remote", terminalOnly: true, files: false, workspaceKey: null });
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
  });

  // Rule 2: a workspace tab is accepted only within the SAME workspace AND the
  // SAME chan-library. Differing EITHER dimension must not match -- including the
  // collision case where the workspace_key is identical but the library differs.
  test("workspaces match only on the same (library_id, workspace_key) pair", () => {
    const localA = windowDragScope({
      libraryId: "local",
      terminalOnly: false,
      files: false,
      workspaceKey: "wk-same",
    });
    const localAgain = windowDragScope({
      libraryId: "local",
      terminalOnly: false,
      files: false,
      workspaceKey: "wk-same",
    });
    const localOther = windowDragScope({
      libraryId: "local",
      terminalOnly: false,
      files: false,
      workspaceKey: "wk-other",
    });
    // Same key, DIFFERENT library: the collision case that must NOT match.
    const remoteSameKey = windowDragScope({
      libraryId: "lib-remote",
      terminalOnly: false,
      files: false,
      workspaceKey: "wk-same",
    });

    expect(localA).toBe(localAgain);
    expect(localA).not.toBe(localOther);
    expect(localA).not.toBe(remoteSameKey);
  });
});

describe("dragScopeMimeToken", () => {
  // The drag scope rides a DataTransfer MIME TYPE so it is readable at dragover.
  // The human-readable scope carries `:` and `|`, which WKWebView mangles in a
  // MIME type so the stamped type does not return byte-identically through
  // `dataTransfer.types` -- that broke the equality check for EVERY drop,
  // intra-window pane moves included. The token must encode to a MIME-safe
  // alphabet so the round-trip is byte-stable.

  test("strips the characters that break the MIME round-trip", () => {
    // The source string has the offending chars; the token must not.
    const scope = windowDragScope({
      libraryId: "local",
      terminalOnly: false,
      files: false,
      workspaceKey: "wk-deadbeef",
    });
    expect(scope).toMatch(/[:|]/);
    expect(dragScopeMimeToken(scope)).not.toMatch(/[:|]/);
  });

  test("emits only lowercase hex (survives WKWebView type normalization)", () => {
    // Lowercase `[0-9a-f]` is immune to the ASCII-lowercasing + token mangling a
    // DataTransfer type undergoes, so the stamped and recomputed tokens match.
    for (const scope of [
      "lib:local|terminal",
      "lib:lib-abc123|terminal",
      "lib:local|workspace:wk-deadbeef",
      // An absolute-root workspace key with `/` and mixed case -- the latent
      // hazard the `|` tipped over.
      "lib:local|workspace:/Users/x/My Notes",
    ]) {
      expect(dragScopeMimeToken(scope)).toMatch(/^[0-9a-f]+$/);
    }
  });

  test("is deterministic: the same scope encodes byte-for-byte identically", () => {
    const scope = "lib:local|workspace:wk-deadbeef";
    expect(dragScopeMimeToken(scope)).toBe(dragScopeMimeToken(scope));
  });

  test("is collision-free: different scopes encode to different tokens", () => {
    const a = dragScopeMimeToken("lib:local|terminal");
    const b = dragScopeMimeToken("lib:local|workspace:wk-deadbeef");
    const c = dragScopeMimeToken("lib:remote|terminal");
    expect(new Set([a, b, c]).size).toBe(3);
  });

  test("preserves the library-aware accept/reject matrix as a MIME type", () => {
    // Compose the scope + token exactly as Pane.svelte's scopeMime does, so the
    // matrix is asserted on the actual string a target compares at dragover.
    const SCOPE_DRAG_MIME_PREFIX = "application/x-chan-tab-scope+";
    const mime = (s: {
      libraryId: string;
      terminalOnly: boolean;
      files: boolean;
      workspaceKey: string | null;
    }): string => SCOPE_DRAG_MIME_PREFIX + dragScopeMimeToken(windowDragScope(s));

    const localTermA = mime({ libraryId: "local", terminalOnly: true, files: false, workspaceKey: null });
    const localTermB = mime({ libraryId: "local", terminalOnly: true, files: false, workspaceKey: null });
    const remoteTerm = mime({ libraryId: "lib-remote", terminalOnly: true, files: false, workspaceKey: null });
    const localWsA = mime({ libraryId: "local", terminalOnly: false, files: false, workspaceKey: "wk-same" });
    const localWsAgain = mime({ libraryId: "local", terminalOnly: false, files: false, workspaceKey: "wk-same" });
    const localWsOther = mime({ libraryId: "local", terminalOnly: false, files: false, workspaceKey: "wk-other" });
    // Files windows partition their own same-library scope.
    const localFilesA = mime({ libraryId: "local", terminalOnly: false, files: true, workspaceKey: null });
    const localFilesB = mime({ libraryId: "local", terminalOnly: false, files: true, workspaceKey: null });
    const remoteFiles = mime({ libraryId: "lib-remote", terminalOnly: false, files: true, workspaceKey: null });
    expect(localFilesA).toBe(localFilesB);
    expect(localFilesA).not.toBe(remoteFiles);
    expect(localFilesA).not.toBe(localTermA);
    expect(localFilesA).not.toBe(localWsA);
    const remoteWsSameKey = mime({
      libraryId: "lib-remote",
      terminalOnly: false,
      files: false,
      workspaceKey: "wk-same",
    });

    // Intra-window / same-(library, kind, workspace): ALWAYS allowed (the bug).
    expect(localTermA).toBe(localTermB);
    expect(localWsA).toBe(localWsAgain);
    // Cross-library: rejected.
    expect(localTermA).not.toBe(remoteTerm);
    // Same workspace key, DIFFERENT library -- the collision case: rejected.
    expect(localWsA).not.toBe(remoteWsSameKey);
    // Different workspace: rejected.
    expect(localWsA).not.toBe(localWsOther);
    // Terminal <-> workspace: rejected.
    expect(localTermA).not.toBe(localWsA);
    // Every accepted MIME type is itself a MIME-safe string.
    for (const m of [localTermA, localWsA]) {
      expect(m).toMatch(/^application\/x-chan-tab-scope\+[0-9a-f]+$/);
    }
  });
});

describe("file read streaming", () => {
  test("parses meta, chunks, progress, and done from NDJSON", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        controller.enqueue(enc.encode(
          [
            '{"type":"meta","path":"CHANGELOG.md","size":10,"mtime":1,"mtime_ns":"100","writable":true}',
            '{"type":"chunk","content":"hello","bytes":5}',
            '{"type":"chunk","content":"world","bytes":5}',
            '{"type":"done"}',
            "",
          ].join("\n"),
        ));
        controller.close();
      },
    });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(body, { status: 200 }));
    const chunks: Array<{ chunk: string; loaded: number; total: number | null }> = [];

    const file = await api.readStream("CHANGELOG.md", {
      onChunk(chunk, progress) {
        chunks.push({
          chunk,
          loaded: progress.loadedBytes,
          total: progress.totalBytes,
        });
      },
    });

    expect(fetchMock.mock.calls[0][0]).toContain("/api/files/CHANGELOG.md?stream=1");
    expect(file.content).toBe("helloworld");
    expect(file.mtime_ns).toBe("100");
    expect(chunks).toEqual([
      { chunk: "hello", loaded: 5, total: 10 },
      { chunk: "world", loaded: 10, total: 10 },
    ]);
  });

  test("turns stream error events into ApiError failures", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          '{"type":"meta","path":"a.md","size":1,"mtime":1}\n{"type":"error","error":"bad read"}\n',
        ));
        controller.close();
      },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body, { status: 200 }));

    await expect(api.readStream("a.md")).rejects.toThrow("bad read");
  });
});

describe("raw file writes", () => {
  test("posts explicit live-session conflict resolution choices", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          path: "notes/a.md",
          content: "disk\n",
          mtime: 2,
          mtime_ns: "200",
          authority_version: 8,
          disk_conflicted: false,
          writable: true,
        }),
        { status: 200 },
      ),
    );

    const result = await api.resolveSessionConflict("notes/a.md", "reload");

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/api/session-conflicts/resolve");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      path: "notes/a.md",
      action: "reload",
    });
    expect(result.content).toBe("disk\n");
  });

  test("sends text directly with disk and authority preconditions in the query", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          mtime: 2,
          mtime_ns: "200",
          authority_version: 8,
          disk_conflicted: false,
        }),
        { status: 200 },
      ),
    );

    const result = await api.write("notes/a b.md", "raw\ntext", "100", null, 7);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain(
      "/api/files/notes/a%20b.md?expected_mtime_ns=100&authority_version=7",
    );
    expect(init?.method).toBe("PUT");
    expect(init?.body).toBe("raw\ntext");
    expect(new Headers(init?.headers).get("content-type")).toBe(
      "text/plain; charset=utf-8",
    );
    expect(result.authority_version).toBe(8);
  });

  test("preserves structured conflict metadata on ApiError", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          current_mtime_ns: "300",
          current_authority_version: 9,
          disk_conflicted: false,
        }),
        { status: 409 },
      ),
    );

    await expect(api.write("a.md", "changed", "100", null, 7)).rejects.toMatchObject({
      status: 409,
      data: {
        current_mtime_ns: "300",
        current_authority_version: 9,
      },
    });
  });
});

describe("relationship streaming", () => {
  test("parses report file stream events", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          [
            '{"type":"meta","path":"CHANGELOG.md"}',
            '{"type":"report","stats":{"language":"Markdown","code":10,"comments":0,"blanks":2,"complexity":0}}',
            '{"type":"done"}',
            "",
          ].join("\n"),
        ));
        controller.close();
      },
    });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(body, { status: 200 }));
    const seen: string[] = [];

    const report = await api.reportFileStream("CHANGELOG.md", {
      onReport(stats) {
        seen.push(stats.language);
      },
    });

    expect(fetchMock.mock.calls[0][0]).toContain(
      "/api/report/file?path=CHANGELOG.md&stream=1",
    );
    expect(report?.language).toBe("Markdown");
    expect(seen).toEqual(["Markdown"]);
  });

  test("parses backlinks stream edges as they arrive", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          [
            '{"type":"meta","path":"b.md"}',
            '{"type":"edge","edge":{"src":"a.md","dst":"b.md","kind":"link","anchor":null}}',
            '{"type":"done"}',
            "",
          ].join("\n"),
        ));
        controller.close();
      },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body, { status: 200 }));
    const edges: string[] = [];

    const result = await api.backlinksStream("b.md", {
      onEdge(edge) {
        edges.push(edge.src);
      },
    });

    expect(result).toHaveLength(1);
    expect(edges).toEqual(["a.md"]);
  });

  test("parses graph stream batches with node upserts and edge dedupe", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          [
            '{"type":"meta","scope":"file","path":"a.md","depth":1}',
            '{"type":"nodes","nodes":[{"kind":"file","id":"file:a.md","label":"a.md","path":"a.md"}]}',
            '{"type":"nodes","nodes":[{"kind":"file","id":"file:a.md","label":"A","path":"a.md"}]}',
            '{"type":"edges","edges":[{"source":"file:a.md","target":"tag:x","kind":"tag","rank":1}]}',
            '{"type":"edges","edges":[{"source":"file:a.md","target":"tag:x","kind":"tag","rank":1}]}',
            '{"type":"done"}',
            "",
          ].join("\n"),
        ));
        controller.close();
      },
    });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(body, { status: 200 }));
    const partialNodeCounts: number[] = [];

    const graph = await api.graphStream(
      { scope: "file", path: "a.md", depth: 1 },
      {
        onNodes(_nodes, view) {
          partialNodeCounts.push(view.nodes.length);
        },
      },
    );

    expect(fetchMock.mock.calls[0][0]).toContain(
      "/api/graph?scope=file&path=a.md&depth=1&stream=1",
    );
    expect(graph.nodes).toEqual([
      { kind: "file", id: "file:a.md", label: "A", path: "a.md" },
    ]);
    expect(graph.edges).toHaveLength(1);
    expect(partialNodeCounts).toEqual([1, 1]);
  });
});

describe("workspace recovery readiness", () => {
  test("index status projects recovery from the readiness state without progress fields", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          state: "idle",
          indexed_docs: 42,
          indexed_vectors: 42,
          model: "bm25",
          readiness: { state: "recovering" },
        }),
        { status: 200 },
      ),
    );

    await expect(api.indexStatus()).resolves.toEqual({
      state: "recovering",
      readiness: { state: "recovering" },
    });
  });

  test("content search refuses fresh-looking hits when readiness says recovering", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          ready: true,
          mode: "bm25",
          hits: [
            {
              path: "stale.md",
              chunk_id: "stale.md:1",
              heading: "",
              start_line: 1,
              snippet: "stale",
              score: 1,
            },
          ],
          readiness: { state: "recovering" },
        }),
        { status: 200 },
      ),
    );

    await expect(api.searchContent("stale")).resolves.toMatchObject({
      ready: false,
      hits: [],
      readiness: { state: "recovering" },
    });
  });

  test("legacy search ready=false does not override a ready workspace", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          ready: false,
          mode: "bm25",
          hits: [
            {
              path: "available.md",
              chunk_id: "available.md:1",
              heading: "",
              start_line: 1,
              snippet: "available",
              score: 1,
            },
          ],
          readiness: { state: "ready" },
        }),
        { status: 200 },
      ),
    );

    await expect(api.searchContent("available")).resolves.toMatchObject({
      ready: false,
      hits: [{ path: "available.md" }],
      readiness: { state: "ready" },
    });
  });
});
