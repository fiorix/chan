// PBKDF2 PIN-hash helper. The screensaver feature hashes the
// user's PIN client-side via
// `crypto.subtle.deriveBits` and posts the base64-encoded
// digest to `/api/screensaver/pin`. The server stores the bytes verbatim;
// verification re-hashes the candidate the same way + the
// server does a constant-time byte-equality compare.
//
// Threat model is local-only (someone over-the-shoulder while
// the user steps away). PBKDF2 +
// SHA-256 + a fixed per-workspace salt + a moderate iteration
// count is sufficient - argon2/scrypt would be overkill and
// would force a new dependency.
//
// Salt derivation: the chan-workspace `workspace.info.root` path is
// passed in by the caller so the same PIN typed against two
// workspaces renders distinct hashes (locks-down PIN reuse
// across workspaces without coordinating salts server-side). The
// path is hashed itself first (SHA-256) before being used as
// salt so a long path doesn't blow out the PBKDF2 input
// buffer.
//
// Iteration count: 100_000 is the OWASP "PBKDF2 for
// password-equivalent" minimum recommendation circa 2023.
// Browser perf on a modern laptop: ~50ms for 100k iterations
// - imperceptible to the user typing a PIN. Don't drop below
// 10k.

const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_HASH_BITS = 256; // SHA-256 output size.

/// Hash a PIN string into the wire-format base64 digest the
/// `/api/screensaver/pin` and `/verify` endpoints expect.
///
/// Returns the base64-encoded PBKDF2 output (32 bytes →
/// base64 length 44). Caller posts this directly as the
/// `hash` field.
///
/// `workspaceSalt` is any stable per-workspace string the caller has
/// on hand, typically `workspace.info?.root`.
/// Empty string falls back to a fixed default - usable for
/// the truly-no-workspace case but the SPA shouldn't reach this
/// helper without a workspace loaded anyway.
export async function hashPin(pin: string, workspaceSalt: string): Promise<string> {
  if (typeof crypto === "undefined" || !crypto.subtle) {
    throw new Error(
      "crypto.subtle unavailable - screensaver PIN hashing requires WebCrypto",
    );
  }
  const encoder = new TextEncoder();
  const pinBytes = encoder.encode(pin);
  const saltSource = workspaceSalt.length > 0 ? workspaceSalt : "chan:screensaver:default";
  // Hash the salt source once so an arbitrarily long input
  // doesn't blow out the PBKDF2 salt buffer. The output is a
  // fixed 32-byte SHA-256 digest.
  const saltDigest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(saltSource),
  );
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    pinBytes,
    { name: "PBKDF2" },
    false,
    ["deriveBits"],
  );
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: saltDigest,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    keyMaterial,
    PBKDF2_HASH_BITS,
  );
  return base64Encode(new Uint8Array(derivedBits));
}

/// Browser-native base64 encode of raw bytes. `btoa` only
/// accepts strings; we go through `String.fromCharCode` so any
/// byte value (including non-UTF8 byte sequences from the
/// PBKDF2 digest) round-trips correctly.
function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

/// Default screensaver inactivity timeout (seconds). Matches the
/// chan-workspace default so a fresh workspace without a persisted
/// value renders the same UX as one that has been configured.
export const SCREENSAVER_DEFAULT_TIMEOUT_SECS = 300;

/// Minimum + maximum timeout values the Settings UI should
/// accept. The chan-workspace layer doesn't clamp; the SPA
/// enforces a reasonable range so a typo of `1` doesn't lock
/// out the user mid-keystroke.
export const SCREENSAVER_MIN_TIMEOUT_SECS = 10;
export const SCREENSAVER_MAX_TIMEOUT_SECS = 60 * 60; // 1h

export type ScreensaverTheme = "plain" | "matrix";
export const SCREENSAVER_DEFAULT_THEME: ScreensaverTheme = "plain";
