// Stand-ins for what a page snapshot asks the engine for. jsdom decodes no
// image and paints nothing, so a test of the snapshot runs over an image
// that says when it has decoded and a canvas that records what was drawn
// on it.

import { vi } from "vitest";

export type HeldDecode = {
  src: string;
  settle: (decoded: boolean) => void;
};

let decodes: HeldDecode[] | null = null;

/// Start a fresh list of held decodes and return it. Every `StandInImage`
/// asked to decode adds itself here and waits for the test to settle it.
export function heldDecodes(): HeldDecode[] {
  decodes = [];
  return decodes;
}

/// Let every `StandInImage` decode at once, for a test that is not about
/// when an image decodes.
export function decodesSettleAtOnce(): void {
  decodes = null;
}

/// Give page images the load state jsdom cannot reach by decoding them.
export function pageImagesLoadedWhen(loaded: (img: HTMLImageElement) => boolean): void {
  vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockImplementation(function (this: HTMLImageElement) {
    return loaded(this);
  });
  vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockImplementation(function (this: HTMLImageElement) {
    return loaded(this) ? 40 : 0;
  });
  vi.spyOn(HTMLImageElement.prototype, "naturalHeight", "get").mockImplementation(function (this: HTMLImageElement) {
    return loaded(this) ? 20 : 0;
  });
}

export function loadedPageImages(): void {
  pageImagesLoadedWhen(() => true);
}

/// Give every loaded image a box. jsdom lays out nothing.
export function imagesHaveBoxes(): void {
  loadedPageImages();
  vi.spyOn(HTMLImageElement.prototype, "getClientRects").mockReturnValue([
    {},
  ] as unknown as DOMRectList);
}

/// The engine's `Image`. A page's own SVG document loads at once, as an
/// engine reports it; a decode is held until the test settles it.
export class StandInImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  decoding = "auto";
  naturalWidth = 40;
  naturalHeight = 20;
  #src = "";

  get src(): string {
    return this.#src;
  }

  set src(value: string) {
    this.#src = value;
    if (value.startsWith("data:image/svg+xml;utf8,")) {
      queueMicrotask(() => this.onload?.());
    }
  }

  decode(): Promise<void> {
    const held = decodes;
    if (!held) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      held.push({
        src: this.#src,
        settle: (decoded) =>
          decoded ? resolve() : reject(new Error("the image is broken")),
      });
    });
  }
}

export type Drawn = { what: "page" | "markers" | "image"; args: unknown[] };

export type MarkerBox = { x: number; y: number; w: number; h: number };

/// Install a canvas that records each draw and answers a read of its pixels
/// with the last page drawn on it: for each marker colour that page's
/// stylesheet gives an image, a block of that colour. The first is at
/// `markerBox` and each next one directly below the one before. `png` is
/// what the canvas encodes to.
export function standInCanvas(
  markerBox: MarkerBox,
  png: Uint8Array = new Uint8Array(4),
): Drawn[] {
  const drawn: Drawn[] = [];
  let lastPage = "";
  const context = {
    imageSmoothingEnabled: true,
    imageSmoothingQuality: "low",
    save: () => {},
    restore: () => {},
    beginPath: () => {},
    rect: () => {},
    clip: () => {},
    drawImage: (image: StandInImage, ...args: unknown[]) => {
      if (!image.src.startsWith("data:image/svg+xml;utf8,")) {
        drawn.push({ what: "image", args: [image, ...args] });
        return;
      }
      lastPage = decodeURIComponent(image.src);
      drawn.push({
        what: lastPage.includes("background-color") ? "markers" : "page",
        args,
      });
    },
    getImageData: (_x: number, _y: number, width: number, height: number) => {
      const data = new Uint8ClampedArray(width * height * 4);
      const colours = lastPage.matchAll(
        /background-color:\s*rgb\((\d+),\s*(\d+),\s*(\d+)\)/g,
      );
      let top = markerBox.y;
      for (const colour of colours) {
        for (let y = top; y < top + markerBox.h; y++) {
          for (let x = markerBox.x; x < markerBox.x + markerBox.w; x++) {
            const at = (y * width + x) * 4;
            data[at] = Number(colour[1]);
            data[at + 1] = Number(colour[2]);
            data[at + 2] = Number(colour[3]);
            data[at + 3] = 255;
          }
        }
        top += markerBox.h;
      }
      return { data, width, height };
    },
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () => context as unknown as CanvasRenderingContext2D,
  );
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(
    (done: BlobCallback) =>
      done({ arrayBuffer: async () => png.slice().buffer } as Blob),
  );
  return drawn;
}

/// Let every promise that can settle without the held decodes settle.
export async function settled(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
