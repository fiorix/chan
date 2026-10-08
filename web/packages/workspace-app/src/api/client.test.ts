// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from "vitest";
import {
  api,
  clientNonce,
  dragScopeMimeToken,
  filesMutationSuffix,
  fileUrl,
  openWatchSocket,
  sessionPath,
  sessionWindowId,
  windowDragScope,
  windowLibraryId,
  withTokenQuery,
} from "./client";
import { json, recordRequests, stopRecordingRequests } from "../__tests__/fetch";
import { apiErrorCode } from "./errors";
import { draftClientPath } from "./fileIdentity";
import { setSocketFactory, WS_RECONNECT_BACKOFF_MIN_MS } from "./transport";

afterEach(() => {
  setSocketFactory(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.head.querySelector('meta[name="chan-files"]')?.remove();
  window.history.replaceState(null, "", "/");
  window.sessionStorage.clear();
});

describe("standalone filesystem request markers", () => {
  /// The served shell's own declaration that this tenant mounted a
  /// filesystem. The api layer reads the document, not the state modules,
  /// so the tests set it the same way chan-server injects it.
  function serveFiles(on: boolean): void {
    document.head.querySelector('meta[name="chan-files"]')?.remove();
    if (!on) return;
    const meta = document.createElement("meta");
    meta.setAttribute("name", "chan-files");
    meta.setAttribute("content", "1");
    document.head.appendChild(meta);
  }

  test("mutations carry the writing window: with the Files marker on the standalone surface, alone in a workspace, and nothing where the tenant serves no files", () => {
    serveFiles(true);
    window.history.replaceState(null, "", "/?t=token&w=w-term&kind=terminal");
    expect(filesMutationSuffix(false)).toBe("?w=w-term");
    expect(filesMutationSuffix(true)).toBe("&w=w-term");
    // The upload path serves two contracts, so it also names the app.
    expect(filesMutationSuffix(false, { app: true })).toBe("?app=files&w=w-term");

    // A workspace window names the writer alone.
    window.history.replaceState(null, "", "/?t=token&w=w-ws");
    expect(filesMutationSuffix(false)).toBe("?w=w-ws");
    expect(filesMutationSuffix(true)).toBe("&w=w-ws");
    expect(filesMutationSuffix(false, { app: true })).toBe("?w=w-ws");

    window.history.replaceState(null, "", "/?t=token&w=w-ws&kind=");
    expect(filesMutationSuffix(false), "an empty kind is a workspace window").toBe("?w=w-ws");

    // A standalone window with no filesystem route carries no marker:
    // there is no such route to call in the first place.
    serveFiles(false);
    window.history.replaceState(null, "", "/?t=token&w=w-term&kind=terminal");
    expect(filesMutationSuffix(false)).toBe("");

    window.history.replaceState(null, "", "/?t=token&w=w-ctl&kind=control");
    expect(filesMutationSuffix(false)).toBe("");
  });

  test("each call of a workspace window that creates, moves or deletes an entry names the window, and no app", async () => {
    window.history.replaceState(null, "", "/?t=token&w=w-ws");
    const requests = recordRequests(() => json({}));
    try {
      await api.create("notes/n.md", false, "");
      await api.remove("notes/n.md");
      await api.move("notes/a.md", "notes/b.md");
      await api.fsTransfer("move", ["notes/a.md"], "inbox");
      await api.createDraft();
      await api.createDiagram();
      await api.discardDraft(".Drafts/x/draft.md");
      await api.promoteDraft(".Drafts/x/draft.md", "notes/x.md");
      await api.uploadAttachment(new File(["x"], "a.png"), "notes");
      const labels = [
        "create", "remove", "move", "transfer", "draft", "diagram",
        "discard", "promote", "attachment",
      ];
      expect(requests).toHaveLength(labels.length);
      for (const [index, label] of labels.entries()) {
        expect(requests[index].query.get("w"), label).toBe("w-ws");
        expect(requests[index].query.has("app"), label).toBe(false);
      }
    } finally {
      stopRecordingRequests();
    }
  });

  test("the session blob is namespaced when the window can hold file tabs", () => {
    serveFiles(true);
    window.history.replaceState(null, "", "/?t=token&w=w-term&kind=terminal");
    expect(sessionPath()).toBe(
      `/api/session?w=w-term&client=${clientNonce()}&app=files`,
    );
    // Same window id against a host that serves no filesystem: the plain
    // namespace, so a layout of browser tabs can never come back into a
    // window with no routes behind them.
    serveFiles(false);
    expect(sessionPath()).toBe(`/api/session?w=w-term&client=${clientNonce()}`);
  });
});

describe("fileUrl", () => {
  test.each([
    "photo.png",
    "notes/a b.png",
    "notes/a#b.png",
    "notes/a?b=c&d.png",
    "notes/100%.png",
    "notes/caf\u00e9/\u65e5\u672c\u8a9e.png",
    "a/b/c/d e.pdf",
  ])("is the files route for %j, with the token query", (path) => {
    expect(fileUrl(path)).toBe(withTokenQuery(`/api/fs/${encodeURIComponent(path).replace(/%2F/g, "/")}`));
  });

  test("encodes each segment and keeps the separators", () => {
    expect(fileUrl("media/my tone #1.WAV")).toBe(withTokenQuery("/api/fs/media/my%20tone%20%231.WAV"));
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

describe("the watch socket's window id and holder tag", () => {
  /// A socket that records the URL it dialed and can be dropped by its far end.
  class DialedSocket {
    readyState = 0;
    onopen: (() => void) | null = null;
    onmessage: ((m: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(readonly url: string) {}
    send(): void {}
    close(): void {
      this.readyState = 3;
      this.onclose?.();
    }
  }

  function recordDials(install = setSocketFactory): DialedSocket[] {
    const dialed: DialedSocket[] = [];
    install((url) => {
      const socket = new DialedSocket(url);
      dialed.push(socket);
      return socket as unknown as WebSocket;
    });
    return dialed;
  }

  function query(socket: DialedSocket): URLSearchParams {
    const url = new URL(socket.url);
    expect(url.pathname).toBe("/ws");
    return url.searchParams;
  }

  test("dials with the id and the tag of the page's URL, and redials with both", () => {
    vi.useFakeTimers();
    window.history.replaceState(null, "", "/?t=token&w=w-1&h=tag_1");
    const dialed = recordDials();

    const watch = openWatchSocket(() => {});

    expect(dialed).toHaveLength(1);
    expect(query(dialed[0]).getAll("w")).toEqual(["w-1"]);
    expect(query(dialed[0]).getAll("h")).toEqual(["tag_1"]);

    dialed[0].close();
    vi.advanceTimersByTime(WS_RECONNECT_BACKOFF_MIN_MS);

    expect(dialed).toHaveLength(2);
    expect(query(dialed[1]).getAll("w")).toEqual(["w-1"]);
    expect(query(dialed[1]).getAll("h")).toEqual(["tag_1"]);
    watch.close();
  });

  test.each([
    ["no h", "/?t=token&w=w-1"],
    ["an h the server would not count", "/?t=token&w=w-1&h=not.a.tag"],
    ["two of them", "/?t=token&w=w-1&h=mine&h=theirs"],
  ])("names no holder at a URL with %s", (_what, url) => {
    window.history.replaceState(null, "", url);
    const dialed = recordDials();

    const watch = openWatchSocket(() => {});

    expect(query(dialed[0]).getAll("w")).toEqual(["w-1"]);
    expect(query(dialed[0]).has("h")).toBe(false);
    watch.close();
  });

  test("a reload of the page dials with the tag again", async () => {
    // What the launch redirect hands a window: its token, its id and the tag.
    window.history.replaceState(null, "", "/?t=token&w=w-1&h=tag_1");
    for (const load of ["the first load", "the reload"]) {
      vi.resetModules();
      const transport = await import("./transport");
      const client = await import("./client");
      const dialed = recordDials(transport.setSocketFactory);

      const watch = client.openWatchSocket(() => {});

      // The page takes its token out of the URL and leaves the tag there, so
      // the URL a reload asks for still names it.
      expect(window.location.search, load).toBe("?w=w-1&h=tag_1");
      expect(query(dialed[0]).get("t"), load).toBe("token");
      expect(query(dialed[0]).getAll("h"), load).toEqual(["tag_1"]);
      watch.close();
      transport.setSocketFactory(null);
    }
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
      windowDragScope({ libraryId: "local", standalone: false, workspaceKey: "wk-deadbeef" }),
    ).toBe("lib:local|workspace:wk-deadbeef");
  });

  test("a terminal window scopes on its library", () => {
    expect(
      windowDragScope({ libraryId: "local", standalone: true, workspaceKey: null }),
    ).toBe("lib:local|terminal");
    expect(
      windowDragScope({ libraryId: "lib-abc123", standalone: true, workspaceKey: null }),
    ).toBe("lib:lib-abc123|terminal");
  });

  test("two windows of the SAME workspace in the SAME library get the SAME scope", () => {
    // The two windows have different `?w=` ids but the same library + workspace.
    const win1 = windowDragScope({
      libraryId: "local",
      standalone: false,
      workspaceKey: "wk-deadbeef",
    });
    const win2 = windowDragScope({
      libraryId: "local",
      standalone: false,
      workspaceKey: "wk-deadbeef",
    });
    expect(win1).toBe(win2);
  });

  test("different workspaces in the same library get DIFFERENT scopes", () => {
    const a = windowDragScope({ libraryId: "local", standalone: false, workspaceKey: "wk-aaaa" });
    const b = windowDragScope({ libraryId: "local", standalone: false, workspaceKey: "wk-bbbb" });
    expect(a).not.toBe(b);
  });

  test("terminal↔workspace in the same library get DISTINCT scopes", () => {
    const term = windowDragScope({ libraryId: "local", standalone: true, workspaceKey: null });
    const ws = windowDragScope({
      libraryId: "local",
      standalone: false,
      workspaceKey: "wk-deadbeef",
    });
    expect(term).not.toBe(ws);
  });

  test("a workspace window with no identity falls back to a stable sentinel", () => {
    expect(
      windowDragScope({ libraryId: "local", standalone: false, workspaceKey: null }),
    ).toBe("lib:local|workspace:unknown");
  });

  // Rule 1: a standalone terminal accepts a dropped tab only from a terminal in
  // the SAME chan-library.
  test("terminals in the SAME library match; in DIFFERENT libraries do NOT", () => {
    const a1 = windowDragScope({ libraryId: "local", standalone: true, workspaceKey: null });
    const a2 = windowDragScope({ libraryId: "local", standalone: true, workspaceKey: null });
    const b = windowDragScope({ libraryId: "lib-remote", standalone: true, workspaceKey: null });
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
  });

  // Rule 2: a workspace tab is accepted only within the SAME workspace AND the
  // SAME chan-library. Differing EITHER dimension must not match -- including the
  // collision case where the workspace_key is identical but the library differs.
  test("workspaces match only on the same (library_id, workspace_key) pair", () => {
    const localA = windowDragScope({
      libraryId: "local",
      standalone: false,
      workspaceKey: "wk-same",
    });
    const localAgain = windowDragScope({
      libraryId: "local",
      standalone: false,
      workspaceKey: "wk-same",
    });
    const localOther = windowDragScope({
      libraryId: "local",
      standalone: false,
      workspaceKey: "wk-other",
    });
    // Same key, DIFFERENT library: the collision case that must NOT match.
    const remoteSameKey = windowDragScope({
      libraryId: "lib-remote",
      standalone: false,
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
      standalone: false,
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
      standalone: boolean;
      workspaceKey: string | null;
    }): string => SCOPE_DRAG_MIME_PREFIX + dragScopeMimeToken(windowDragScope(s));

    const localTermA = mime({ libraryId: "local", standalone: true, workspaceKey: null });
    const localTermB = mime({ libraryId: "local", standalone: true, workspaceKey: null });
    const remoteTerm = mime({ libraryId: "lib-remote", standalone: true, workspaceKey: null });
    const localWsA = mime({ libraryId: "local", standalone: false, workspaceKey: "wk-same" });
    const localWsAgain = mime({ libraryId: "local", standalone: false, workspaceKey: "wk-same" });
    const localWsOther = mime({ libraryId: "local", standalone: false, workspaceKey: "wk-other" });
    const remoteWsSameKey = mime({
      libraryId: "lib-remote",
      standalone: false,
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

    expect(fetchMock.mock.calls[0][0]).toContain("/api/fs/CHANGELOG.md?stream=1");
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
          '{"type":"meta","path":"a.md","size":1,"mtime":1,"writable":true}\n{"type":"error","error":"bad read"}\n',
        ));
        controller.close();
      },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body, { status: 200 }));

    await expect(api.readStream("a.md")).rejects.toThrow("bad read");
  });

  test("refuses a meta event that does not say whether the file is writable", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          '{"type":"meta","path":"a.md","size":1,"mtime":1}\n{"type":"chunk","content":"x","bytes":1}\n{"type":"done"}\n',
        ));
        controller.close();
      },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body, { status: 200 }));

    await expect(api.readStream("a.md")).rejects.toThrow("file stream meta has no writable bit");
  });

  test("refuses a stream that ends with no meta event", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          '{"type":"chunk","content":"x","bytes":1}\n{"type":"done"}\n',
        ));
        controller.close();
      },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body, { status: 200 }));
    const totals: Array<number | null> = [];

    await expect(
      api.readStream("a.md", { onChunk: (_chunk, progress) => totals.push(progress.totalBytes) }),
      "a read whose stream never said whether the file is writable",
    ).rejects.toThrow("file stream had no meta event");
    expect(totals, "a chunk ahead of any meta has no total").toEqual([null]);
  });
});

describe("raw file writes", () => {
  function stubDigest(): void {
    const digests = new Map([
      ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
      ["loaded", "2cab953f2b3607b36259abeb3703329d6b301b31277402ebf9f2b3b93e31dd53"],
      ["\ufeffone\r\ntwo\rthree\né\n", "a4e357930d06a17a07a7f993733104c785ae5079c06d55a5deed9541f03f51d4"],
    ].map(([text, hash]) => [Array.from(new TextEncoder().encode(text)).join(","), hash]));
    vi.stubGlobal("crypto", {
      subtle: {
        digest: vi.fn(async (algorithm: string, bytes: Uint8Array) => {
          expect(algorithm).toBe("SHA-256");
          const hex = digests.get(Array.from(bytes).join(","));
          expect(hex, "the original UTF-8 bytes reached WebCrypto").toBeDefined();
          return Uint8Array.from(hex!.match(/../g)!.map((pair) => parseInt(pair, 16))).buffer;
        }),
      },
    });
  }

  const writeWithLoadedText = api.write as (
    path: string,
    content: string,
    expectedMtimeNs?: string | null,
    expectedMtime?: number | null,
    authorityVersion?: number | null,
    loadedText?: string | null,
  ) => ReturnType<typeof api.write>;

  function standalone(): void {
    const meta = document.createElement("meta");
    meta.name = "chan-files";
    meta.content = "1";
    document.head.appendChild(meta);
    window.history.replaceState(null, "", "/?kind=terminal&w=files-window");
  }

  function okWrite() {
    return vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("{}", { status: 200 }));
  }

  test("sends the loaded text hash on a standalone write only", async () => {
    stubDigest();
    standalone();
    const fetchMock = okWrite();
    await writeWithLoadedText("a.md", "changed", "100", null, null, "loaded");
    expect(new URL(String(fetchMock.mock.calls[0]![0]), window.location.href).searchParams.get("expected_sha256"))
      .toBe("2cab953f2b3607b36259abeb3703329d6b301b31277402ebf9f2b3b93e31dd53");

    fetchMock.mockClear();
    window.history.replaceState(null, "", "/?w=workspace-window");
    await writeWithLoadedText("a.md", "changed", "100", null, null, "loaded");
    expect(String(fetchMock.mock.calls[0]![0])).toBe("/api/fs/a.md?expected_mtime_ns=100");
  });

  test("keeps the original standalone URL without loaded text or WebCrypto", async () => {
    stubDigest();
    standalone();
    const fetchMock = okWrite();
    await api.write("a.md", "changed", "100");
    await writeWithLoadedText("a.md", "changed", "100", null, null, null);
    vi.stubGlobal("crypto", { subtle: undefined });
    await writeWithLoadedText("a.md", "changed", "100", null, null, "loaded");
    for (const [url] of fetchMock.mock.calls) {
      expect(String(url)).toBe("/api/fs/a.md?expected_mtime_ns=100&w=files-window");
    }
  });

  test("hashes the UTF-8 bytes of loaded text, including empty and mixed line endings", async () => {
    stubDigest();
    const client = await import("./client") as unknown as { sha256Text?: (text: string) => Promise<string> };
    expect(typeof client.sha256Text).toBe("function");
    expect(await client.sha256Text!("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(await client.sha256Text!("loaded")).toBe("2cab953f2b3607b36259abeb3703329d6b301b31277402ebf9f2b3b93e31dd53");
    expect(await client.sha256Text!("\ufeffone\r\ntwo\rthree\né\n"))
      .toBe("a4e357930d06a17a07a7f993733104c785ae5079c06d55a5deed9541f03f51d4");
  });

  test("keeps streamed text byte-identical across chunk events", async () => {
    stubDigest();
    const chunks = ["\ufeffone\r", "\ntwo\r", "three\n", "é\n"];
    const lines = [
      { type: "meta", path: "a.md", size: new TextEncoder().encode(chunks.join("")).length, mtime: 1, writable: true },
      ...chunks.map((content) => ({ type: "chunk", content, bytes: new TextEncoder().encode(content).length })),
      { type: "done" },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n";
    const bytes = new TextEncoder().encode(lines);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, bytes.length - 2));
        controller.enqueue(bytes.slice(bytes.length - 2));
        controller.close();
      },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body, { status: 200 }));
    const file = await api.readStream("a.md");
    expect(file.content).toBe(chunks.join(""));
    const client = await import("./client") as unknown as { sha256Text?: (text: string) => Promise<string> };
    expect(typeof client.sha256Text).toBe("function");
    expect(await client.sha256Text!(file.content))
      .toBe("a4e357930d06a17a07a7f993733104c785ae5079c06d55a5deed9541f03f51d4");
  });

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
      "/api/fs/notes/a%20b.md?expected_mtime_ns=100&authority_version=7",
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

  test("keeps conflict metadata beside a blank refusal sentence", async () => {
    const body = { error: " \t", current_mtime_ns: "300", current_authority_version: 9 };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(body), { status: 409 }),
    );

    await expect(api.write("a.md", "changed", "100", null, 7)).rejects.toMatchObject({
      status: 409,
      message: " \t",
      data: body,
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

describe("the files route for a draft", () => {
  const MARK = String.fromCharCode(0);
  const draft = draftClientPath({ path: "untitled/draft.md", draft_id: "v1:abc" });
  const image = draftClientPath({ path: "untitled/my image.png", draft_id: "v1:abc" });

  test("a read, a streamed read and a write name the draft's root and lifetime", async () => {
    window.history.replaceState(null, "", "/?t=token&w=w-ws");
    const requests = recordRequests(() => json({}));
    try {
      await api.read(draft);
      // The recorded answer is no stream; the request is what is read here.
      await api.readStream(draft).catch(() => {});
      await api.write(draft, "text", "123");
      expect(requests.map((r) => r.method), "the three requests").toEqual(["GET", "GET", "PUT"]);
      for (const [index, label] of ["read", "stream", "write"].entries()) {
        const request = requests[index]!;
        expect(request.path, `${label}: the route`).toBe("/api/fs/untitled/draft.md");
        expect(request.query.get("root"), `${label}: the root`).toBe("draft");
        expect(request.query.get("draft_id"), `${label}: the lifetime id`).toBe("v1:abc");
      }
      expect(requests[1]!.query.get("stream"), "the streamed read's flag").toBe("1");
      expect(requests[2]!.query.get("w"), "the write's window").toBe("w-ws");
      expect(requests[2]!.query.get("expected_mtime_ns"), "the write's token").toBe("123");
    } finally {
      stopRecordingRequests();
    }
  });

  test("a workspace file of the same spelling keeps the bare route", async () => {
    window.history.replaceState(null, "", "/?t=token&w=w-ws");
    const requests = recordRequests(() => json({}));
    try {
      await api.read("untitled/draft.md");
      await api.write("untitled/draft.md", "text", "123");
      for (const request of requests) {
        expect(request.path, "the route").toBe("/api/fs/untitled/draft.md");
        expect(request.query.has("root"), "a root").toBe(false);
        expect(request.query.has("draft_id"), "a lifetime id").toBe(false);
      }
      expect(requests[1]!.query.has("w"), "a workspace save names no window").toBe(false);
    } finally {
      stopRecordingRequests();
    }
  });

  test("the URLs an element loads carry the same identity and no mark", () => {
    for (const [label, built] of [
      ["the file URL", fileUrl(image)],
      ["the download URL", api.downloadUrl(image)],
    ] as const) {
      const url = new URL(built, "http://chan.test");
      expect(built.includes(MARK) || built.includes("%00"), `${label}: the mark`).toBe(false);
      expect(url.pathname, `${label}: the route`).toBe("/api/fs/untitled/my%20image.png");
      expect(url.searchParams.get("root"), `${label}: the root`).toBe("draft");
      expect(url.searchParams.get("draft_id"), `${label}: the lifetime id`).toBe("v1:abc");
    }
    expect(new URL(api.downloadUrl(image), "http://chan.test").searchParams.get("download")).toBe("1");
  });
});

describe("the draft calls of a workspace window", () => {
  const primary = { root: "draft", path: "untitled/draft.md", draft_id: "v1:abc" };
  const draft = draftClientPath({ path: "untitled/draft.md", draft_id: "v1:abc" });
  const busy = () =>
    json(
      { error: "draft `untitled` is busy", code: "draft_busy", name: "untitled" },
      { status: 503, headers: { "retry-after": "1" } },
    );

  afterEach(() => {
    stopRecordingRequests();
    vi.useRealTimers();
  });

  test("a created draft is answered as the client path of its primary", async () => {
    recordRequests(() => json({ path: "untitled/draft.md", name: "untitled", primary }));

    expect(await api.createDraft(), "a draft").toEqual({ path: draft, name: "untitled" });
    expect(await api.createDiagram(), "a diagram").toEqual({ path: draft, name: "untitled" });
  });

  test("inspect, discard and promote name the draft by its identity", async () => {
    const requests = recordRequests((request) =>
      request.path.endsWith("/promote")
        ? json({
            path: "notes/report.md",
            name: "untitled",
            mode: "file",
            target: "notes/report.md",
            primary: { root: "workspace", path: "notes/report.md" },
          })
        : request.path.endsWith("/inspect")
          ? json({ path: "untitled/draft.md", name: "untitled", has_attachments: false, primary })
          : new Response(null, { status: 204 }),
    );

    const inspected = await api.inspectDraft(draft);
    await api.discardDraft(draft);
    const promoted = await api.promoteDraft(draft, "notes/report.md");

    expect(requests.map((r) => r.body), "the three bodies").toEqual([
      { source: primary },
      { source: primary },
      { source: primary, target: "notes/report.md" },
    ]);
    expect(inspected.path, "the inspected primary").toBe(draft);
    expect(promoted.path, "the promoted primary").toBe("notes/report.md");
  });

  test("a broken row is discarded by the source its warning carries", async () => {
    const requests = recordRequests(() => new Response(null, { status: 204 }));

    await api.discardDraft({ root: "draft", path: "untitled" });

    expect(requests[0]!.body, "the body").toEqual({ source: { root: "draft", path: "untitled" } });
  });

  test("a path that carries no mark keeps the path-only bodies", async () => {
    const requests = recordRequests(() => json({ path: "home/u/.chan/Drafts/untitled/draft.md" }));

    await api.inspectDraft("home/u/.chan/Drafts/untitled/draft.md");
    await api.promoteDraft("home/u/.chan/Drafts/untitled/draft.md", "home/u/notes.md");

    expect(requests.map((r) => r.body), "the two bodies").toEqual([
      { path: "home/u/.chan/Drafts/untitled/draft.md" },
      { path: "home/u/.chan/Drafts/untitled/draft.md", target: "home/u/notes.md" },
    ]);
  });

  test("the list answers each draft by its client path, with the warnings as sent", async () => {
    const warning = {
      kind: "broken_draft",
      path: "/home/u/.chan/workspaces/k/Drafts/untitled-2",
      message: "missing draft.md",
      source: { root: "draft", path: "untitled-2" },
    };
    const requests = recordRequests(() =>
      json({ drafts: [{ name: "untitled", primary, has_attachments: true }], warnings: [warning] }),
    );

    const listed = await api.listDrafts();

    expect(requests, "requests sent").toHaveLength(1);
    expect([requests[0]!.method, requests[0]!.path], "the request").toEqual(["GET", "/api/drafts"]);
    expect(listed, "the answer").toEqual({
      drafts: [{ name: "untitled", path: draft, hasAttachments: true }],
      warnings: [warning],
    });
  });

  test("terminal paths are asked for by identity and answered in request order", async () => {
    const image = draftClientPath({ path: "untitled/image.png", draft_id: "v1:abc" });
    const source = { root: "draft", path: "untitled/image.png", draft_id: "v1:abc" };
    const requests = recordRequests(() =>
      json({ paths: [{ source, absolute_path: "/home/u/.chan/workspaces/k/Drafts/untitled/image.png" }] }),
    );

    const paths = await api.draftTerminalPaths([image]);

    expect(requests, "requests sent").toHaveLength(1);
    expect([requests[0]!.method, requests[0]!.path], "the request").toEqual([
      "POST",
      "/api/drafts/terminal-paths",
    ]);
    expect(requests[0]!.body, "the body").toEqual({ sources: [source] });
    expect(paths, "the answer").toEqual(["/home/u/.chan/workspaces/k/Drafts/untitled/image.png"]);
  });

  test("a busy lifecycle call is sent again after the server's delay, and then lands", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const requests = recordRequests(() => {
      calls += 1;
      return calls < 3 ? busy() : new Response(null, { status: 204 });
    });

    const outcome = api.discardDraft(draft).then(
      () => "landed",
      (error: unknown) => apiErrorCode(error),
    );
    await vi.advanceTimersByTimeAsync(999);
    expect(requests, "before the delay has passed").toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1001);

    expect(await outcome, "the call's outcome").toBe("landed");
    expect(requests, "requests sent").toHaveLength(3);
    expect(requests.map((r) => r.body), "each the same call").toEqual([
      { source: primary },
      { source: primary },
      { source: primary },
    ]);
  });

  test("a lifecycle call that stays busy is given up after three more tries", async () => {
    vi.useFakeTimers();
    const requests = recordRequests(busy);

    const refused = api.promoteDraft(draft, "notes/report.md").then(
      () => null,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(10_000);

    expect(apiErrorCode(await refused), "the refusal's code").toBe("draft_busy");
    expect(requests, "requests sent").toHaveLength(4);
  });

  test("a stale lifetime is refused once and never sent again", async () => {
    vi.useFakeTimers();
    const requests = recordRequests(() =>
      json({ error: "refetch its identity", code: "draft_stale", name: "untitled" }, { status: 409 }),
    );

    const refused = api.discardDraft(draft).then(
      () => null,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(10_000);

    expect(apiErrorCode(await refused), "the refusal's code").toBe("draft_stale");
    expect(requests, "requests sent").toHaveLength(1);
  });
});
