import { describe, expect, test } from "vitest";
import client from "./client.ts?raw";
import types from "./types.ts?raw";

describe("metadata archive api client", () => {
  test("download type carries the browser blob and archive headers", () => {
    expect(types).toMatch(/export type MetadataExportDownload = \{/);
    expect(types).toMatch(/blob: Blob;/);
    expect(types).toMatch(/filename: string;/);
    expect(types).toMatch(/files: number \| null;/);
    expect(types).toMatch(/bytes: number \| null;/);
  });

  test("metadataExport posts to the settings-gated download endpoint", () => {
    expect(client).toMatch(
      /metadataExport: async \(\): Promise<MetadataExportDownload> => \{/,
    );
    expect(client).toMatch(
      /chanFetch\(apiPath\("\/api\/metadata\/export"\), \{[\s\S]{1,160}method: "POST"/,
    );
    expect(client).toMatch(/headers: directAuthHeaders\(\)/);
    expect(client).toMatch(
      /contentDispositionFilename\(res\.headers\.get\("content-disposition"\)\)/,
    );
    expect(client).toMatch(/numericHeader\(res, "x-chan-metadata-files"\)/);
    expect(client).toMatch(/numericHeader\(res, "x-chan-metadata-bytes"\)/);
  });

  test("metadataImport posts multipart options to the import endpoint", () => {
    expect(types).toMatch(/export type MetadataImportReport = \{/);
    expect(types).toMatch(/manifest: MetadataManifest;/);
    expect(client).toMatch(
      /metadataImport: async \([\s\S]{1,220}Promise<MetadataImportReport> => \{/,
    );
    expect(client).toMatch(/form\.append\("file", file\)/);
    expect(client).toMatch(/form\.append\("rescan", opts\.rescan === false \? "false" : "true"\)/);
    expect(client).toMatch(/form\.append\("force_scm", opts\.forceScm \? "true" : "false"\)/);
    expect(client).toMatch(
      /chanFetch\(apiPath\("\/api\/metadata\/import"\), \{[\s\S]{1,180}method: "POST"/,
    );
  });
});
