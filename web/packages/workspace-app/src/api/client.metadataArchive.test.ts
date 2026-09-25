// @vitest-environment jsdom
//
// The metadata archive: export downloads the workspace's metadata as one
// archive through the settings-gated endpoint, with its name and counts in
// the response headers; import uploads an archive with its options as
// multipart and returns the server's report.

import { afterEach, describe, expect, test } from "vitest";
import { api } from "./client";
import { ApiError } from "./errors";
import type { MetadataImportReport } from "./types";
import { json, recordRequests, stopRecordingRequests } from "../__tests__/fetch";

afterEach(stopRecordingRequests);

const REPORT: MetadataImportReport = {
  manifest: {
    archive_format_version: 1,
    chan_version: "0.100.0",
    created_at: "2026-09-25T00:00:00Z",
    source_root: "/ws",
  } as MetadataImportReport["manifest"],
  imported_subtrees: [".chan"],
  files: 3,
  bytes: 2048,
  rescanned: true,
};

describe("metadata export", () => {
  test("POSTs to the export endpoint and returns the archive, its name and its counts", async () => {
    const requests = recordRequests(
      () =>
        new Response(new Uint8Array([1, 2, 3, 4]), {
          headers: {
            "content-disposition": 'attachment; filename="ws-metadata.tar.zst"',
            "x-chan-metadata-files": "3",
            "x-chan-metadata-bytes": "2048",
          },
        }),
    );
    const download = await api.metadataExport();

    expect(requests).toMatchObject([{ method: "POST", path: "/api/metadata/export", body: null }]);
    expect(download.blob.size).toBe(4);
    expect(download).toMatchObject({ filename: "ws-metadata.tar.zst", files: 3, bytes: 2048 });
  });

  test("falls back to the default name and no counts when the headers are missing", async () => {
    recordRequests(() => new Response(new Uint8Array([1])));

    await expect(api.metadataExport()).resolves.toMatchObject({
      filename: "chan-metadata.tar.zst",
      files: null,
      bytes: null,
    });
  });

  test("a refusal raises the server's message", async () => {
    recordRequests(() => json({ error: "settings are disabled" }, { status: 403 }));

    await expect(api.metadataExport()).rejects.toMatchObject({
      status: 403,
      message: "settings are disabled",
    } satisfies Partial<ApiError>);
  });
});

describe("metadata import", () => {
  test("uploads the archive as multipart, rescanning and not forcing SCM by default", async () => {
    const requests = recordRequests(() => json(REPORT));
    const archive = new File([new Uint8Array([9])], "ws-metadata.tar.zst");

    await expect(api.metadataImport(archive)).resolves.toEqual(REPORT);
    expect(requests).toMatchObject([{ method: "POST", path: "/api/metadata/import" }]);
    const form = requests[0]!.body as FormData;
    expect(form.get("file")).toBeInstanceOf(File);
    expect((form.get("file") as File).name).toBe("ws-metadata.tar.zst");
    expect(form.get("rescan")).toBe("true");
    expect(form.get("force_scm")).toBe("false");
  });

  test("carries the options the caller chose", async () => {
    const requests = recordRequests(() => json(REPORT));
    await api.metadataImport(new File([], "a.tar.zst"), { rescan: false, forceScm: true });

    const form = requests[0]!.body as FormData;
    expect(form.get("rescan")).toBe("false");
    expect(form.get("force_scm")).toBe("true");
  });
});
