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
// there. An image that does not decode fails by name. When the lift cannot
// place one, its inlined source remains for the page document to paint.

/// Default per-step timeout. Every await in the snapshot pipeline is
/// bounded so a wedged fetch or decode degrades to an error, never a
/// hang.
export const DEFAULT_STEP_TIMEOUT_MS = 15_000;

/// Prepare independent images together without letting a large document
/// start an unbounded number of fetches or decodes at once.
export const IMAGE_PREP_BATCH = 8;

/// Run `work` over one batch of images together and return what each
/// made, in order.
///
/// When an image fails, the images after it in the document are aborted
/// and not waited for, the ones before it are, and the failure thrown is
/// the first in the document: which image an export names does not depend
/// on which of them an engine settles first.
function runImageBatch<T, U>(
  batch: readonly T[],
  work: (item: T, stop: AbortSignal) => Promise<U>,
  parentStop?: AbortSignal,
): Promise<U[]> {
  return new Promise<U[]>((resolve, reject) => {
    const stops = batch.map(() => new AbortController());
    const values = new Array<U>(batch.length);
    const settled = batch.map(() => false);
    let failedAt = batch.length;
    let failure: unknown;
    let finished = false;
    const finish = (failed: boolean, error?: unknown): void => {
      if (finished) return;
      finished = true;
      parentStop?.removeEventListener("abort", abort);
      if (failed) reject(error);
      else resolve(values);
    };
    const abort = (): void => {
      for (const stop of stops) stop.abort();
      finish(true, new SnapshotError("image preparation stopped"));
    };
    if (parentStop?.aborted) {
      abort();
      return;
    }
    parentStop?.addEventListener("abort", abort, { once: true });
    const decide = (): void => {
      if (finished) return;
      // An image before the first failure may still fail before it.
      if (settled.slice(0, failedAt).includes(false)) return;
      if (failedAt < batch.length) finish(true, failure);
      else finish(false);
    };
    batch.forEach((item, index) => {
      work(item, stops[index]!.signal).then(
        (value) => {
          values[index] = value;
          settled[index] = true;
          decide();
        },
        (err: unknown) => {
          settled[index] = true;
          if (index < failedAt) {
            failedAt = index;
            failure = err;
            for (const later of stops.slice(index + 1)) later.abort();
          }
          decide();
        },
      );
    });
  });
}

/// Run `work` over the images in document order, a batch at a time.
/// `work` writes nothing to the page: the caller does, with what comes
/// back, so a preparation that fails leaves no late write behind it.
async function mapImageSteps<T, U>(
  items: readonly T[],
  work: (item: T, stop: AbortSignal) => Promise<U>,
  parentStop?: AbortSignal,
): Promise<U[]> {
  const results: U[] = [];
  for (let at = 0; at < items.length; at += IMAGE_PREP_BATCH) {
    if (parentStop?.aborted) throw new SnapshotError("image preparation stopped");
    results.push(
      ...(await runImageBatch(items.slice(at, at + IMAGE_PREP_BATCH), work, parentStop)),
    );
  }
  return results;
}

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
/// by `timeoutMs` and given up when `stop` aborts. The caller handles a
/// failed fetch; an image is refused here and a CSS URL reaches the audit.
async function fetchAsDataUrl(
  url: string,
  timeoutMs: number,
  stop?: AbortSignal,
): Promise<string | null> {
  try {
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    const timer = setTimeout(abort, timeoutMs);
    stop?.addEventListener("abort", abort, { once: true });
    if (stop?.aborted) abort();
    try {
      const resp = await fetch(url, { signal: controller.signal });
      if (!resp.ok) return null;
      const blob = await resp.blob();
      return await withTimeout(blobToDataUrl(blob), timeoutMs, `encode ${url}`);
    } finally {
      clearTimeout(timer);
      stop?.removeEventListener("abort", abort);
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

/// Fetch an image and return it as a data: URL, or null for the caller
/// to refuse by name when the fetch fails. Reject a non-image body here:
/// once inlined, the element would no longer say where it came from.
async function fetchImageAsDataUrl(
  url: string,
  timeoutMs: number,
  stop: AbortSignal,
): Promise<string | null> {
  const inlined = await fetchAsDataUrl(url, timeoutMs, stop);
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
const preparedBitmaps = new WeakMap<HTMLImageElement, HTMLImageElement>();
const imageRecords = new WeakMap<Element, ImageRecord>();

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

/// Prepare shown images in DOM order, including their decodes, before any
/// source is replaced. This keeps fetch, type and decode failures in one
/// ordered pass and leaves no late write after a failed batch.
async function prepareVisibleImages(
  root: HTMLElement,
  timeoutMs: number,
  stop?: AbortSignal,
): Promise<void> {
  const apply = await mapImageSteps<Element, (() => void) | null>(
    Array.from(root.querySelectorAll("img, image")),
    async (element, imageStop) => {
      if (element instanceof HTMLImageElement) {
        if (element.hasAttribute(LIFTED_ATTR) || element.hasAttribute(DOCUMENT_PAINT_ATTR)) return null;
        const img = element;
        const src = img.getAttribute("src") ?? "";
        const selected = img.currentSrc || src;
        const name = sourceNames.get(img) ?? resourceName(selected);
        if (!htmlImageRecord(img, root).rendered) {
          return () => {
            sourceNames.set(img, name);
            // The stand-in also replaces resource offers that would outlive
            // the hidden image's src and reach the page audit.
            img.removeAttribute("srcset");
            if (img.parentElement?.tagName === "PICTURE") {
              for (const source of Array.from(img.parentElement.children)) {
                if (source.tagName === "SOURCE") source.remove();
              }
            }
            for (let at = img.style.length - 1; at >= 0; at--) {
              const property = img.style.item(at);
              if (externalUrlTokens(img.style.getPropertyValue(property)).length) {
                img.style.removeProperty(property);
              }
            }
            img.setAttribute("src", standInSrc(1, 1));
          };
        }
        if (!selected || selected.startsWith("#")) return null;
        const data = selected.startsWith("data:") ? selected :
          await fetchImageAsDataUrl(selected, timeoutMs, imageStop);
        if (!data) throw new SnapshotError(`image ${name} could not be fetched`);
        if (notAnImageData(data)) {
          throw new SnapshotError(`image ${name} is ${dataUrlType(data)}, not an image`);
        }
        const bitmap = await decodeImage(data, name, timeoutMs);
        return () => {
          img.removeAttribute("srcset");
          img.setAttribute("src", data);
          sourceNames.set(img, name);
          preparedBitmaps.set(img, bitmap);
        };
      }

      if (element.hasAttribute(DECODED_ATTR)) return null;
      const image = element;
      const visible = svgImageRecord(image, root).rendered;
      const refs: { attr: string; href: string; data: string }[] = [];
      for (const attr of IMAGE_HREF_ATTRS) {
        const href = image.getAttribute(attr);
        if (!href || href.startsWith("#")) continue;
        if (!visible) {
          if (!href.startsWith("data:")) {
            refs.push({ attr, href, data: standInSrc(1, 1) });
          }
          continue;
        }
        const data = href.startsWith("data:") ? href :
          await fetchImageAsDataUrl(href, timeoutMs, imageStop);
        const name = sourceNames.get(image) ?? resourceName(href);
        if (!data) throw new SnapshotError(`image ${name} could not be fetched`);
        if (notAnImageData(data)) {
          throw new SnapshotError(`image ${name} is ${dataUrlType(data)}, not an image`);
        }
        await decodeImage(data, name, timeoutMs);
        refs.push({ attr, href, data });
      }
      if (refs.length === 0 && visible) return null;
      return () => {
        for (const { attr, href, data } of refs) {
          image.setAttribute(attr, data);
          sourceNames.set(image, resourceName(href));
        }
        image.setAttribute(DECODED_ATTR, "");
      };
    },
    stop,
  );
  if (stop?.aborted) throw new SnapshotError("image preparation stopped");
  for (const write of apply) write?.();
}

/// Make the page self-contained: fetch and decode shown images, replace
/// hidden image sources, and inline CSS URLs and app font faces. Failed
/// image fetches refuse the page here; unresolved CSS URLs remain for
/// `auditSelfContained` to name.
export async function inlinePageResources(
  root: HTMLElement,
  timeoutMs: number = DEFAULT_STEP_TIMEOUT_MS,
  options: { stop?: AbortSignal } = {},
): Promise<void> {
  revealAutoContent(root);
  recordPageImages(root);
  await inlineFonts(root, timeoutMs);
  if (options.stop?.aborted) throw new SnapshotError("image preparation stopped");
  await prepareVisibleImages(root, timeoutMs, options.stop);
  for (const el of Array.from(root.querySelectorAll<HTMLElement>("[style]"))) {
    if (options.stop?.aborted) throw new SnapshotError("image preparation stopped");
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
export const LIFTED_ATTR = "data-chan-export-image";

/// A prepared image painted by the page document because the lift cannot
/// preserve its visible shape or place.
const DOCUMENT_PAINT_ATTR = "data-chan-export-document-image";

/// A cloned document page keeps the stand-in but does not paint an image
/// whose composed box is outside that page's window.
export const OFFPAGE_ATTR = "data-chan-export-offpage";

/// Marks an element inside a page whose box is the page's own, as a deck's
/// slide is: what it hides of an image, the page cut.
export const PAGE_BOX_ATTR = "data-chan-export-page-box";

/// Marks an SVG <image> whose bytes have decoded, so a page cloned from a
/// lifted document does not decode it again.
const DECODED_ATTR = "data-chan-export-decoded";

/// On the page root while its marker raster is drawn.
const MARKER_ATTR = "data-chan-export-markers";

/// How many marker colours one raster tells apart; a page with more
/// images to place draws more marker rasters.
const MARKER_SLOTS = 30;

type Box = { x: number; y: number; width: number; height: number };

type ImageGeometry = {
  box: Box;
  shown: Box;
  scale: { x: number; y: number };
  fit: string;
};

type HtmlImageRecord = {
  kind: "html";
  rendered: boolean;
  geometry: ImageGeometry | null;
  widthPx: number;
  heightPx: number;
  natural: { width: number; height: number };
  connectedAtMeasurement: boolean;
  hasSizeAttribute: boolean;
  hasAspectRatio: boolean;
  documentPaint: boolean;
};

type SvgImageRecord = { kind: "svg"; rendered: boolean };
type ImageRecord = HtmlImageRecord | SvgImageRecord;

/// How a page shows an image, in units of the width of the part of the
/// image's box that shows when no page cuts the image. That part is the
/// whole box unless an ancestor hides some of it.
export type ImageShape = {
  /// The height of that part.
  shownHeight: number;
  /// Where the whole bitmap lies, from that part's top left corner.
  bitmap: Box;
};

type LiftedImage = {
  name: string;
  source: string;
  widthAttribute: string | null;
  styleAttribute: string | null;
  loadingAttribute: string | null;
  /// The image, decoded in the app's own document.
  bitmap: HTMLImageElement;
  shape: ImageShape;
  /// Whether the page shows the image where it was composed. One with no
  /// box there after loading, or hidden by the browser, a closed details
  /// element, `display`, `visibility`, zero opacity or content visibility,
  /// has nothing to paint and is skipped.
  rendered: boolean;
  shownWidthPx: number;
  documentPaint: boolean;
  /// Raster rows of the image painted so far. A document image taller
  /// than what is left of its page continues on the next one.
  shownPx: number;
  /// The image's last row has been painted.
  done: boolean;
};

/// The images one export may paint itself. A document hands the same one to
/// each of its pages: its images are prepared once before cloning, a lifted
/// image cut by a page continues on the next, and one without an exact
/// place keeps its inlined source in the page document.
export class PageImages {
  /// In lifting order; `LIFTED_ATTR` holds the index.
  readonly lifted: LiftedImage[] = [];

  /// Fail by name for each image that has a place and was not painted whole.
  assertPainted(): void {
    const missing = this.lifted
      .filter((image) => image.rendered && !image.done && !image.documentPaint)
      .map((image) => image.name);
    if (missing.length > 0) {
      throw new SnapshotError(
        `image has no place on the page: ${missing.join("; ")}`,
      );
    }
  }
}

/// Decode an image in the app's own document, bounded by `timeoutMs`. An
/// engine offers no way to cancel a decode, so one whose batch has failed
/// runs to its end or to its bound, and nothing waits for it.
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

/// The shape of an image that fills a box of its own proportions, all of
/// which shows.
function plainShape(ratio: number): ImageShape {
  return { shownHeight: ratio, bitmap: { x: 0, y: 0, width: 1, height: ratio } };
}

/// Where `object-fit` puts a bitmap of a natural size in the box of its
/// image. The bitmap is centered, which is where the initial
/// `object-position` puts it; another position is not followed. A bitmap
/// with no natural size fills the box.
export function fitBitmap(
  fit: string,
  box: Box,
  natural: { width: number; height: number },
): Box {
  if (!(natural.width > 0 && natural.height > 0)) return box;
  const contain = Math.min(
    box.width / natural.width,
    box.height / natural.height,
  );
  let scale: number;
  if (fit === "contain") scale = contain;
  else if (fit === "cover") {
    scale = Math.max(box.width / natural.width, box.height / natural.height);
  } else if (fit === "none") scale = 1;
  else if (fit === "scale-down") scale = Math.min(1, contain);
  else return box;
  const width = natural.width * scale;
  const height = natural.height * scale;
  return {
    x: box.x + (box.width - width) / 2,
    y: box.y + (box.height - height) / 2,
    width,
    height,
  };
}

function cssPx(value: string): number {
  const px = parseFloat(value);
  return Number.isFinite(px) ? px : 0;
}

/// How many px of an element's rect one px of its layout takes. A
/// transform or a zoom around the element changes what its rect measures
/// and not what its style resolves to.
function rectScale(
  el: Element,
  rect: DOMRect,
  style: CSSStyleDeclaration = getComputedStyle(el),
): { x: number; y: number } {
  const insetsX = cssPx(style.paddingLeft) + cssPx(style.paddingRight) +
    cssPx(style.borderLeftWidth) + cssPx(style.borderRightWidth);
  const insetsY = cssPx(style.paddingTop) + cssPx(style.paddingBottom) +
    cssPx(style.borderTopWidth) + cssPx(style.borderBottomWidth);
  const styledWidth = parseFloat(style.width);
  const styledHeight = parseFloat(style.height);
  const width = Number.isFinite(styledWidth)
    ? styledWidth + (style.boxSizing === "border-box" ? 0 : insetsX) : 0;
  const height = Number.isFinite(styledHeight)
    ? styledHeight + (style.boxSizing === "border-box" ? 0 : insetsY) : 0;
  const { offsetWidth, offsetHeight } = el as HTMLElement;
  return {
    x: width > 0 ? rect.width / width : offsetWidth > 0 ? rect.width / offsetWidth : 1,
    y: height > 0 ? rect.height / height : offsetHeight > 0 ? rect.height / offsetHeight : 1,
  };
}

function hidesOverflow(overflow: string): boolean {
  return overflow !== "" && overflow !== "visible";
}

/// What an ancestor leaves visible of `box`: an element that does not
/// show what overflows it cuts its content at its padding box.
function clipToAncestor(box: Box, el: Element, style = getComputedStyle(el)): Box {
  const cutsX = hidesOverflow(style.overflowX);
  const cutsY = hidesOverflow(style.overflowY);
  // `overflow` does not apply to an inline box.
  if ((!cutsX && !cutsY) || style.display === "inline" || style.display === "contents") {
    return box;
  }
  const rect = el.getBoundingClientRect();
  const scale = rectScale(el, rect, style);
  let { x, y, width, height } = box;
  if (cutsX) {
    const left = rect.left + cssPx(style.borderLeftWidth) * scale.x;
    const right =
      rect.left + rect.width - cssPx(style.borderRightWidth) * scale.x;
    const from = Math.max(x, left);
    width = Math.min(x + width, right) - from;
    x = from;
  }
  if (cutsY) {
    const top = rect.top + cssPx(style.borderTopWidth) * scale.y;
    const bottom =
      rect.top + rect.height - cssPx(style.borderBottomWidth) * scale.y;
    const from = Math.max(y, top);
    height = Math.min(y + height, bottom) - from;
    y = from;
  }
  return { x, y, width, height };
}

function establishesContainingBlock(style: CSSStyleDeclaration, position: string): boolean {
  if (style.display === "contents") return false;
  const transformed = style.transform !== "" && style.transform !== "none";
  if (position === "fixed") return transformed;
  return (style.position !== "" && style.position !== "static") || transformed ||
    (style.filter !== "" && style.filter !== "none") ||
    (style.perspective !== "" && style.perspective !== "none") ||
    /(?:^|\s)(?:layout|paint|content|strict)(?:\s|$)/.test(style.contain);
}

function clipThroughContainingBlocks(
  box: Box,
  target: Element,
  root: HTMLElement,
  styles: Map<Element, CSSStyleDeclaration>,
): Box {
  let shown = box;
  let position = styles.get(target)!.position;
  for (let el = target.parentElement; el && el !== root; el = el.parentElement) {
    const style = styles.get(el)!;
    if ((position === "absolute" || position === "fixed") &&
        !establishesContainingBlock(style, position)) continue;
    if (!el.hasAttribute(PAGE_BOX_ATTR)) shown = clipToAncestor(shown, el, style);
    position = style.position;
  }
  return shown;
}

function elementVisibility(
  element: Element,
  root: HTMLElement,
  trustEngineBox: boolean,
): { rendered: boolean; styles: Map<Element, CSSStyleDeclaration> } {
  const styles = new Map<Element, CSSStyleDeclaration>();
  let rendered = !root.isConnected || !trustEngineBox || element.checkVisibility?.({
    opacityProperty: true,
    visibilityProperty: true,
  }) !== false;
  if (root.isConnected && trustEngineBox && element instanceof HTMLImageElement &&
      element.getClientRects().length === 0) {
    rendered = false;
  }
  for (let el: Element | null = element; el; el = el.parentElement) {
    const style = getComputedStyle(el);
    styles.set(el, style);
    if (el === element && (style.visibility === "hidden" || style.visibility === "collapse")) {
      rendered = false;
    }
    if (style.display === "none" || parseFloat(style.opacity) === 0 ||
        style.contentVisibility === "hidden") rendered = false;
    if (el instanceof HTMLDetailsElement && !el.open &&
        !el.querySelector(":scope > summary")?.contains(element)) rendered = false;
    if (el === root) break;
  }
  return { rendered, styles };
}

function revealAutoContent(root: HTMLElement): void {
  for (const image of Array.from(root.querySelectorAll("img, image"))) {
    for (let el = image.parentElement; el; el = el.parentElement) {
      if (getComputedStyle(el).contentVisibility === "auto") {
        el.style.setProperty("content-visibility", "visible", "important");
      }
      if (el === root) break;
    }
  }
}

function scaleOnlyTransform(value: string, allowTranslation = false): boolean {
  if (!value || value === "none") return true;
  const scale = /^scale(?:X|Y|Z|3d)?\(([^)]*)\)$/.exec(value)?.[1];
  if (scale) return scale.split(/[\s,]+/).every((part) => Number(part) > 0);
  const matrix = /^matrix\(([^)]+)\)$/.exec(value)?.[1]?.split(",").map(Number);
  return !!matrix && matrix.length === 6 && matrix.every(Number.isFinite) &&
    matrix[0]! > 0 && matrix[3]! > 0 &&
    Math.abs(matrix[1]!) < 0.0001 && Math.abs(matrix[2]!) < 0.0001 &&
    (allowTranslation || (Math.abs(matrix[4]!) < 0.0001 && Math.abs(matrix[5]!) < 0.0001));
}

function hasComplexImagePaint(styles: Map<Element, CSSStyleDeclaration>): boolean {
  for (const [el, style] of styles) {
    // Deck fitting centers a scaled slide with translateX; the marker records both offsets.
    const fittedSlide = el.classList.contains("md-slide-preview-content") &&
      !!el.closest(`[${PAGE_BOX_ATTR}]`);
    const scale = style.scale?.trim();
    if (!scaleOnlyTransform(style.transform, fittedSlide) ||
        (style.rotate && style.rotate !== "none") ||
        (scale && scale !== "none" &&
          !scale.split(/\s+/).every((part) => Number(part) > 0)) ||
        (style.offsetPath && style.offsetPath !== "none") ||
        (style.clipPath && style.clipPath !== "none") ||
        (style.maskImage && style.maskImage !== "none") ||
        (style.webkitMaskImage && style.webkitMaskImage !== "none")) return true;
  }
  return false;
}

/// Capture every layout answer before the preparation writes to the page.
function measureHtmlImage(img: HTMLImageElement, root: HTMLElement): HtmlImageRecord {
  const rect = img.getBoundingClientRect();
  const natural = { width: img.naturalWidth, height: img.naturalHeight };
  const loadedAtMeasurement = img.complete && natural.width > 0 && natural.height > 0;
  const visibility = elementVisibility(img, root, loadedAtMeasurement);
  const style = visibility.styles.get(img)!;
  const scale = rectScale(img, rect, style);
  const left = (cssPx(style.borderLeftWidth) + cssPx(style.paddingLeft)) * scale.x;
  const right = (cssPx(style.borderRightWidth) + cssPx(style.paddingRight)) * scale.x;
  const top = (cssPx(style.borderTopWidth) + cssPx(style.paddingTop)) * scale.y;
  const bottom = (cssPx(style.borderBottomWidth) + cssPx(style.paddingBottom)) * scale.y;
  const box = {
    x: rect.left + left,
    y: rect.top + top,
    width: rect.width - left - right,
    height: rect.height - top - bottom,
  };
  let rendered = visibility.rendered;
  const shown = clipThroughContainingBlocks(box, img, root, visibility.styles);
  let geometry: ImageGeometry | null = null;
  if (rect.width > 0 && rect.height > 0) {
    geometry = { box, shown, scale, fit: style.objectFit };
  }
  if (loadedAtMeasurement && ((!geometry && root.isConnected) ||
      (geometry && !(shown.width > 0 && shown.height > 0)))) rendered = false;
  return {
    kind: "html",
    rendered,
    geometry,
    widthPx: style.width.endsWith("px") ? parseFloat(style.width) : NaN,
    heightPx: style.height.endsWith("px") ? parseFloat(style.height) : NaN,
    natural,
    connectedAtMeasurement: root.isConnected,
    hasSizeAttribute: img.hasAttribute("width") || img.hasAttribute("height"),
    hasAspectRatio: !!img.style.getPropertyValue("aspect-ratio"),
    documentPaint: hasComplexImagePaint(visibility.styles),
  };
}

function recordPageImages(root: HTMLElement): void {
  for (const element of Array.from(root.querySelectorAll("img, image"))) {
    if (element instanceof HTMLImageElement) {
      if (!element.hasAttribute(LIFTED_ATTR) && !imageRecords.has(element)) {
        imageRecords.set(element, measureHtmlImage(element, root));
      }
    } else if (!element.hasAttribute(DECODED_ATTR) && !imageRecords.has(element)) {
      let outer: Element | null = null;
      for (let el = element.parentElement; el && el !== root; el = el.parentElement) {
        if (el.tagName.toLowerCase() === "svg") outer = el;
      }
      const target = outer ?? element;
      const visibility = elementVisibility(target, root, true);
      let rendered = visibility.rendered;
      const rect = target.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        const shown = clipThroughContainingBlocks(
          { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
          target, root, visibility.styles,
        );
        if (!(shown.width > 0 && shown.height > 0)) rendered = false;
      }
      imageRecords.set(element, { kind: "svg", rendered });
    }
  }
}

function htmlImageRecord(img: HTMLImageElement, root: HTMLElement): HtmlImageRecord {
  if (!imageRecords.has(img)) recordPageImages(root);
  const record = imageRecords.get(img);
  if (!record || record.kind !== "html") throw new SnapshotError("image was not measured");
  return record;
}

function svgImageRecord(image: Element, root: HTMLElement): SvgImageRecord {
  if (!imageRecords.has(image)) recordPageImages(root);
  const record = imageRecords.get(image);
  if (!record || record.kind !== "svg") throw new SnapshotError("SVG image was not measured");
  return record;
}

function shapeFromRecord(
  record: HtmlImageRecord,
  natural: { width: number; height: number },
): ImageShape | "hidden" | null {
  const geometry = record.geometry;
  if (!geometry) return null;
  const { box, shown, scale, fit } = geometry;
  if (!(shown.width > 0 && shown.height > 0)) return "hidden";
  const bitmap = fitBitmap(fit, box, {
    width: natural.width * scale.x,
    height: natural.height * scale.y,
  });
  return {
    shownHeight: shown.height / shown.width,
    bitmap: {
      x: (bitmap.x - shown.x) / shown.width,
      y: (bitmap.y - shown.y) / shown.width,
      width: bitmap.width / shown.width,
      height: bitmap.height / shown.width,
    },
  };
}

function sizeFromRecord(
  record: HtmlImageRecord,
  natural: { width: number; height: number },
): { widthPx: number; heightPx: number; ratio: string } | null {
  const { widthPx: width, heightPx: height } = record;
  if (natural.width > 0 && natural.height > 0) {
    const widthPx = width > natural.width ? width : natural.width;
    return {
      widthPx,
      heightPx: (widthPx * natural.height) / natural.width,
      ratio: `${natural.width} / ${natural.height}`,
    };
  }
  if (!(width > 0 && height > 0)) return null;
  return { widthPx: width, heightPx: height, ratio: `${width} / ${height}` };
}

function boxMoved(img: HTMLImageElement, record: HtmlImageRecord): boolean {
  const style = getComputedStyle(img);
  return (
    (Number.isFinite(record.widthPx) &&
      !(Math.abs(parseFloat(style.width) - record.widthPx) <= 0.5)) ||
    (Number.isFinite(record.heightPx) &&
      !(Math.abs(parseFloat(style.height) - record.heightPx) <= 0.5))
  );
}

function restoreMeasuredBox(img: HTMLImageElement, record: HtmlImageRecord): boolean {
  if (!record.geometry || !boxMoved(img, record)) return true;
  for (const [length, value] of [
    ["width", record.widthPx], ["height", record.heightPx],
  ] as const) {
    if (!Number.isFinite(value)) continue;
    for (const property of [length, `min-${length}`, `max-${length}`]) {
      img.style.setProperty(property, `${value}px`, "important");
    }
  }
  return !record.rendered || !boxMoved(img, record);
}

/// Replace each prepared <img> with a stand-in and keep its decoded bitmap
/// for drawing over the page. An image already lifted is left alone on a
/// cloned document page. The stand-in receives a natural-size width hint
/// and aspect ratio; after all writes, the measured width and height are
/// restored with six explicit lengths if either resolved length moved. An
/// image whose box still differs keeps its prepared source in the document.
export async function liftPageImages(
  root: HTMLElement,
  images: PageImages,
  stop?: AbortSignal,
): Promise<void> {
  revealAutoContent(root);
  recordPageImages(root);
  const decoded = await mapImageSteps(
    Array.from(root.querySelectorAll("img")),
    async (img) => {
      if (img.hasAttribute(LIFTED_ATTR) || img.hasAttribute(DOCUMENT_PAINT_ATTR)) return null;
      const src = img.getAttribute("src") ?? "";
      if (!src.startsWith("data:")) return null;
      const name = sourceNames.get(img) ?? resourceName(src);
      const record = htmlImageRecord(img, root);
      const bitmap = record.rendered ? preparedBitmaps.get(img) : new Image();
      if (!bitmap) throw new SnapshotError(`image ${name} was not prepared`);
      return { img, name, bitmap, record };
    },
    stop,
  );
  if (stop?.aborted) throw new SnapshotError("image preparation stopped");
  const prepared = decoded.flatMap((result) => {
    if (!result) return [];
    const { img, name, bitmap, record } = result;
    const natural = record.rendered
      ? { width: bitmap.naturalWidth, height: bitmap.naturalHeight }
      : record.natural;
    const measured = record.rendered ? shapeFromRecord(record, natural) : "hidden";
    const rendered = record.rendered;
    const size = sizeFromRecord(record, natural);
    if (rendered && ((record.connectedAtMeasurement &&
        (!record.geometry || measured === "hidden")) || !size)) {
      record.documentPaint = true;
    }
    return [{ img, name, bitmap, rendered, size, record,
      source: img.getAttribute("src") ?? "",
      widthAttribute: img.getAttribute("width"),
      styleAttribute: img.getAttribute("style"),
      loadingAttribute: img.getAttribute("loading"),
      shape: measured && measured !== "hidden" ? measured :
        plainShape(size ? size.heightPx / size.widthPx : 1) }];
  });
  for (const { img, name, bitmap, rendered, size, shape, record, source,
    widthAttribute, styleAttribute, loadingAttribute } of prepared) {
    if (rendered && record.documentPaint) {
      img.setAttribute(DOCUMENT_PAINT_ATTR, "");
      continue;
    }
    img.setAttribute(LIFTED_ATTR, String(images.lifted.length));
    images.lifted.push({
      name,
      source,
      widthAttribute,
      styleAttribute,
      loadingAttribute,
      bitmap,
      shape,
      rendered,
      shownWidthPx: record.geometry?.shown.width ?? 0,
      documentPaint: false,
      shownPx: 0,
      done: false,
    });
    img.setAttribute("src", standInSrc(size?.widthPx ?? 1, size?.heightPx ?? 1));
    img.removeAttribute("loading");
    if (!size) continue;
    if (!record.hasSizeAttribute) {
      img.setAttribute("width", String(size.widthPx));
    }
    if (!record.hasAspectRatio) {
      img.style.setProperty("aspect-ratio", size.ratio);
    }
  }
  for (const { img, record, rendered } of prepared) {
    if (rendered && record.documentPaint) continue;
    if (!restoreMeasuredBox(img, record)) {
      const image = images.lifted[Number(img.getAttribute(LIFTED_ATTR))]!;
      image.documentPaint = true;
      restoreDocumentImage(img, image);
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
/// which is what this page shows of the image. A box as tall as the
/// image's shape says shows all the page composed of it, and the shape is
/// laid over the box exactly: the bitmap fills it, or lies in it as
/// `object-fit` or a parent's cut put it. A shorter box is an image the
/// page cuts: the shape keeps its proportions at the box's width and
/// starts `shownPx` rows above the box, where the page before left off.
/// The caller clips the draw to the box. A marker narrower than the recorded
/// shape has no exact placement and returns null.
export function placeLiftedImage(
  box: MarkerBox,
  shape: ImageShape,
  shownPx: number,
  expectedWidthPx?: number,
): ImagePlacement | null {
  // A page-edge cut can shorten the marker's width without changing its
  // height. Scaling the whole bitmap into that marker would squeeze it.
  if (expectedWidthPx && box.width + 2 < expectedWidthPx) return null;
  const fullHeight = box.width * shape.shownHeight;
  // The box is read in whole pixels, so its width is off by up to one
  // and the height that follows from it by up to the shape's.
  const slack = 1.5 + 1.5 * shape.shownHeight;
  const whole = shownPx === 0 && box.height >= fullHeight - slack;
  // Raster px for one unit of the shape, across and down.
  const unitY = whole ? box.height / shape.shownHeight : box.width;
  const shown = whole ? box.height : shownPx + box.height;
  return {
    x: box.x + shape.bitmap.x * box.width,
    y: box.y - (whole ? 0 : shownPx) + shape.bitmap.y * unitY,
    width: shape.bitmap.width * box.width,
    height: shape.bitmap.height * unitY,
    shownPx: shown,
    done: whole || shown >= fullHeight - slack,
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

/// A raster has nothing to scroll, and an element styled to scroll paints
/// its scrollbar into the page when it overflows. Every page's document
/// carries this, so no stylesheet a page brings can paint one: the
/// standard property, and the pseudo-element for the engines that paint
/// their scrollbars through it.
const NO_SCROLLBAR_STYLE =
  '<style xmlns="http://www.w3.org/1999/xhtml">' +
  "*{scrollbar-width:none}*::-webkit-scrollbar{display:none}" +
  "</style>";

/// Serialize the page element into an <svg><foreignObject> document.
/// XMLSerializer emits well-formed XHTML with the namespace on the
/// root, which is what the foreignObject content model requires.
export function pageSvgDocument(root: HTMLElement, box: PageBoxPx): string {
  const xhtml = new XMLSerializer().serializeToString(root);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${box.widthPx}" height="${box.heightPx}">` +
    `<foreignObject width="100%" height="100%">${NO_SCROLLBAR_STYLE}${xhtml}</foreignObject></svg>`
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

function restoreDocumentImage(img: HTMLImageElement, image: LiftedImage): void {
  img.removeAttribute(LIFTED_ATTR);
  img.setAttribute(DOCUMENT_PAINT_ATTR, "");
  img.setAttribute("src", image.source);
  for (const [name, value] of [
    ["width", image.widthAttribute],
    ["style", image.styleAttribute],
    ["loading", image.loadingAttribute],
  ] as const) {
    if (value === null) img.removeAttribute(name);
    else img.setAttribute(name, value);
  }
}

function restoreDocumentImages(root: HTMLElement, images: PageImages, lastPage = false): void {
  if (lastPage) {
    const eligible = new Set(Array.from(
      root.querySelectorAll<HTMLImageElement>(`img[${LIFTED_ATTR}]:not([${OFFPAGE_ATTR}])`),
      (img) => Number(img.getAttribute(LIFTED_ATTR)),
    ));
    for (const [id, image] of images.lifted.entries()) {
      if (image.rendered && !image.done && !eligible.has(id)) image.documentPaint = true;
    }
  }
  for (const img of Array.from(root.querySelectorAll<HTMLImageElement>(`img[${LIFTED_ATTR}]`))) {
    const image = images.lifted[Number(img.getAttribute(LIFTED_ATTR))];
    if (image?.documentPaint) restoreDocumentImage(img, image);
  }
}

/// Draw each image whose marker has its recorded width and a complete
/// place across the page windows. A marker that cannot place it makes the
/// page rasterize that image from its own inlined source instead.
async function paintLiftedImages(
  canvas: HTMLCanvasElement,
  root: HTMLElement,
  box: PageBoxPx,
  images: PageImages,
  opts: { scale?: number; timeoutMs?: number },
  lastPage: boolean,
): Promise<HTMLCanvasElement> {
  for (;;) {
    const pending: number[] = [];
    for (const img of Array.from(root.querySelectorAll(`img[${LIFTED_ATTR}]:not([${OFFPAGE_ATTR}])`))) {
      const id = Number(img.getAttribute(LIFTED_ATTR));
      const image = images.lifted[id];
      if (image && image.rendered && !image.done && !image.documentPaint) pending.push(id);
    }
    if (pending.length === 0) return canvas;
    const placements: { id: number; box: MarkerBox; place: ImagePlacement }[] = [];
    const fallback = new Set<number>();
    for (let at = 0; at < pending.length; at += MARKER_SLOTS) {
      const ids = pending.slice(at, at + MARKER_SLOTS);
      const markers = await markerRaster(root, box, ids, opts);
      const pixels = markers
        .getContext("2d")
        ?.getImageData(0, 0, markers.width, markers.height);
      if (!pixels) throw new SnapshotError("no 2d canvas context");
      const boxes = readMarkerBoxes(pixels.data, pixels.width, pixels.height, ids.length);
      boxes.forEach((markerBox, slot) => {
        const id = ids[slot]!;
        if (!markerBox) {
          fallback.add(id);
          return;
        }
        const image = images.lifted[id]!;
        const expectedWidth = image.shownWidthPx * (opts.scale ?? RASTER_SCALE);
        const place = placeLiftedImage(markerBox, image.shape, image.shownPx, expectedWidth);
        if (!place || (lastPage && !place.done)) fallback.add(id);
        else placements.push({ id, box: markerBox, place });
      });
    }
    if (fallback.size > 0) {
      for (const id of fallback) images.lifted[id]!.documentPaint = true;
      restoreDocumentImages(root, images);
      canvas = await rasterizePage(root, box, opts);
      continue;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new SnapshotError("no 2d canvas context");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    for (const { id, box: markerBox, place } of placements) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(markerBox.x, markerBox.y, markerBox.width, markerBox.height);
      ctx.clip();
      ctx.drawImage(images.lifted[id]!.bitmap, place.x, place.y, place.width, place.height);
      ctx.restore();
      images.lifted[id]!.shownPx = place.shownPx;
      images.lifted[id]!.done = place.done;
    }
    return canvas;
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
  restoreDocumentImages(root, images, !opts.images || !!opts.lastPage);
  await inlinePageResources(root, opts.timeoutMs);
  await liftPageImages(root, images);
  auditSelfContained(root);
  let canvas = await rasterizePage(root, box, opts);
  canvas = await paintLiftedImages(canvas, root, box, images, opts,
    !opts.images || !!opts.lastPage);
  if (!opts.images || opts.lastPage) images.assertPainted();
  return {
    png: await canvasPngBytes(canvas, opts.timeoutMs),
    widthPx: canvas.width,
    heightPx: canvas.height,
  };
}
