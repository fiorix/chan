// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../api/client";
import { ApiError } from "../api/errors";
import { type PageSnapshot } from "./pdf_snapshot";
import { respondExportJob } from "./pdf_export";

vi.mock("../api/client", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../api/client")>();
  return {
    ...mod,
    api: {
      ...mod.api,
      read: vi.fn(),
      remove: vi.fn(),
      replaceFile: vi.fn(),
      uploadFile: vi.fn(),
      windowReply: vi.fn(),
    },
  };
});

vi.mock("./mermaid_render", () => ({
  renderMermaid: vi.fn(async () => ({ ok: true, svg: "<svg></svg>" })),
}));
vi.mock("./excalidraw_render", () => ({
  renderExcalidraw: vi.fn(async () => ({ ok: true, svg: "<svg></svg>" })),
  renderExcalidrawFile: vi.fn(async () => ({ ok: true, svg: "<svg></svg>" })),
}));

const TINY_PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);

const SEAMS = {
  rasterize: async (): Promise<PageSnapshot> => ({
    png: TINY_PNG,
    widthPx: 2,
    heightPx: 2,
  }),
};

const JOB = {
  id: "job-1",
  path: "notes/doc.md",
  format: "pdf",
  out: "notes/doc.pdf",
};

/// `JOB` as a server that guards the job's uploads sends it.
const GUARDED = { ...JOB, guarded_upload: true };

/// A deck of three slides, as `JOB`'s source.
const DECK = `---
chan:
  kind: slides
  slides:
    aspect_ratio: "16:9"
---

# One

<hr class="chan-page-break">

# Two

<hr class="chan-page-break">

# Three
`;

function readsDeck(): void {
  vi.mocked(api.read).mockResolvedValue({
    path: "notes/doc.md",
    content: DECK,
    mtime: null,
    writable: true,
  });
}

/// Every reply posted for the job, in the order posted.
function replies(): unknown[] {
  return vi.mocked(api.windowReply).mock.calls.map(([reply]) => reply);
}

const FINAL = { requestId: "job-1", payload: { ok: true, out: "notes/doc.pdf" } };

beforeEach(() => {
  vi.mocked(api.read).mockResolvedValue({
    path: "notes/doc.md",
    content: "# Title\n\nbody\n",
    mtime: null,
    writable: true,
  });
  vi.mocked(api.remove).mockResolvedValue(undefined);
  vi.mocked(api.replaceFile).mockResolvedValue({
    path: "notes/doc.pdf",
    size: 1,
  });
  vi.mocked(api.uploadFile).mockResolvedValue({
    path: "notes/doc.pdf",
    size: 1,
  });
  vi.mocked(api.windowReply).mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

describe("respondExportJob", () => {
  test("renders, uploads to out, and replies ok with the request id", async () => {
    await respondExportJob(JOB, "light", SEAMS);

    expect(api.read).toHaveBeenCalledWith("notes/doc.md");
    expect(api.replaceFile).toHaveBeenCalledTimes(1);
    const [file, out] = vi.mocked(api.replaceFile).mock.calls[0]!;
    expect(out).toBe("notes/doc.pdf");
    expect((file as File).name).toBe("doc.pdf");
    expect((file as File).type).toBe("application/pdf");
    expect(api.windowReply).toHaveBeenCalledWith({
      requestId: "job-1",
      payload: { ok: true, out: "notes/doc.pdf" },
    });
  });

  test("an unknown format replies ok:false without reading the file", async () => {
    await respondExportJob({ ...JOB, format: "docx" }, "light", SEAMS);

    expect(api.read).not.toHaveBeenCalled();
    expect(api.windowReply).toHaveBeenCalledWith({
      requestId: "job-1",
      payload: { ok: false, error: "unknown export format: docx" },
    });
  });

  test("a missing out target falls back to the plain upload mode", async () => {
    vi.mocked(api.replaceFile).mockRejectedValueOnce(
      new Error("not found: notes/doc.pdf"),
    );

    await respondExportJob(JOB, "light", SEAMS);

    expect(api.uploadFile).toHaveBeenCalledTimes(1);
    const [file, dir] = vi.mocked(api.uploadFile).mock.calls[0]!;
    expect((file as File).name).toBe("doc.pdf");
    expect(dir).toBe("notes");
    expect(api.replaceFile).toHaveBeenCalledTimes(1);
    expect(api.windowReply).toHaveBeenCalledWith({
      requestId: "job-1",
      payload: { ok: true, out: "notes/doc.pdf" },
    });
  });

  test("an out spelled with a leading slash keeps the file its fallback upload wrote", async () => {
    vi.mocked(api.replaceFile).mockRejectedValueOnce(
      new Error("not found: notes/doc.pdf"),
    );
    // The upload route answers with the path it wrote, which carries no
    // leading slash however the request spelled its directory.
    vi.mocked(api.uploadFile).mockResolvedValue({
      path: "notes/doc.pdf",
      size: 1,
    });

    await respondExportJob({ ...JOB, out: "/notes/doc.pdf" }, "light", SEAMS);

    expect(
      vi.mocked(api.uploadFile).mock.calls.map(([file, dir]) => [(file as File).name, dir]),
      "the fallback upload",
    ).toEqual([["doc.pdf", "/notes"]]);
    expect(api.remove, "the written file is not removed").not.toHaveBeenCalled();
    expect(api.replaceFile, "no replace after the upload").toHaveBeenCalledTimes(1);
    expect(api.windowReply).toHaveBeenLastCalledWith({
      requestId: "job-1",
      payload: { ok: true, out: "/notes/doc.pdf" },
    });
  });

  test("when the upload fallback cannot repair, the original error reports", async () => {
    vi.mocked(api.replaceFile).mockRejectedValue(new Error("replace exploded"));
    vi.mocked(api.uploadFile).mockRejectedValue(new Error("upload denied"));

    await respondExportJob(JOB, "light", SEAMS);

    expect(api.windowReply).toHaveBeenCalledWith({
      requestId: "job-1",
      payload: { ok: false, error: "replace exploded" },
    });
  });

  test("a render failure replies ok:false with the message", async () => {
    await respondExportJob(JOB, "light", {
      rasterize: async () => {
        throw new Error("raster blew up");
      },
    });

    expect(api.replaceFile).not.toHaveBeenCalled();
    expect(api.windowReply).toHaveBeenCalledWith({
      requestId: "job-1",
      payload: { ok: false, error: "raster blew up" },
    });
  });

  test("a stale reply id (404) is swallowed", async () => {
    const err = Object.assign(new Error("gone"), { status: 404 });
    vi.mocked(api.windowReply).mockRejectedValue(err);
    await expect(respondExportJob(JOB, "light", SEAMS)).resolves.toBeUndefined();
  });
});

// A guarded job names itself on every upload request and writes to its
// output path alone: a create and, only when the server refuses the create
// because the target exists, one replace. The server refuses a write for a
// job that has ended and a commit to any path but the job's.
describe("a guarded export job's upload", () => {
  const NAMES_JOB = { exportJob: "job-1" };
  const COUNT = { requestId: "job-1", pageFinished: 1 };
  const exists = (): ApiError => new ApiError(409, "path already exists: notes/doc.pdf");

  /// Each replace the job made: the file's name, the path and the options.
  function replaces(): unknown[] {
    return vi.mocked(api.replaceFile).mock.calls.map(([file, out, opts]) => ({ name: file.name, out, opts }));
  }

  // A case that fails can leave an answer it queued for one call unread. The
  // next case starts from the answers the file's setup gives.
  afterEach(() => {
    vi.mocked(api.uploadFile).mockReset();
    vi.mocked(api.replaceFile).mockReset();
  });

  test("creates out under the job's id, replaces nothing, and replies ok", async () => {
    await respondExportJob(GUARDED, "light", SEAMS);

    expect(api.uploadFile, "one create").toHaveBeenCalledTimes(1);
    const [file, dir, opts] = vi.mocked(api.uploadFile).mock.calls[0]!;
    expect({ name: file.name, type: file.type, dir }, "the create is out's name in out's directory").toEqual({
      name: "doc.pdf",
      type: "application/pdf",
      dir: "notes",
    });
    expect(opts, "the create names the job").toEqual(NAMES_JOB);
    expect(api.replaceFile, "no replace").not.toHaveBeenCalled();
    expect(replies()).toEqual([COUNT, FINAL]);
  });

  test("replaces out under the job's id when the create is refused because out exists", async () => {
    vi.mocked(api.uploadFile).mockRejectedValueOnce(exists());

    await respondExportJob(GUARDED, "light", SEAMS);

    expect(api.uploadFile, "one create").toHaveBeenCalledTimes(1);
    expect(replaces(), "one replace of out, naming the job").toEqual([
      { name: "doc.pdf", out: "notes/doc.pdf", opts: NAMES_JOB },
    ]);
    expect(api.remove, "no removal").not.toHaveBeenCalled();
    expect(replies()).toEqual([COUNT, FINAL]);
  });

  test("ends the job with the server's sentence when the create is refused for a job that has ended", async () => {
    vi.mocked(api.uploadFile).mockRejectedValueOnce(new ApiError(404, "export job is no longer active"));

    await respondExportJob(GUARDED, "light", SEAMS);

    expect(api.uploadFile, "one create").toHaveBeenCalledTimes(1);
    expect(api.replaceFile, "no replace after a refusal that is not a 409").not.toHaveBeenCalled();
    expect(replies()).toEqual([
      COUNT,
      { requestId: "job-1", payload: { ok: false, error: "export job is no longer active" } },
    ]);
  });

  test("ends the job with the replace's error when the replace after a 409 fails", async () => {
    vi.mocked(api.uploadFile).mockRejectedValueOnce(exists());
    vi.mocked(api.replaceFile).mockRejectedValueOnce(
      new ApiError(500, "export job retired, expired, or upload path differs"),
    );

    await respondExportJob(GUARDED, "light", SEAMS);

    expect(api.uploadFile, "one create").toHaveBeenCalledTimes(1);
    expect(replaces(), "one replace of out, naming the job").toEqual([
      { name: "doc.pdf", out: "notes/doc.pdf", opts: NAMES_JOB },
    ]);
    expect(api.remove, "no removal").not.toHaveBeenCalled();
    expect(replies()).toEqual([
      COUNT,
      { requestId: "job-1", payload: { ok: false, error: "export job retired, expired, or upload path differs" } },
    ]);
  });

  test("a stop during a create the server refuses with a 409 starts no replace and no reply", async () => {
    const stop = new AbortController();
    // The stop lands while the create is on the wire, ahead of its refusal.
    vi.mocked(api.uploadFile).mockImplementation(async () => {
      stop.abort();
      throw exists();
    });

    await respondExportJob(GUARDED, "light", SEAMS, stop.signal);

    expect(api.uploadFile, "one create").toHaveBeenCalledTimes(1);
    expect({ replaces: replaces(), replies: replies() }, "the stop during the create").toEqual({
      replaces: [],
      replies: [COUNT],
    });
  });
});

// The server ends a job that says nothing for its quiet bound, and a count
// that advances starts that bound again.
describe("an export job's page counts", () => {
  test("a deck posts a count after each slide, before the next one starts, and then its reply", async () => {
    readsDeck();
    const steps: string[] = [];
    vi.mocked(api.windowReply).mockImplementation(async (reply) => {
      steps.push("pageFinished" in reply ? `count ${String(reply.pageFinished)}` : "reply");
    });
    const rasterize = async (): Promise<PageSnapshot> => {
      steps.push("slide");
      return SEAMS.rasterize();
    };

    await respondExportJob(JOB, "light", { rasterize });

    expect(replies(), "the replies in the order posted").toEqual([
      { requestId: "job-1", pageFinished: 1 },
      { requestId: "job-1", pageFinished: 2 },
      { requestId: "job-1", pageFinished: 3 },
      FINAL,
    ]);
    expect(steps, "each count between its slide and the next").toEqual([
      "slide",
      "count 1",
      "slide",
      "count 2",
      "slide",
      "count 3",
      "reply",
    ]);
  });

  test("a document of one page posts its count and then its reply", async () => {
    await respondExportJob(JOB, "light", SEAMS);

    expect(replies(), "the replies in the order posted").toEqual([{ requestId: "job-1", pageFinished: 1 }, FINAL]);
  });

  test("a count whose post fails otherwise than by a 404 is logged, and the export goes on", async () => {
    readsDeck();
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(api.windowReply).mockRejectedValueOnce(Object.assign(new Error("bad gateway"), { status: 502 }));

    await respondExportJob(JOB, "light", SEAMS);

    expect(
      { replies: replies(), uploads: vi.mocked(api.replaceFile).mock.calls.length, warned: warned.mock.calls.length },
      "the job after its first count failed",
    ).toEqual({
      replies: [
        { requestId: "job-1", pageFinished: 1 },
        { requestId: "job-1", pageFinished: 2 },
        { requestId: "job-1", pageFinished: 3 },
        FINAL,
      ],
      uploads: 1,
      warned: 1,
    });
    warned.mockRestore();
  });
});

// The server stops a job at its bound or when its caller goes: it tells the
// window, and answers 404 to whatever the job posts after that.
describe("an export job that is stopped", () => {
  /// Give a document a block taller than a page in jsdom, which has no layout.
  function twoPageDocument(): () => void {
    const original = HTMLElement.prototype.getBoundingClientRect;
    const geometry = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.tagName === "P" && this.closest(".chan-print-content")) return new DOMRect(0, 0, 1, 1500);
      return original.call(this);
    });
    return () => geometry.mockRestore();
  }

  /// A rasterizer that waits inside its `held`th page until released.
  function heldAt(held: number) {
    let pages = 0;
    let release: () => void = () => {};
    let reached: () => void = () => {};
    const atHold = new Promise<void>((resolve) => (reached = resolve));
    return {
      pages: () => pages,
      atHold,
      release: () => release(),
      rasterize: async (): Promise<PageSnapshot> => {
        pages += 1;
        if (pages === held) {
          reached();
          await new Promise<void>((resolve) => (release = resolve));
        }
        return SEAMS.rasterize();
      },
    };
  }

  function uploads(): { replaced: number; uploaded: number; removed: number } {
    return {
      replaced: vi.mocked(api.replaceFile).mock.calls.length,
      uploaded: vi.mocked(api.uploadFile).mock.calls.length,
      removed: vi.mocked(api.remove).mock.calls.length,
    };
  }

  const NONE = { replaced: 0, uploaded: 0, removed: 0 };

  test("a two-page document stops before its next page when its first count is still on the wire", async () => {
    const restore = twoPageDocument();
    try {
      const stop = new AbortController();
      let pages = 0;
      let release: () => void = () => {};
      let reached: () => void = () => {};
      const atCount = new Promise<void>((resolve) => (reached = resolve));
      vi.mocked(api.windowReply).mockImplementation(async (reply) => {
        if (reply.pageFinished !== 1) return;
        reached();
        await new Promise<void>((resolve) => (release = resolve));
      });
      const done = respondExportJob(JOB, "light", { rasterize: async () => {
        pages += 1;
        return SEAMS.rasterize();
      } }, stop.signal);
      await atCount;
      stop.abort();
      release();
      await done;

      expect({ pages, uploads: uploads(), replies: replies() }, "the document stopped before its second page").toEqual({
        pages: 1, uploads: NONE, replies: [{ requestId: "job-1", pageFinished: 1 }],
      });
    } finally {
      restore();
    }
  });

  test("a stop inside a two-page document's second page posts no count for it", async () => {
    const restore = twoPageDocument();
    try {
      const second = heldAt(2);
      const stop = new AbortController();
      const done = respondExportJob(JOB, "light", { rasterize: second.rasterize }, stop.signal);
      await second.atHold;
      stop.abort();
      second.release();
      await done;

      expect({ pages: second.pages(), uploads: uploads(), replies: replies() }, "the document stopped inside its second page").toEqual({
        pages: 2, uploads: NONE, replies: [{ requestId: "job-1", pageFinished: 1 }],
      });
    } finally {
      restore();
    }
  });

  test("a stop during upload leaves the completed upload without a final reply", async () => {
    const stop = new AbortController();
    let release: () => void = () => {};
    let reached: () => void = () => {};
    const atUpload = new Promise<void>((resolve) => (reached = resolve));
    vi.mocked(api.replaceFile).mockImplementation(() => new Promise((resolve) => {
      release = () => resolve({ path: "notes/doc.pdf", size: 1 });
      reached();
    }));

    const done = respondExportJob(JOB, "light", SEAMS, stop.signal);
    await atUpload;
    stop.abort();
    release();
    await done;

    expect({ uploads: uploads(), replies: replies() }, "the stop after upload began").toEqual({
      uploads: { replaced: 1, uploaded: 0, removed: 0 },
      replies: [{ requestId: "job-1", pageFinished: 1 }],
    });
  });

  test("a stop during a failed replace starts no fallback upload", async () => {
    const stop = new AbortController();
    let rejectReplace: (reason: Error) => void = () => {};
    let reached: () => void = () => {};
    const atReplace = new Promise<void>((resolve) => (reached = resolve));
    vi.mocked(api.replaceFile).mockImplementation(() => new Promise((_resolve, reject) => {
      rejectReplace = reject;
      reached();
    }));

    const done = respondExportJob(JOB, "light", SEAMS, stop.signal);
    await atReplace;
    stop.abort();
    rejectReplace(new Error("replace failed"));
    await done;

    expect({ uploads: uploads(), replies: replies() }).toEqual({
      uploads: { replaced: 1, uploaded: 0, removed: 0 },
      replies: [{ requestId: "job-1", pageFinished: 1 }],
    });
  });

  test("by its signal inside a slide starts no further slide, uploads nothing and posts nothing more", async () => {
    readsDeck();
    const second = heldAt(2);
    const stop = new AbortController();

    const done = respondExportJob(JOB, "light", { rasterize: second.rasterize }, stop.signal);
    await second.atHold;
    stop.abort();
    second.release();
    await done;

    expect(
      { slides: second.pages(), uploads: uploads(), replies: replies() },
      "the job stopped inside its second slide",
    ).toEqual({ slides: 2, uploads: NONE, replies: [{ requestId: "job-1", pageFinished: 1 }] });
  });

  // A stop can land while a count is on the wire, after its slide's own
  // reading of the signal.
  test.each([
    { held: 1, slides: 1 },
    { held: 3, slides: 3 },
  ])(
    "by its signal while count $held is on the wire starts no further slide and uploads nothing",
    async ({ held, slides }) => {
      readsDeck();
      const stop = new AbortController();
      let rastered = 0;
      const rasterize = async (): Promise<PageSnapshot> => {
        rastered += 1;
        return SEAMS.rasterize();
      };
      let release: () => void = () => {};
      let reached: () => void = () => {};
      const atHold = new Promise<void>((resolve) => (reached = resolve));
      vi.mocked(api.windowReply).mockImplementation(async (reply) => {
        if (reply.pageFinished !== held) return;
        reached();
        await new Promise<void>((resolve) => (release = resolve));
      });

      const done = respondExportJob(JOB, "light", { rasterize }, stop.signal);
      await atHold;
      stop.abort();
      release();
      await done;

      expect(
        { slides: rastered, uploads: uploads(), posts: replies().length },
        "the job stopped while a count was on the wire",
      ).toEqual({ slides, uploads: NONE, posts: held });
    },
  );

  test("by a count the server answers 404 starts no further slide, uploads nothing and posts nothing more", async () => {
    readsDeck();
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    let slides = 0;
    const rasterize = async (): Promise<PageSnapshot> => {
      slides += 1;
      return SEAMS.rasterize();
    };
    vi.mocked(api.windowReply).mockRejectedValueOnce(Object.assign(new Error("gone"), { status: 404 }));

    await respondExportJob(JOB, "light", { rasterize });

    expect(
      { slides, uploads: uploads(), replies: replies(), warned: warned.mock.calls.length },
      "the job whose first count met a 404",
    ).toEqual({ slides: 1, uploads: NONE, replies: [{ requestId: "job-1", pageFinished: 1 }], warned: 0 });
    warned.mockRestore();
  });
});
