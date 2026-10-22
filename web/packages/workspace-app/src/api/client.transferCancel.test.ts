// @vitest-environment jsdom
//
// The cancel of a tracked upload: the request is aborted first, then the
// server is asked to withdraw it under the same window and transfer pair, and
// the rejection carries the server's answer. An untracked upload, or a request
// that has already answered, sends no cancel.

import { afterEach, describe, expect, test } from "vitest";

import { api, sessionWindowId, UploadAbortError } from "./client";
import { setFetchImpl, setXhrFactory } from "./transport";

/// Every step the client takes, in order: an XHR abort, or a fetch with its
/// method, path, headers and options.
const steps: string[] = [];
const cancels: { headers: Headers; init: RequestInit }[] = [];

/// An upload request that stays open until the test answers it.
class HeldXhr {
  static last: HeldXhr | null = null;
  status = 0;
  statusText = "";
  responseText = "";
  upload: { onprogress: (() => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  onloadend: (() => void) | null = null;
  constructor() {
    HeldXhr.last = this;
  }
  open(): void {}
  setRequestHeader(): void {}
  sent = false;
  send(): void {
    this.sent = true;
    steps.push("upload sent");
  }
  // A real XHR fires its abort and loadend events inside abort() once the
  // request was sent, and none for one aborted before send().
  abort(): void {
    steps.push("upload aborted");
    if (!this.sent) return;
    this.onabort?.();
    this.onloadend?.();
  }
  finish(): void {
    this.status = 200;
    this.responseText = JSON.stringify({ path: "docs/c.md", size: 1 });
    this.onload?.();
    this.onloadend?.();
  }
}

function serve(answer: () => Response): void {
  HeldXhr.last = null;
  setXhrFactory(() => new HeldXhr() as unknown as XMLHttpRequest);
  setFetchImpl(async (input, init = {}) => {
    const path = new URL(input, "http://x").pathname;
    steps.push(`${init.method ?? "GET"} ${path}`);
    if (path === "/api/transfers/cancel") cancels.push({ headers: new Headers(init.headers), init });
    return answer();
  });
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => {
  setXhrFactory(null);
  setFetchImpl(null);
  steps.length = 0;
  cancels.length = 0;
});

async function abortedUpload(transferId?: string): Promise<UploadAbortError> {
  const abort = new AbortController();
  const sent = api.uploadFile(new File(["x"], "c.md"), "docs", { signal: abort.signal, transferId });
  abort.abort();
  const err = await sent.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(UploadAbortError);
  return err as UploadAbortError;
}

describe("the cancel of a tracked upload", () => {
  test("aborts the request, then asks the server to withdraw it under the window and the transfer it named", async () => {
    serve(() => json({ status: "cancel_requested" }));

    const err = await abortedUpload("xfer-w-n-1");

    await expect(err.cancelOutcome).resolves.toBe("cancel_requested");
    expect(steps).toEqual(["upload sent", "upload aborted", "POST /api/transfers/cancel"]);
    expect(cancels).toHaveLength(1);
    expect(cancels[0]!.headers.get("x-chan-window-id")).toBe(sessionWindowId());
    expect(cancels[0]!.headers.get("x-chan-transfer-id")).toBe("xfer-w-n-1");
    expect(cancels[0]!.init.keepalive, "the cancel outlives the page's own teardown").toBe(true);
    expect(cancels[0]!.init.body ?? null).toBeNull();
  });

  test.each([
    [json({ status: "not_cancellable" }), "not_cancellable"],
    [json({ status: "not_found" }), "not_found"],
    [json({ error: "window and transfer tracking headers are required", code: "transfer_tracking_required" }, 400), "unknown"],
    [new Response("<html>bad gateway</html>", { status: 502 }), "unknown"],
    [json({ status: "something else" }), "unknown"],
  ] as const)("carries the server's answer on the rejection (%#)", async (response, outcome) => {
    serve(() => response.clone());

    const err = await abortedUpload("xfer-w-n-2");

    await expect(err.cancelOutcome).resolves.toBe(outcome);
  });

  test("sends no cancel for an untracked upload", async () => {
    serve(() => json({ status: "cancel_requested" }));

    const err = await abortedUpload();

    expect(err.cancelOutcome).toBeNull();
    expect(steps).toEqual(["upload sent", "upload aborted"]);
  });

  test("sends no cancel when the request has already answered", async () => {
    serve(() => json({ status: "cancel_requested" }));
    const abort = new AbortController();
    const sent = api.uploadFile(new File(["x"], "c.md"), "docs", { signal: abort.signal, transferId: "xfer-w-n-3" });

    HeldXhr.last!.finish();
    await expect(sent).resolves.toEqual({ path: "docs/c.md", size: 1 });
    abort.abort();

    expect(steps).toEqual(["upload sent"]);
  });

  test("an upload whose signal aborted before it was sent rejects at once, with not_found and no cancel", async () => {
    serve(() => json({ status: "cancel_requested" }));
    const abort = new AbortController();
    abort.abort();

    const sent = api.uploadFile(new File(["x"], "c.md"), "docs", { signal: abort.signal, transferId: "xfer-w-n-4" });
    // The rejection settles within the task that made it, through the
    // upload's async layers; a promise left pending is still pending at the
    // next task, which is the bound here, not a wait.
    const err = await Promise.race([sent.catch((e: unknown) => e), new Promise((resolve) => setTimeout(() => resolve("pending"), 0))]);

    expect(err).toBeInstanceOf(UploadAbortError);
    await expect((err as UploadAbortError).cancelOutcome).resolves.toBe("not_found");
    expect(steps).toEqual(["upload aborted"]);
    expect(cancels).toHaveLength(0);
  });
});
