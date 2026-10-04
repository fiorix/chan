// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../api/client";
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

  test("a collision-renamed upload replaces the real target and removes the stray", async () => {
    vi.mocked(api.replaceFile)
      .mockRejectedValueOnce(new Error("not found: notes/doc.pdf"))
      .mockResolvedValueOnce({ path: "notes/doc.pdf", size: 1 });
    vi.mocked(api.uploadFile).mockResolvedValue({
      path: "notes/doc-1.pdf",
      size: 1,
    });

    await respondExportJob(JOB, "light", SEAMS);

    expect(api.replaceFile).toHaveBeenCalledTimes(2);
    expect(api.remove).toHaveBeenCalledWith("notes/doc-1.pdf");
    expect(api.windowReply).toHaveBeenCalledWith({
      requestId: "job-1",
      payload: { ok: true, out: "notes/doc.pdf" },
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
