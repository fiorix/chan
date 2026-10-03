// Self-contained page snapshots for the PDF export engine. A page
// element is made fully self-contained (every image, font, and url()
// reference inlined as a data: URI), audited so nothing external
// survives, then rasterized <svg><foreignObject> -> canvas -> PNG.
//
// The audit is load-bearing, not defensive polish: an SVG-image
// document loads NO external resources (same-origin included), so a
// missed reference rasterizes as a blank region or a broken-image
// glyph. Failing the export with a named offender beats shipping a
// silently incomplete PDF.
//
// An <img> is the one thing the page's SVG document is not trusted to
// paint. An engine may report the SVG image loaded before the images
// nested in it have loaded or decoded (WebKit does), and nothing outside
// that document can ask whether they have, so a page drawn at that load
// can come out with its text and without its pictures. Each image is
// therefore decoded here, in the app's own document, where `decode()`
// answers. The page keeps an empty stand-in of the image's size in its
// place, a second raster of the page with each stand-in filled with a
// marker colour says where it landed, and the decoded bitmap is drawn
// there. An image that does not decode, or that the page gives no place,
// fails the snapshot by name.

/// Default per-step timeout. Every await in the snapshot pipeline is
/// bounded so a wedged fetch or decode degrades to an error, never a
/// hang.
const DEFAULT_STEP_TIMEOUT_MS = 15_000;

/// Raster scale: CSS px -> device px. 2x keeps text legible in the
/// rasterized PDF at normal zoom.
export const RASTER_SCALE = 2;

/// Largest canvas we will allocate, mirroring diagram_copy.ts's bound:
/// a pathological page must not allocate an unbounded width*height*4
/// buffer.
const MAX_PAGE_PIXELS = 64 * 1024 * 1024;

export type PageBoxPx = { widthPx: number; heightPx: number };

export class SnapshotError extends Error {}

function withTimeout<T>(
  work: Promise<T>,
  ms: number,
  what: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new SnapshotError(`${what} timed out after ${ms}ms`)),
      ms,
    );
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/// Read a Blob as a base64 data: URL (the copy_html.ts pattern:
/// FileReader preserves the source bytes verbatim).
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result as string);
    fr.onerror = () => reject(fr.error ?? new Error("readAsDataURL failed"));
    fr.readAsDataURL(blob);
  });
}

/// Fetch a same-origin resource and return it as a data: URL, bounded
/// by `timeoutMs`. Returns null on any failure; the audit names the
/// leftover.
async function fetchAsDataUrl(
  url: string,
  timeoutMs: number,
): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(url, { signal: controller.signal });
      if (!resp.ok) return null;
      const blob = await resp.blob();
      return await withTimeout(blobToDataUrl(blob), timeoutMs, `encode ${url}`);
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

/// The media type a `data:` URL declares, lower-cased; "" when it
/// declares none.
function dataUrlType(url: string): string {
  const comma = url.indexOf(",");
  const header = url.slice("data:".length, comma < 0 ? url.length : comma);
  return header.split(";")[0]!.trim().toLowerCase();
}

/// What an error calls a resource: its address without the query, which
/// is where a window's token rides. An inline `data:` resource has no
/// address and is called by its media type.
function resourceName(url: string): string {
  if (url.startsWith("data:")) return `data:${dataUrlType(url)}`;
  const cut = url.search(/[?#]/);
  return cut < 0 ? url : url.slice(0, cut);
}

/// Whether a media type says its body is not an image. No type at all and
/// `application/octet-stream` say nothing either way: a server with no
/// media type for an extension answers the latter, an engine reads an
/// image by its bytes, and the decode settles it.
function notAnImageType(type: string): boolean {
  return !(
    type.startsWith("image/") ||
    type === "" ||
    type === "application/octet-stream"
  );
}

/// Fetch an image and return it as a data: URL, or null when the fetch
/// fails, which the audit names. An address that answers with a body
/// that is not an image refuses the page here: once inlined, the element
/// would no longer say where the body came from.
async function fetchImageAsDataUrl(
  url: string,
  timeoutMs: number,
): Promise<string | null> {
  const inlined = await fetchAsDataUrl(url, timeoutMs);
  if (inlined && notAnImageType(dataUrlType(inlined))) {
    throw new SnapshotError(
      `image ${resourceName(url)} is ${dataUrlType(inlined)}, not an image`,
    );
  }
  return inlined;
}

/// The address each inlined image was fetched from. Once its `src` is a
/// `data:` URI the element no longer says, and an error has to.
const sourceNames = new WeakMap<Element, string>();

/// Where an SVG <image> or <use> names what it draws.
const IMAGE_HREF_ATTRS = ["href", "xlink:href"];

const URL_TOKEN_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;

function isInlineUrl(value: string): boolean {
  return value.startsWith("data:") || value.startsWith("#");
}

/// Rewrite every non-data: url(...) token in a CSS text by fetching and
/// inlining it. Unresolvable tokens stay verbatim for the audit.
async function inlineCssUrls(css: string, timeoutMs: number): Promise<string> {
  const targets = new Map<string, string | null>();
  for (const match of css.matchAll(URL_TOKEN_RE)) {
    const url = match[2]!;
    if (!isInlineUrl(url) && !targets.has(url)) targets.set(url, null);
  }
  for (const url of targets.keys()) {
    targets.set(url, await fetchAsDataUrl(url, timeoutMs));
  }
  return css.replace(URL_TOKEN_RE, (token, _quote, url: string) => {
    const inlined = targets.get(url);
    return inlined ? `url(${inlined})` : token;
  });
}

const FONT_FACE_BLOCK_RE = /@font-face\s*\{[^}]*\}/g;
const FONT_FAMILY_DESC_RE = /font-family\s*:\s*(['"]?)([^'";}]+)\1/i;

/// Raw CSS text of a document stylesheet. A <style> owner node carries
/// the authored text (which keeps `src` descriptors that some CSSOM
/// serializers drop); link-loaded sheets fall back to the browser's
/// cssText, which is complete in every shipping engine.
function styleSheetText(sheet: CSSStyleSheet): string {
  if (sheet.ownerNode instanceof HTMLStyleElement) {
    return sheet.ownerNode.textContent ?? "";
  }
  try {
    return Array.from(sheet.cssRules)
      .map((rule) => rule.cssText)
      .join("\n");
  } catch {
    return ""; // cross-origin sheet; the app bundles none.
  }
}

/// Collect the app's @font-face rules whose family the page references,
/// inline their src urls, and prepend them as a <style> on the page.
/// The page's own <style> elements (e.g. the ones excalidraw exports
/// carry inside their SVG) are inlined in place.
async function inlineFonts(root: HTMLElement, timeoutMs: number): Promise<void> {
  // Page-embedded styles first: excalidraw SVG exports declare their
  // fonts in an inner <style> with /static/excalidraw/ urls.
  for (const style of Array.from(root.querySelectorAll("style"))) {
    const css = style.textContent ?? "";
    URL_TOKEN_RE.lastIndex = 0;
    if (URL_TOKEN_RE.test(css)) {
      URL_TOKEN_RE.lastIndex = 0;
      style.textContent = await inlineCssUrls(css, timeoutMs);
    }
    URL_TOKEN_RE.lastIndex = 0;
  }

  // App-level @font-face rules (fonts.css: the bundled code font). Only
  // families the page actually references ride along.
  const pageHtml = root.outerHTML.toLowerCase();
  const faces: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    for (const block of styleSheetText(sheet).match(FONT_FACE_BLOCK_RE) ?? []) {
      const family = block.match(FONT_FAMILY_DESC_RE)?.[2]?.trim();
      if (!family || !pageHtml.includes(family.toLowerCase())) continue;
      faces.push(block);
    }
  }
  if (faces.length === 0) return;
  const style = document.createElement("style");
  style.textContent = await inlineCssUrls(faces.join("\n"), timeoutMs);
  root.prepend(style);
}

/// Inline every <img> src and every SVG <image> href under the page.
async function inlineImages(root: HTMLElement, timeoutMs: number): Promise<void> {
  for (const img of Array.from(root.querySelectorAll("img"))) {
    const src = img.getAttribute("src") ?? "";
    if (!src || isInlineUrl(src)) continue;
    const inlined = await fetchImageAsDataUrl(src, timeoutMs);
    if (!inlined) continue;
    img.setAttribute("src", inlined);
    sourceNames.set(img, resourceName(src));
  }
  for (const image of Array.from(root.querySelectorAll("image"))) {
    for (const attr of IMAGE_HREF_ATTRS) {
      const href = image.getAttribute(attr);
      if (!href || isInlineUrl(href)) continue;
      const inlined = await fetchImageAsDataUrl(href, timeoutMs);
      if (!inlined) continue;
      image.setAttribute(attr, inlined);
      sourceNames.set(image, resourceName(href));
    }
  }
}

/// Make the page self-contained: images, SVG image hrefs, url() tokens
/// in embedded styles and style attributes, and the app font faces the
/// page references. Unresolvable references are left in place for
/// `auditSelfContained` to reject by name.
export async function inlinePageResources(
  root: HTMLElement,
  timeoutMs: number = DEFAULT_STEP_TIMEOUT_MS,
): Promise<void> {
  await inlineFonts(root, timeoutMs);
  await inlineImages(root, timeoutMs);
  for (const el of Array.from(root.querySelectorAll<HTMLElement>("[style]"))) {
    const css = el.getAttribute("style") ?? "";
    URL_TOKEN_RE.lastIndex = 0;
    if (URL_TOKEN_RE.test(css)) {
      URL_TOKEN_RE.lastIndex = 0;
      el.setAttribute("style", await inlineCssUrls(css, timeoutMs));
    }
  }
}

/// Marks an <img> whose pixels the snapshot paints itself. The value is
/// the image's index in its `PageImages`.
const LIFTED_ATTR = "data-chan-export-image";

/// Marks an SVG <image> whose bytes have decoded, so a page cloned from a
/// lifted document does not decode it again.
const DECODED_ATTR = "data-chan-export-decoded";

/// On the page root while its marker raster is drawn.
const MARKER_ATTR = "data-chan-export-markers";

/// How many marker colours one raster tells apart; a page with more
/// images to place draws more marker rasters.
const MARKER_SLOTS = 30;

type LiftedImage = {
  name: string;
  /// The image, decoded in the app's own document.
  bitmap: HTMLImageElement;
  widthPx: number;
  heightPx: number;
  /// Whether the image had a box where the page was composed. One with
  /// none (inside a closed <details>, say) has nothing to paint, and
  /// that is not a failure.
  rendered: boolean;
  /// Raster rows of the image painted so far. A document image taller
  /// than what is left of its page continues on the next one.
  shownPx: number;
  painted: boolean;
  /// The image's last row has been painted.
  done: boolean;
};

/// The images one export paints itself. A document hands the same one to
/// each of its pages: its images are lifted once, before the pages are
/// cloned, an image cut by a page continues on the next, and by the last
/// page every image that has a place must have been painted.
export class PageImages {
  /// In lifting order; `LIFTED_ATTR` holds the index.
  readonly lifted: LiftedImage[] = [];

  /// Fail by name for each image that has a place and was never painted.
  assertPainted(): void {
    const missing = this.lifted
      .filter((image) => image.rendered && !image.painted)
      .map((image) => image.name);
    if (missing.length > 0) {
      throw new SnapshotError(
        `image has no place on the page: ${missing.join("; ")}`,
      );
    }
  }
}

/// Decode an image in the app's own document, bounded by `timeoutMs`.
async function decodeImage(
  src: string,
  name: string,
  timeoutMs: number,
): Promise<HTMLImageElement> {
  const image = new Image();
  image.src = src;
  try {
    await withTimeout(image.decode(), timeoutMs, `decode of image ${name}`);
  } catch (err) {
    if (err instanceof SnapshotError) throw err;
    throw new SnapshotError(`image ${name} could not be decoded`);
  }
  return image;
}

/// An empty image of the given size. It gives the page's <img> the box
/// the real image would, and paints nothing.
function standInSrc(widthPx: number, heightPx: number): string {
  return (
    "data:image/svg+xml," +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${widthPx}" height="${heightPx}"/>`,
    )
  );
}

/// Take every inlined <img> out of the page's own painting: decode it
/// here, record it in `images`, and leave a stand-in of its size in its
/// place. Runs after `inlinePageResources`; an image already lifted is
/// left alone, so a page cloned from a lifted document costs nothing.
///
/// The stand-in is itself an image the page's document loads, and an
/// engine that draws before it has loaded would lay the <img> out with
/// no size. The width hint and the aspect ratio make the box the same
/// either way; an author's own width, height or ratio is kept.
export async function liftPageImages(
  root: HTMLElement,
  images: PageImages,
  timeoutMs: number = DEFAULT_STEP_TIMEOUT_MS,
): Promise<void> {
  for (const img of Array.from(root.querySelectorAll("img"))) {
    if (img.hasAttribute(LIFTED_ATTR)) continue;
    const src = img.getAttribute("src") ?? "";
    if (!src.startsWith("data:")) continue;
    const name = sourceNames.get(img) ?? resourceName(src);
    const bitmap = await decodeImage(src, name, timeoutMs);
    const widthPx = bitmap.naturalWidth;
    const heightPx = bitmap.naturalHeight;
    // An image with no size of its own (an SVG that declares none) takes
    // its box from the page's style alone, which a stand-in cannot
    // reproduce. It stays in the page's document.
    if (!(widthPx > 0 && heightPx > 0)) continue;
    img.setAttribute(LIFTED_ATTR, String(images.lifted.length));
    images.lifted.push({
      name,
      bitmap,
      widthPx,
      heightPx,
      rendered: !root.isConnected || img.getClientRects().length > 0,
      shownPx: 0,
      painted: false,
      done: false,
    });
    img.setAttribute("src", standInSrc(widthPx, heightPx));
    img.removeAttribute("loading");
    if (!img.hasAttribute("width") && !img.hasAttribute("height")) {
      img.setAttribute("width", String(widthPx));
    }
    if (!img.style.getPropertyValue("aspect-ratio")) {
      img.style.setProperty("aspect-ratio", `${widthPx} / ${heightPx}`);
    }
  }
  // An <image> of an inline SVG is drawn inside that SVG, under and over
  // its other shapes, so it stays in the page's document. Decoding it
  // here still proves its bytes are an image before any page is drawn.
  for (const image of Array.from(root.querySelectorAll("image"))) {
    if (image.hasAttribute(DECODED_ATTR)) continue;
    for (const attr of IMAGE_HREF_ATTRS) {
      const href = image.getAttribute(attr);
      if (!href?.startsWith("data:")) continue;
      await decodeImage(
        href,
        sourceNames.get(image) ?? resourceName(href),
        timeoutMs,
      );
      image.setAttribute(DECODED_ATTR, "");
    }
  }
}

/// The colour that marks slot `slot` of a marker raster. Red carries the
/// slot, green is its complement and blue is fixed, so a pixel that is
/// not a marker (a blend at an edge, anything else that got painted)
/// fails the two checks and is not read as one.
export function markerRgb(slot: number): [number, number, number] {
  const red = 8 * (slot + 1);
  return [red, 255 - red, 128];
}

/// The stylesheet of a marker raster: everything on the page hidden,
/// and the content box of each image in `ids` filled with its slot's
/// colour. Opacity and filters are lifted so a marker keeps its colour.
function markerCss(ids: readonly number[]): string {
  const rules = [
    `[${MARKER_ATTR}],[${MARKER_ATTR}] *{visibility:hidden !important;` +
      "opacity:1 !important;filter:none !important}",
  ];
  ids.forEach((id, slot) => {
    const [red, green, blue] = markerRgb(slot);
    rules.push(
      `[${MARKER_ATTR}] img[${LIFTED_ATTR}="${id}"]{visibility:visible !important;` +
        `background-color: rgb(${red}, ${green}, ${blue}) !important;` +
        "background-image:none !important;background-clip:content-box !important;" +
        "border-color:transparent !important;outline:none !important;" +
        "box-shadow:none !important}",
    );
  });
  return rules.join("\n");
}

export type MarkerBox = { x: number; y: number; width: number; height: number };

/// Where each marker colour landed: per slot, the box of the pixels that
/// carry its colour, or null when no pixel does.
export function readMarkerBoxes(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  slots: number,
): (MarkerBox | null)[] {
  const left = new Array<number>(slots).fill(width);
  const top = new Array<number>(slots).fill(height);
  const right = new Array<number>(slots).fill(-1);
  const bottom = new Array<number>(slots).fill(-1);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4;
      if (data[at + 3]! < 128) continue;
      const red = data[at]!;
      if (Math.abs(data[at + 2]! - 128) > 8) continue;
      if (Math.abs(red + data[at + 1]! - 255) > 8) continue;
      const slot = Math.round(red / 8) - 1;
      if (slot < 0 || slot >= slots) continue;
      if (Math.abs(red - 8 * (slot + 1)) > 3) continue;
      if (x < left[slot]!) left[slot] = x;
      if (x > right[slot]!) right[slot] = x;
      if (y < top[slot]!) top[slot] = y;
      if (y > bottom[slot]!) bottom[slot] = y;
    }
  }
  return left.map((x, slot) =>
    right[slot]! < 0
      ? null
      : {
          x,
          y: top[slot]!,
          width: right[slot]! - x + 1,
          height: bottom[slot]! - top[slot]! + 1,
        },
  );
}

export type ImagePlacement = {
  /// Where the whole bitmap is drawn, in raster px.
  x: number;
  y: number;
  width: number;
  height: number;
  /// Rows of the image painted once this draw is clipped to its box.
  shownPx: number;
  /// Whether the image's last row is among them.
  done: boolean;
};

/// Where a lifted image's bitmap goes, given the box its marker filled,
/// which is the part of the image this page shows. A box of the image's
/// own proportions shows all of it and the bitmap fills it. A shorter
/// box is an image the page cuts: the bitmap keeps its proportions at
/// the box's width and starts `shownPx` rows above the box, where the
/// page before left off. The caller clips the draw to the box.
export function placeLiftedImage(
  box: MarkerBox,
  natural: { widthPx: number; heightPx: number },
  shownPx: number,
): ImagePlacement {
  const ratio = natural.heightPx / natural.widthPx;
  const fullHeight = box.width * ratio;
  // The box is read in whole pixels, so its width is off by up to one
  // and the height that follows from it by up to `ratio`.
  const slack = 1.5 + 1.5 * ratio;
  if (shownPx === 0 && box.height >= fullHeight - slack) {
    return { ...box, shownPx: box.height, done: true };
  }
  const shown = shownPx + box.height;
  return {
    x: box.x,
    y: box.y - shownPx,
    width: box.width,
    height: fullHeight,
    shownPx: shown,
    done: shown >= fullHeight - slack,
  };
}

function externalUrlTokens(css: string): string[] {
  const out: string[] = [];
  URL_TOKEN_RE.lastIndex = 0;
  for (const match of css.matchAll(URL_TOKEN_RE)) {
    const url = match[2]!;
    if (!isInlineUrl(url)) out.push(url);
  }
  return out;
}

/// Whether a reference is a `data:` URI whose type is not an image's.
function notAnImageData(url: string): boolean {
  return url.startsWith("data:") && notAnImageType(dataUrlType(url));
}

/// The addresses a srcset offers, each as an error calls it.
function srcsetNames(srcset: string): string {
  return srcset
    .split(",")
    .map((candidate) => candidate.trim().split(/\s+/)[0] ?? "")
    .filter(Boolean)
    .map(resourceName)
    .join(", ");
}

/// Reject any external reference left on the page. Anchor hrefs are
/// page CONTENT (never fetched during raster) and pass; everything an
/// SVG-image document would try to LOAD must be a data: URI by now, an
/// image's must be of an image's type, and no image may be offered
/// through a srcset. Throws a SnapshotError naming every offender, each
/// address without its query.
export function auditSelfContained(root: HTMLElement): void {
  const offenders: string[] = [];

  for (const img of Array.from(root.querySelectorAll("img"))) {
    const src = img.getAttribute("src") ?? "";
    if (src && !isInlineUrl(src)) {
      offenders.push(`img src ${resourceName(src)}`);
    } else if (notAnImageData(src)) {
      offenders.push(`img src ${resourceName(src)} is not an image`);
    }
  }
  for (const image of Array.from(root.querySelectorAll("image, use"))) {
    const tag = image.tagName.toLowerCase();
    for (const attr of IMAGE_HREF_ATTRS) {
      const href = image.getAttribute(attr);
      if (href && !isInlineUrl(href)) {
        offenders.push(`${tag} ${attr} ${resourceName(href)}`);
      } else if (href && tag === "image" && notAnImageData(href)) {
        offenders.push(`${tag} ${attr} ${resourceName(href)} is not an image`);
      }
    }
  }
  // A srcset, on an <img> or on a <source> of a <picture>, offers images
  // the snapshot neither inlines nor paints, and the engine would pick
  // one of them over the image the snapshot did.
  for (const el of Array.from(
    root.querySelectorAll("img[srcset], source[srcset]"),
  )) {
    offenders.push(
      `${el.tagName.toLowerCase()} srcset ${srcsetNames(el.getAttribute("srcset") ?? "")}`,
    );
  }
  for (const el of Array.from(
    root.querySelectorAll(
      "script, iframe, embed, object, video, audio, source:not([srcset]), link",
    ),
  )) {
    offenders.push(`disallowed element <${el.tagName.toLowerCase()}>`);
  }
  for (const style of Array.from(root.querySelectorAll("style"))) {
    for (const url of externalUrlTokens(style.textContent ?? "")) {
      offenders.push(`style url() ${url}`);
    }
  }
  for (const el of Array.from(root.querySelectorAll<HTMLElement>("[style]"))) {
    for (const url of externalUrlTokens(el.getAttribute("style") ?? "")) {
      offenders.push(`inline style url() ${url}`);
    }
  }

  if (offenders.length > 0) {
    throw new SnapshotError(
      `page is not self-contained: ${offenders.join("; ")}`,
    );
  }
}

/// Serialize the page element into an <svg><foreignObject> document.
/// XMLSerializer emits well-formed XHTML with the namespace on the
/// root, which is what the foreignObject content model requires.
export function pageSvgDocument(root: HTMLElement, box: PageBoxPx): string {
  const xhtml = new XMLSerializer().serializeToString(root);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${box.widthPx}" height="${box.heightPx}">` +
    `<foreignObject width="100%" height="100%">${xhtml}</foreignObject></svg>`
  );
}

/// Decode an SVG document into an image, bounded by `timeoutMs`.
function loadSvgPageImage(
  svgDoc: string,
  timeoutMs: number,
): Promise<HTMLImageElement> {
  const img = new Image();
  const loaded = new Promise<HTMLImageElement>((resolve, reject) => {
    img.onload = () => resolve(img);
    img.onerror = () => reject(new SnapshotError("page SVG decode failed"));
  });
  img.src = `data:image/svg+xml;utf8,${encodeURIComponent(svgDoc)}`;
  return withTimeout(loaded, timeoutMs, "page SVG decode");
}

/// Rasterize a self-contained page element to a canvas at
/// `scale` device px per CSS px. The caller runs the audit first;
/// this step only draws.
export async function rasterizePage(
  root: HTMLElement,
  box: PageBoxPx,
  opts: { scale?: number; timeoutMs?: number } = {},
): Promise<HTMLCanvasElement> {
  const scale = opts.scale ?? RASTER_SCALE;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
  const width = Math.ceil(box.widthPx * scale);
  const height = Math.ceil(box.heightPx * scale);
  if (width * height > MAX_PAGE_PIXELS) {
    throw new SnapshotError(
      `page raster ${width}x${height} exceeds the pixel budget`,
    );
  }
  const img = await loadSvgPageImage(pageSvgDocument(root, box), timeoutMs);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new SnapshotError("no 2d canvas context");
  ctx.drawImage(img, 0, 0, width, height);
  return canvas;
}

/// Rasterize the page with every image in `ids` reduced to its marker.
async function markerRaster(
  root: HTMLElement,
  box: PageBoxPx,
  ids: readonly number[],
  opts: { scale?: number; timeoutMs?: number },
): Promise<HTMLCanvasElement> {
  const style = document.createElement("style");
  style.textContent = markerCss(ids);
  root.setAttribute(MARKER_ATTR, "");
  root.prepend(style);
  try {
    return await rasterizePage(root, box, opts);
  } finally {
    style.remove();
    root.removeAttribute(MARKER_ATTR);
  }
}

/// Draw each lifted image of the page onto its raster, at the place its
/// marker reads back from a marker raster of the same page. An image the
/// page does not show (on another page of its document) leaves no marker
/// and is not drawn here.
async function paintLiftedImages(
  canvas: HTMLCanvasElement,
  root: HTMLElement,
  box: PageBoxPx,
  images: PageImages,
  opts: { scale?: number; timeoutMs?: number },
): Promise<void> {
  const pending: number[] = [];
  for (const img of Array.from(root.querySelectorAll(`img[${LIFTED_ATTR}]`))) {
    const id = Number(img.getAttribute(LIFTED_ATTR));
    const image = images.lifted[id];
    if (image && image.rendered && !image.done) pending.push(id);
  }
  if (pending.length === 0) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new SnapshotError("no 2d canvas context");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  for (let at = 0; at < pending.length; at += MARKER_SLOTS) {
    const ids = pending.slice(at, at + MARKER_SLOTS);
    const markers = await markerRaster(root, box, ids, opts);
    const pixels = markers
      .getContext("2d")
      ?.getImageData(0, 0, markers.width, markers.height);
    if (!pixels) throw new SnapshotError("no 2d canvas context");
    const boxes = readMarkerBoxes(
      pixels.data,
      pixels.width,
      pixels.height,
      ids.length,
    );
    boxes.forEach((markerBox, slot) => {
      if (!markerBox) return;
      const image = images.lifted[ids[slot]!]!;
      const place = placeLiftedImage(markerBox, image, image.shownPx);
      ctx.save();
      ctx.beginPath();
      ctx.rect(markerBox.x, markerBox.y, markerBox.width, markerBox.height);
      ctx.clip();
      ctx.drawImage(image.bitmap, place.x, place.y, place.width, place.height);
      ctx.restore();
      image.shownPx = place.shownPx;
      image.painted = true;
      image.done = place.done;
    });
  }
}

/// Canvas -> PNG bytes.
export async function canvasPngBytes(
  canvas: HTMLCanvasElement,
  timeoutMs: number = DEFAULT_STEP_TIMEOUT_MS,
): Promise<Uint8Array> {
  const blob = await withTimeout(
    new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new SnapshotError("toBlob failed"))),
        "image/png",
      );
    }),
    timeoutMs,
    "PNG encode",
  );
  return new Uint8Array(await blob.arrayBuffer());
}

export type PageSnapshot = {
  png: Uint8Array;
  /// Raster size in device px (CSS px * scale).
  widthPx: number;
  heightPx: number;
};

export type SnapshotOptions = {
  scale?: number;
  timeoutMs?: number;
  /// The images of the document this page belongs to, shared by its
  /// pages. Left out, the page is a whole export: its images are its own
  /// and each must be painted on it.
  images?: PageImages;
  /// With `images`: this is the document's last page, so every image
  /// that has a place has had its page.
  lastPage?: boolean;
};

/// The full snapshot pipeline for one page element: inline -> lift the
/// images -> audit -> raster -> paint the images -> PNG.
export async function snapshotPage(
  root: HTMLElement,
  box: PageBoxPx,
  opts: SnapshotOptions = {},
): Promise<PageSnapshot> {
  const images = opts.images ?? new PageImages();
  await inlinePageResources(root, opts.timeoutMs);
  await liftPageImages(root, images, opts.timeoutMs);
  auditSelfContained(root);
  const canvas = await rasterizePage(root, box, opts);
  await paintLiftedImages(canvas, root, box, images, opts);
  if (!opts.images || opts.lastPage) images.assertPainted();
  return {
    png: await canvasPngBytes(canvas, opts.timeoutMs),
    widthPx: canvas.width,
    heightPx: canvas.height,
  };
}
