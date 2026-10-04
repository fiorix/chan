// @vitest-environment jsdom
//
// An upload made for an export job names the job in a request header. The
// server reads it to refuse the write once the job has ended, or when the
// path is not the job's output. Uploads ride XHR, so each case answers the
// request with a stand-in and reads the headers it was given.

import { afterEach, expect, test } from "vitest";
import { api } from "./client";
import { setXhrFactory } from "./transport";

/// An XHR that records its request headers and answers 200.
class RecordingXhr {
  headers: Record<string, string> = {};
  status = 0;
  statusText = "";
  responseText = "";
  upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  onloadend: (() => void) | null = null;
  open(): void {}
  setRequestHeader(name: string, value: string): void {
    this.headers[name] = value;
  }
  send(): void {
    this.status = 200;
    this.responseText = JSON.stringify({ path: "notes/doc.pdf", size: 4 });
    queueMicrotask(() => {
      this.onload?.();
      this.onloadend?.();
    });
  }
  abort(): void {}
}

/// Answer every upload, and return the requests made, in order.
function recordUploads(): RecordingXhr[] {
  const sent: RecordingXhr[] = [];
  setXhrFactory(() => {
    const xhr = new RecordingXhr();
    sent.push(xhr);
    return xhr as unknown as XMLHttpRequest;
  });
  return sent;
}

const pdf = (): File => new File(["%PDF"], "doc.pdf", { type: "application/pdf" });

afterEach(() => setXhrFactory(null));

test("a replace and a create made for an export job name the job in x-chan-export-job", async () => {
  const sent = recordUploads();

  await api.replaceFile(pdf(), "notes/doc.pdf", { exportJob: "job-1" });
  await api.uploadFile(pdf(), "notes", { exportJob: "job-1" });

  expect(sent.map((xhr) => xhr.headers["x-chan-export-job"])).toEqual(["job-1", "job-1"]);
});

test("an upload made for no job sends no export job header", async () => {
  const sent = recordUploads();

  await api.replaceFile(pdf(), "notes/doc.pdf");

  expect(sent).toHaveLength(1);
  expect(Object.keys(sent[0]!.headers)).not.toContain("x-chan-export-job");
});
