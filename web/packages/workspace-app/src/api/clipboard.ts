/// Clipboard bridge for `cs copy` / `cs paste`.
///
/// The `cs` client base64-encodes stdin (copy) or base64-decodes the reply
/// (paste); the raw bytes cross the control socket and `/ws` as base64 inside
/// JSON. This module turns those bytes into the right clipboard representation
/// on write, and reads the clipboard back on paste, branching browser
/// `navigator.clipboard` vs the desktop's native arboard IPC exactly like
/// `readClipboardText` / `writeClipboardText`.

import {
  isTauriDesktop,
  readClipboardHtml,
  readClipboardImage,
  readClipboardText,
  writeClipboardHtml,
  writeClipboardImage,
  writeClipboardText,
} from "./desktop";

/// Which representation `cs paste` wants. `auto` is image-first then plain
/// text; the others force one. Mirrors the Rust `PastePrefer`.
export type PastePrefer = "auto" | "text" | "html" | "image";

/// One clipboard representation: a MIME plus the raw bytes.
export type ClipboardPayload = { mime: string; bytes: Uint8Array };

const PLAIN_MIME = "text/plain;charset=utf-8";

/// Largest raw clipboard payload we carry, mirroring the Rust
/// `MAX_CLIPBOARD_BYTES` (chan-shell `wire.rs`). A paste larger than this is
/// refused before we build a giant base64 string that the reply route would
/// reject anyway.
const MAX_CLIPBOARD_BYTES = 32 * 1024 * 1024;

/// Largest decoded image we will rasterize to a canvas on copy. A tiny image
/// can declare enormous dimensions (a decompression bomb); reject those before
/// allocating a `width*height*4` canvas. 64 MPx (~256 MB RGBA) clears any real
/// screenshot while bounding the canvas/encode step.
const MAX_IMAGE_PIXELS = 64 * 1024 * 1024;

/// Standard-alphabet base64 of `bytes`, chunked so a multi-megabyte image
/// does not overflow the argument count of a `String.fromCharCode` spread.
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/// Inverse of `bytesToBase64`.
export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/// A user-facing hint for a clipboard failure. A permission / gesture denial
/// is the common browser case (an async `cs paste` may not carry the terminal
/// keypress's transient activation), so point the user at the fix.
export function hintClipboardError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/denied|not allowed|notallowed|permission|gesture|user activation/i.test(msg)) {
    return "clipboard access denied; focus the window or grant clipboard permission";
  }
  return msg;
}

/// Copy `bytes` into a freshly allocated `ArrayBuffer`. A `Uint8Array` may be
/// backed by a `SharedArrayBuffer`, which the DOM `BlobPart` type rejects, so
/// Blob construction goes through this exact-size `ArrayBuffer` copy.
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

/// Re-encode `bytes` to PNG unless they already are one. PNG is the only image
/// type the async clipboard reliably accepts, so a JPEG/GIF/WebP goes through
/// a canvas pass (the same trick the image widget's copy button uses).
async function toPngBlob(bytes: Uint8Array, mime: string): Promise<Blob> {
  const srcBlob = new Blob([toArrayBuffer(bytes)], { type: mime });
  if (mime === "image/png") return srcBlob;
  const bitmap = await createImageBitmap(srcBlob);
  // Reject a decompression bomb before allocating the canvas. `createImageBitmap`
  // may already have allocated the decoded bitmap (a residual we can't fully
  // avoid from JS); `MAX_CLIPBOARD_BYTES` bounds the source file, and this bounds the
  // far larger canvas + re-encode step.
  if (bitmap.width * bitmap.height > MAX_IMAGE_PIXELS) {
    bitmap.close?.();
    throw new Error("image too large to copy to the clipboard");
  }
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d canvas context");
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close?.();
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png");
  });
}

/// Derive a plain-text fallback from HTML (its rendered text) so a plain-only
/// paste target still gets readable text alongside the rich version.
function htmlToPlainText(html: string): string {
  try {
    return new DOMParser().parseFromString(html, "text/html").body.textContent ?? "";
  } catch {
    return html;
  }
}

/// Write `bytes` onto the clipboard as `mime` (`cs copy`). Images normalize to
/// PNG; HTML carries a plain-text fallback; anything else writes as text. The
/// desktop's native arboard IPCs go first; when one fails (an ACL-denied
/// gateway-served window) the write degrades to the gesture-bound web API
/// instead of surfacing an opaque ACL string, mirroring `writeClipboardText`.
export async function writeClipboardPayload(mime: string, bytes: Uint8Array): Promise<void> {
  if (mime.startsWith("image/")) {
    const pngBlob = await toPngBlob(bytes, mime);
    if (isTauriDesktop()) {
      try {
        await writeClipboardImage(new Uint8Array(await pngBlob.arrayBuffer()));
        return;
      } catch (err) {
        console.warn(
          "writeClipboardPayload: native image write failed, falling back to web",
          err,
        );
      }
    }
    await navigator.clipboard.write([new ClipboardItem({ "image/png": pngBlob })]);
    return;
  }
  if (mime.startsWith("text/html")) {
    const html = new TextDecoder().decode(bytes);
    const plain = htmlToPlainText(html);
    if (isTauriDesktop()) {
      try {
        await writeClipboardHtml(html, plain);
        return;
      } catch (err) {
        console.warn(
          "writeClipboardPayload: native html write failed, falling back to web",
          err,
        );
      }
    }
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/html": new Blob([html], { type: "text/html" }),
        "text/plain": new Blob([plain], { type: "text/plain" }),
      }),
    ]);
    return;
  }
  // Plain text: writeClipboardText already branches desktop/web with its own
  // IPC-failure fallback.
  await writeClipboardText(new TextDecoder().decode(bytes));
}

/// Enforce `MAX_CLIPBOARD_BYTES` on a read payload: refuse it here rather
/// than build a giant base64 string that the reply route's body limit
/// would 413 anyway.
function capPayload(payload: ClipboardPayload): ClipboardPayload {
  if (payload.bytes.length > MAX_CLIPBOARD_BYTES) {
    throw new Error(
      `clipboard content too large (max ${MAX_CLIPBOARD_BYTES / (1024 * 1024)} MB)`,
    );
  }
  return payload;
}

/// Pick one representation off ALREADY-READ web clipboard items, so every
/// candidate derives from the same single `navigator.clipboard.read()`
/// access (a second access would need its own permission grant).
async function payloadFromWebItems(
  items: ClipboardItems,
  kind: Exclude<PastePrefer, "auto">,
): Promise<ClipboardPayload | null> {
  for (const item of items) {
    if (kind === "image") {
      const type = item.types.find((t) => t.startsWith("image/"));
      if (!type) continue;
      const blob = await item.getType(type);
      // Label with the ACTUAL clipboard type: browsers sanitize images to
      // image/png in practice, but if one ever surfaces a non-PNG type the CLI
      // must not stamp png bytes as image/png (wrong container under a .png).
      return { mime: type, bytes: new Uint8Array(await blob.arrayBuffer()) };
    }
    const mime = kind === "html" ? "text/html" : "text/plain";
    if (!item.types.includes(mime)) continue;
    const text = await (await item.getType(mime)).text();
    if (!text) continue;
    return {
      mime: kind === "html" ? "text/html" : PLAIN_MIME,
      bytes: new TextEncoder().encode(text),
    };
  }
  return null;
}

/// Web read for `cs paste`: ONE clipboard access, every candidate
/// representation derived from it. `prefer=text` uses `readText()` (still a
/// single access); everything else is one `navigator.clipboard.read()`
/// walked in preference order. Exported so the paste card's click handler
/// can run this exact read inside its user activation. Throws the raw
/// browser error on denial (callers hint it) and "clipboard is empty" when
/// nothing matched.
export async function readWebClipboardPayload(prefer: PastePrefer): Promise<ClipboardPayload> {
  if (prefer === "text") {
    const text = (await navigator.clipboard?.readText()) ?? "";
    if (!text) throw new Error("clipboard is empty");
    return capPayload({ mime: PLAIN_MIME, bytes: new TextEncoder().encode(text) });
  }
  const items = await navigator.clipboard.read();
  const order: Exclude<PastePrefer, "auto">[] =
    prefer === "auto" ? ["image", "text"] : [prefer];
  for (const kind of order) {
    const payload = await payloadFromWebItems(items, kind);
    if (payload) return capPayload(payload);
  }
  throw new Error("clipboard is empty");
}

/// Native desktop read (the arboard IPCs, no permission UI). Returns `null`
/// when no candidate representation is present; THROWS when an IPC fails
/// (an ACL-denied gateway-served window) so the caller can degrade to the
/// web path. The text reader tries its own web fallback first, then throws
/// if that read is refused too.
async function readNativeClipboardPayload(
  prefer: PastePrefer,
): Promise<ClipboardPayload | null> {
  const order: Exclude<PastePrefer, "auto">[] =
    prefer === "auto" ? ["image", "text"] : [prefer];
  for (const kind of order) {
    if (kind === "image") {
      const bytes = await readClipboardImage();
      if (bytes) return { mime: "image/png", bytes };
    } else if (kind === "html") {
      const html = await readClipboardHtml();
      if (html) return { mime: "text/html", bytes: new TextEncoder().encode(html) };
    } else {
      const text = await readClipboardText({ throwOnError: true });
      if (text) return { mime: PLAIN_MIME, bytes: new TextEncoder().encode(text) };
    }
  }
  return null;
}

/// Read the clipboard for `cs paste`, honoring `prefer`. Desktop windows go
/// native first (instant, no permission UI); a failed IPC (ACL-denied
/// gateway-served window) degrades to the web path -- the same single-access
/// read a plain browser uses, which may pend on a permission prompt and
/// raise the paste card. Throws a hinted error when a read is denied, and a
/// plain "clipboard is empty" when nothing matched.
export async function readClipboardPayload(prefer: PastePrefer): Promise<ClipboardPayload> {
  if (isTauriDesktop()) {
    let native: ClipboardPayload | null | undefined;
    try {
      native = await readNativeClipboardPayload(prefer);
    } catch (err) {
      console.warn(
        "readClipboardPayload: native clipboard read failed, falling back to web",
        err,
      );
    }
    if (native !== undefined) {
      if (native === null) throw new Error("clipboard is empty");
      return capPayload(native);
    }
  }
  try {
    return await readWebClipboardPayload(prefer);
  } catch (err) {
    throw new Error(hintClipboardError(err));
  }
}
