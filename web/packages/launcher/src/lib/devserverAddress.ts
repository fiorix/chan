// The devserver form's Address field, parsed into the host/port/token the
// bridge stores. One field accepts EITHER a bare `host:port` (the local
// ssh-forward case) OR a full `http(s)://host:port?t=…` URL (the
// gateway/devserver-proxy case carrying a fixed token; port optional),
// mirroring what `chan devserver register <url>` accepts so the form and the
// CLI stay consistent. No wire change: the token rides write-only, and on an
// edit a full URL with an empty `?t=` explicitly clears the stored one.

export interface ParsedAddress {
  url: string;
  host: string;
  port: number | null;
  token?: string;
}

/** Parse the polymorphic Address:
 *   - `http(s)://host:port?t=…` → host + port (defaulted by scheme when
 *     absent) + the `t` query param (`?t=` clears on edit);
 *   - bare `host:port`          → host + port, no token.
 * Returns null only for blank input; an invalid port surfaces as
 * `port: null` for the caller to reject with a single message. */
export function parseAddress(raw: string): ParsedAddress | null {
  const s = raw.trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      const host = u.hostname;
      const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
      const token = u.searchParams.get("t");
      u.searchParams.delete("t");
      u.hash = "";
      return {
        url: u.toString(),
        host,
        port: Number.isInteger(port) ? port : null,
        token: token ?? undefined,
      };
    } catch {
      return { url: "", host: "", port: null };
    }
  }
  const idx = s.lastIndexOf(":");
  if (idx <= 0 || idx === s.length - 1) {
    return { url: "", host: s, port: null };
  }
  const host = s.slice(0, idx).trim();
  const port = Number(s.slice(idx + 1).trim());
  // Reject a malformed host -- whitespace, or a leftover colon from a typo'd
  // double colon / scheme fragment. A bracketed [::1] IPv6 literal ends in "]",
  // not ":", so it survives.
  if (!host || /\s/.test(host) || host.endsWith(":")) {
    return { url: "", host: "", port: null };
  }
  return {
    url: Number.isInteger(port) ? `http://${host}:${port}` : "",
    host,
    port: Number.isInteger(port) ? port : null,
  };
}

export function validPort(p: number | null): p is number {
  return p !== null && Number.isInteger(p) && p >= 1 && p <= 65535;
}
