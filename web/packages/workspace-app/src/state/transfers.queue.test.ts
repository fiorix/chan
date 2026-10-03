// @vitest-environment jsdom

// Server-authoritative transfer admission, browser half.
//
// The browser no longer decides who may start: it starts what the user asked
// for, sends the tracking headers, and renders whatever rank the server
// reports. These tests pin that split, plus the wire shape, which is validated
// at runtime rather than by the compiler. Every literal below is spelled out on
// purpose; vitest strips types, so a scoped run would otherwise pass with a
// fixture missing a required field.

import { afterEach, describe, expect, test } from "vitest";

import {
  applyTransferQueueFrame,
  beginTransfer,
  cancelTransfer,
  finishTransfer,
  transfers,
  waitForTransferSlot,
} from "./transfers.svelte";
import { api, sessionWindowId } from "../api/client";
import { ApiError, apiErrorCode } from "../api/errors";
import { setXhrFactory } from "../api/transport";
import { demoData } from "../__tests__/app";
import { installDemoWorkspace, uninstallDemoWorkspace } from "../demo/install";
import { fileOps, loadTreeDir, onWatchEvent, tree, ui } from "./store.svelte";

function resetTransfers(): void {
  transfers.items = [];
  transfers.shown = false;
  window.sessionStorage.clear();
}

afterEach(resetTransfers);

function begin(filename = "one.md"): string {
  return beginTransfer({ kind: "upload", filename, cancel: null });
}

describe("the browser makes no admission decision", () => {
  test("every begun transfer is active immediately, however many are open", () => {
    resetTransfers();
    const ids = [begin("a"), begin("b"), begin("c"), begin("d")];
    for (const id of ids) {
      expect(transfers.items.find((t) => t.id === id)?.state).toBe("active");
    }
    // No local rank is invented before the server has said anything.
    expect(transfers.items.every((t) => t.queue === null)).toBe(true);
  });

  test("waitForTransferSlot no longer waits; it only rejects a dead transfer", async () => {
    resetTransfers();
    const id = begin();
    await expect(waitForTransferSlot(id)).resolves.toBe(true);
    cancelTransfer(id);
    await expect(waitForTransferSlot(id)).resolves.toBe(false);
    await expect(waitForTransferSlot("no-such-transfer")).resolves.toBe(false);
  });
});

describe("applying a server frame", () => {
  test("a waiting frame records the rank", () => {
    resetTransfers();
    const id = begin();
    applyTransferQueueFrame({ transfer_id: id, state: "waiting", position: 3 });
    expect(transfers.items[0]!.queue).toEqual({ state: "waiting", position: 3 });
  });

  test("an active frame carries no position, and null is not rendered as zero", () => {
    resetTransfers();
    const id = begin();
    applyTransferQueueFrame({ transfer_id: id, state: "waiting", position: 2 });
    // The contract omits the field entirely rather than sending 0 or null.
    applyTransferQueueFrame({ transfer_id: id, state: "active" });
    expect(transfers.items[0]!.queue).toEqual({ state: "active", position: null });
  });

  test("a rank may jump or rise; nothing assumes monotonicity", () => {
    resetTransfers();
    const id = begin();
    for (const position of [5, 2, 4, 1]) {
      applyTransferQueueFrame({ transfer_id: id, state: "waiting", position });
      expect(transfers.items[0]!.queue?.position).toBe(position);
    }
  });

  test("an unknown transfer id is dropped rather than creating a record", () => {
    resetTransfers();
    begin();
    applyTransferQueueFrame({ transfer_id: "someone-elses", state: "waiting", position: 1 });
    expect(transfers.items).toHaveLength(1);
    expect(transfers.items[0]!.queue).toBeNull();
  });

  test("a settled transfer ignores late frames and holds no stale rank", () => {
    resetTransfers();
    const id = begin();
    applyTransferQueueFrame({ transfer_id: id, state: "waiting", position: 4 });
    finishTransfer(id);
    expect(transfers.items[0]!.queue).toBeNull();
    applyTransferQueueFrame({ transfer_id: id, state: "waiting", position: 9 });
    expect(transfers.items[0]!.queue).toBeNull();
  });

  test("a non-numeric position degrades to no rank instead of NaN", () => {
    resetTransfers();
    const id = begin();
    applyTransferQueueFrame({
      transfer_id: id,
      state: "waiting",
      position: undefined,
    });
    expect(transfers.items[0]!.queue).toEqual({ state: "waiting", position: null });
  });
});

describe("transfer ids cannot collide across windows", () => {
  test("the id embeds the window, so a foreign frame cannot match ours", () => {
    // transfer_id is the ONLY key a frame can be matched on, and window_id is
    // caller-asserted, so a bare per-window counter would let another window's
    // "xfer-1" land on ours.
    resetTransfers();
    const id = begin();
    expect(id).not.toMatch(/^xfer-\d+$/);
    expect(id).toContain(sessionWindowId());

    // The consequence that shape exists for: the same counter value minted by
    // another window matches nothing here, so its rank never lands on our row.
    applyTransferQueueFrame({
      transfer_id: id.replace(sessionWindowId(), "other-window"),
      state: "waiting",
      position: 3,
    });
    expect(transfers.items[0]!.queue).toBeNull();
  });
});

/// An upload request that answers with `status` as soon as it is sent,
/// recording the headers the client set. A `body` stands for what a refusal
/// answers in place of the upload's result.
class AnsweringXhr {
  static sent: AnsweringXhr[] = [];
  headers: Record<string, string> = {};
  status = 0;
  statusText = "";
  responseText = "";
  upload: { onprogress: (() => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  onloadend: (() => void) | null = null;
  constructor(
    private readonly answer: number,
    private readonly body: string | null,
  ) {
    AnsweringXhr.sent.push(this);
  }
  open(): void {}
  setRequestHeader(name: string, value: string): void {
    this.headers[name] = value;
  }
  send(body: FormData): void {
    const file = body.get("file") as File;
    const dir = body.get("dir");
    this.status = this.answer;
    this.responseText =
      this.body ?? JSON.stringify({ path: `${dir ? `${dir}/` : ""}${file.name}`, size: file.size });
    queueMicrotask(() => {
      this.onload?.();
      this.onloadend?.();
    });
  }
  abort(): void {}
}

function answerUploads(status = 200, body: string | null = null): void {
  AnsweringXhr.sent = [];
  setXhrFactory(() => new AnsweringXhr(status, body) as unknown as XMLHttpRequest);
}

describe("the frame on the watch stream", () => {
  test("is routed to the transfer it names", () => {
    resetTransfers();
    const id = begin();

    onWatchEvent({ type: "transfer_queue", window_id: sessionWindowId(), transfer_id: id, state: "waiting", position: 4 });

    expect(transfers.items[0]!.queue).toEqual({ state: "waiting", position: 4 });
  });
});

describe("the tracking headers on an upload", () => {
  afterEach(() => setXhrFactory(null));

  test("name this window and the transfer, in lowercase, together", async () => {
    answerUploads();

    await api.uploadFile(new File(["x"], "a.md"), "", { transferId: "t-7" });

    expect(AnsweringXhr.sent[0]!.headers).toMatchObject({
      "x-chan-window-id": sessionWindowId(),
      "x-chan-transfer-id": "t-7",
    });
  });

  test("are both left off an untracked upload", async () => {
    answerUploads();

    await api.uploadFile(new File(["x"], "a.md"), "");

    expect(Object.keys(AnsweringXhr.sent[0]!.headers)).not.toContain("x-chan-window-id");
    expect(Object.keys(AnsweringXhr.sent[0]!.headers)).not.toContain("x-chan-transfer-id");
  });

  test("carry the transfer's own id on a new upload and on a replacement", async () => {
    installDemoWorkspace(demoData([{ path: "a.md", kind: "document", size: 5, mtime: 100, content: "hello" }]));
    try {
      tree.entries = [];
      tree.loadedDirs = {};
      await loadTreeDir("");
      answerUploads();
      resetTransfers();

      await fileOps.uploadFilesTo("", [new File(["new"], "b.md")]);
      await fileOps.replaceFileAt("a.md", new File(["again"], "a.md"));

      expect(AnsweringXhr.sent.map((xhr) => xhr.headers["x-chan-transfer-id"])).toEqual(
        transfers.items.map((item) => item.id),
      );
    } finally {
      uninstallDemoWorkspace();
      tree.entries = [];
    }
  });
});

describe("an upload the server refuses with 503", () => {
  afterEach(() => setXhrFactory(null));

  // Each body is what its sender answers: the server's transfer bound, a
  // stopping devserver, and the gateway's proxy, whose 503 is plain text.
  const STOPPING = `{"error":"the devserver is stopping","code":"devserver_stopping"}`;
  const REFUSALS: [whose: string, body: string, sentence: string, code: string | null][] = [
    [
      "the transfer bound's",
      `{"error":"too many transfers in progress; retry shortly"}`,
      "too many transfers in progress; retry shortly",
      null,
    ],
    ["a stopping devserver's", STOPPING, "the devserver is stopping", "devserver_stopping"],
    ["a proxy's plain", "entry capacity reached", "entry capacity reached", null],
  ];

  test.each(REFUSALS)("fails with %s sentence and code", async (_whose, body, sentence, code) => {
    answerUploads(503, body);

    const refused = await api.uploadFile(new File(["x"], "a.md"), "").catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(ApiError);
    expect({ message: (refused as ApiError).message, code: apiErrorCode(refused) }).toEqual({ message: sentence, code });
  });

  test("shows the server's sentence on the transfer's row and in the status line", async () => {
    installDemoWorkspace(demoData([]));
    try {
      tree.entries = [];
      tree.loadedDirs = {};
      await loadTreeDir("");
      answerUploads(503, STOPPING);
      resetTransfers();

      await fileOps.uploadFilesTo("", [new File(["new"], "b.md")]);

      expect({ row: transfers.items[0]?.error, status: ui.status }).toEqual({
        row: "the devserver is stopping",
        status: "upload failed: the devserver is stopping",
      });
      expect(transfers.items[0]?.state).toBe("failed");
    } finally {
      uninstallDemoWorkspace();
      tree.entries = [];
    }
  });
});

describe("the bytes the server actually emits", () => {
  // Verbatim from the server's own serialization tests, not retyped from the
  // contract prose. This is the half the browser could not check while it was
  // built against a written shape: these strings are what the wire carries, so
  // parsing them here proves the consumer matches the producer rather than
  // matching a description both sides read.
  const WAITING = `{"type":"transfer_queue","window_id":"w-1","transfer_id":"t-1","state":"waiting","position":2}`;
  const ACTIVE = `{"type":"transfer_queue","window_id":"w-1","transfer_id":"t-1","state":"active"}`;

  function feed(json: string, id: string): void {
    const frame = JSON.parse(json) as {
      type: string;
      transfer_id: string;
      state: "waiting" | "active";
      position?: number;
    };
    expect(frame.type).toBe("transfer_queue");
    applyTransferQueueFrame({ ...frame, transfer_id: id });
  }

  test("a real waiting frame yields the rank", () => {
    resetTransfers();
    const id = begin();
    feed(WAITING, id);
    expect(transfers.items[0]!.queue).toEqual({ state: "waiting", position: 2 });
  });

  test("a real active frame omits position entirely, and reads as no rank", () => {
    // The producer uses skip_serializing_if, so the key is absent rather than
    // null. Absent and null both have to land on null here, and neither may
    // become 0.
    expect(JSON.parse(ACTIVE)).not.toHaveProperty("position");
    resetTransfers();
    const id = begin();
    feed(WAITING, id);
    feed(ACTIVE, id);
    expect(transfers.items[0]!.queue).toEqual({ state: "active", position: null });
  });
});

describe("settling a transfer", () => {
  test("no terminal frame: the record settles on the HTTP response, not a frame", () => {
    // Completion and cancellation emit no frame. The HTTP response already
    // tells the browser the outcome, and a completion frame would race it, so
    // the record settles on the response and clears its rank there.
    resetTransfers();
    const id = begin();
    applyTransferQueueFrame({ transfer_id: id, state: "active" });
    finishTransfer(id);
    expect(transfers.items[0]!.state).toBe("done");
    expect(transfers.items[0]!.queue).toBeNull();
  });
});
