// @vitest-environment jsdom
//
// A browser download goes through one temporary anchor: the blob's object
// URL as its href and the file name as its download attribute, hidden,
// attached for the click and removed after it. The object URL is released a
// task later, so the click has started before it goes.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { downloadBlob, downloadBytes } from "./download";

type Click = {
  href: string;
  download: string;
  rel: string;
  display: string;
  attached: boolean;
};

const createObjectURL = vi.fn<(blob: Blob) => string>();
const revokeObjectURL = vi.fn<(url: string) => void>();
let clicks: Click[];

beforeEach(() => {
  vi.useFakeTimers();
  clicks = [];
  createObjectURL.mockReset().mockReturnValue("blob:chan/1");
  revokeObjectURL.mockReset();
  // jsdom implements neither.
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    clicks.push({
      href: this.href,
      download: this.download,
      rel: this.rel,
      display: this.style.display,
      attached: this.isConnected,
    });
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  Reflect.deleteProperty(URL, "createObjectURL");
  Reflect.deleteProperty(URL, "revokeObjectURL");
});

describe("downloadBlob", () => {
  test("clicks a hidden anchor for the blob's object URL and removes it", () => {
    const blob = new Blob(["archive"]);

    downloadBlob(blob, "metadata.tar.gz");

    expect(createObjectURL).toHaveBeenCalledExactlyOnceWith(blob);
    expect(clicks).toEqual([
      {
        href: "blob:chan/1",
        download: "metadata.tar.gz",
        rel: "noopener",
        display: "none",
        attached: true,
      },
    ]);
    expect(document.querySelector("a")).toBeNull();
  });

  test("releases the object URL a task after the click, not before", () => {
    downloadBlob(new Blob(["archive"]), "metadata.tar.gz");

    expect(clicks).toHaveLength(1);
    expect(revokeObjectURL).not.toHaveBeenCalled();

    vi.runAllTimers();

    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:chan/1");
  });
});

describe("downloadBytes", () => {
  test("downloads its bytes as a blob of the named type", async () => {
    downloadBytes(new Uint8Array([1, 2, 3]), "page.pdf", "application/pdf");

    const blob = createObjectURL.mock.calls[0][0];
    expect(blob.type).toBe("application/pdf");
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(clicks.map((click) => click.download)).toEqual(["page.pdf"]);
  });

  test("names a generic binary type when given none", () => {
    downloadBytes(new Uint8Array([1]), "blob.bin");

    expect(createObjectURL.mock.calls[0][0].type).toBe("application/octet-stream");
  });
});
