// The one place the app mints a random id.
//
// `crypto.randomUUID` is restricted to secure contexts, and a devserver
// reached over plain http at a LAN address is not one, which is a supported
// way to run chan. A call site that reaches for it directly throws there, in
// whatever handler it sits in. `crypto.getRandomValues` carries no such
// restriction, so a v4 UUID is available anyway and every call site can have
// one by asking here.

/// A random v4 UUID.
///
/// Unique across windows, reloads and machines: every path draws 16 fresh
/// random bytes rather than seeding from the clock, so two windows of one
/// session opened in the same millisecond still mint different ids.
export function newUuid(): string {
  const webCrypto = globalThis.crypto as Crypto | undefined;
  if (typeof webCrypto?.randomUUID === "function") return webCrypto.randomUUID();
  return uuidFromBytes(randomBytes(16, webCrypto));
}

function randomBytes(count: number, webCrypto: Crypto | undefined): Uint8Array {
  const bytes = new Uint8Array(count);
  if (typeof webCrypto?.getRandomValues === "function") {
    webCrypto.getRandomValues(bytes);
    return bytes;
  }
  // No Web Crypto at all, which is neither a browser chan supports nor the
  // desktop shell's WebView. Weaker per byte, still 16 bytes drawn per id.
  for (let i = 0; i < count; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return bytes;
}

function uuidFromBytes(bytes: Uint8Array): string {
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 1
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
