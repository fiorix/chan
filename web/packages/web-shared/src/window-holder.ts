// The holder tag of a window's page.
//
// A window's record reads `connected` while any event socket is live for its
// id, and cannot say whose socket that is. So an opener tags the pages it
// opens: it adds `h=<tag>` to the URL it navigates a window to, the page sends
// that `h` on its event socket, and the record lists the tags that have a live
// socket as `holders`. The opener then finds its own page among a window's
// holders by the tag it reads back from the window's URL.
//
// A tag is a claim and not an identity: any page that can open a window's
// socket can present any tag.

/** A tag as the server counts it. One that is not names no holder there. */
const HOLDER_TAG = /^[A-Za-z0-9_-]{1,64}$/;

/** The tag a URL names with `h`, read as the server reads it: a URL with no
 * `h`, more than one, or one that is not a tag names no holder. */
export function holderTagOf(url: string): string | null {
  let tags: string[];
  try {
    tags = new URL(url).searchParams.getAll("h");
  } catch {
    return null;
  }
  return tags.length === 1 && HOLDER_TAG.test(tags[0]) ? tags[0] : null;
}

/** What an opener can read of the tag a window's page presents. A location
 * that cannot be read is neither a tag nor the lack of one. */
export type HolderReading = { readable: true; tag: string | null } | { readable: false };

/** Read the tag of the page a window handle shows. A page of another origin
 * refuses the read of its location. */
export function readWindowHolder(h: Window): HolderReading {
  try {
    return { readable: true, tag: holderTagOf(h.location.href) };
  } catch {
    return { readable: false };
  }
}

/** What the rule reads of a window's record. A sender that does not count
 * holders leaves `holders` out. */
export interface HeldWindowRecord {
  connected: boolean;
  holders?: readonly string[];
}

/** Whether the page behind a reading is on the window a record describes.
 *
 * A record that lists holders answers for a tagged page by its tag, whatever
 * other sockets the window has, and a page that cannot be read is not on it.
 * A record without the list, and a page that names no tag, leave only
 * `connected`: some socket is live for the window, whoever holds it. */
export function pageHoldsWindow(record: HeldWindowRecord, reading: HolderReading): boolean {
  if (!record.holders) return record.connected;
  if (!reading.readable) return false;
  if (reading.tag === null) return record.connected;
  return record.holders.includes(reading.tag);
}

function mintHolderTag(): string {
  const bytes = new Uint8Array(16);
  const webCrypto = globalThis.crypto as Crypto | undefined;
  if (typeof webCrypto?.getRandomValues === "function") {
    webCrypto.getRandomValues(bytes);
  } else {
    // No Web Crypto at all, which is neither a browser chan supports nor the
    // desktop shell's WebView. Weaker per byte, still 16 bytes drawn.
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// Minted with the module, so once for each load of the page that imports it.
const openerTag = mintHolderTag();

/** The tag this page load gives every window it navigates to its page. A
 * reload mints another, and the pages the earlier load opened keep theirs:
 * the rule reads a window's tag from the window, not from its opener. */
export function openerHolderTag(): string {
  return openerTag;
}
