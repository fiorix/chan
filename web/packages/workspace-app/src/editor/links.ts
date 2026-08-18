// Wiki-link serialization and relative-path helpers used by the
// editor. The wikiLink TipTap extension serializes atoms back to
// markdown via `wikiLinkToMarkdown`; Wysiwyg resolves clicks on
// relative-path links via `resolveRelativePath` (legacy, ./../-only)
// and `normalizeHref` (full mirror of chan-workspace's `normalize_href`).

/// Serialize a wikiLink atom's attrs back to markdown.
///
/// `fromPath` is the path of the file whose markdown is being
/// produced (workspace-rooted POSIX, no leading slash). When provided,
/// the URL portion is rewritten to a file-relative path with an
/// explicit `./` or `../` prefix so the discriminator at parse
/// time can tell relative URLs from legacy workspace-rooted ones.
/// When omitted (no source file), the URL stays workspace-rooted.
///
/// `wasAbs` overrides the relativization: if true, the URL is
/// emitted in workspace-rooted form with a leading slash, preserving
/// the shape `decorateWikiLinks` saw in the source markdown.
export function wikiLinkToMarkdown(
  target: string,
  label?: string,
  anchor?: string,
  fromPath?: string,
  wasAbs?: boolean,
): string {
  const stem = (label ?? target.split("/").pop() ?? target).replace(/\.md$/, "");
  // Build the URL portion. With `wasAbs`, emit workspace-rooted form
  // (`/path`) regardless of `fromPath`. Otherwise, with `fromPath`
  // set, the URL is rewritten to a file-relative path so notes
  // stay portable across project layouts. Without `fromPath`, fall
  // back to the legacy workspace-rooted form (no slash) so no-source-file
  // callers keep their existing semantics.
  const path = wasAbs
    ? `/${target}`
    : fromPath
      ? relativizePath(target, fromPath)
      : target;
  const enc = encodeRelPath(path);
  // Anchor is appended verbatim. Heading anchors are already
  // slugged by chan-workspace (kebab-case ASCII); block anchors are
  // `^id` and round-trip cleanly through encodeURIComponent's
  // identity for `^`.
  const frag = anchor ? `#${anchor}` : "";
  return `[${stem}](${enc}${frag})`;
}

/// Percent-encode each segment of a workspace path for use in a
/// markdown link/image destination. A filename with a space or other
/// URL-special char would otherwise terminate the destination at the
/// space (pulldown-cmark, the on-disk graph scanner, does not parse a
/// literal space inside `](dest)`), so an unencoded `./My File.md`
/// produces NO graph edge and the resolver gets a truncated path.
/// `/` is preserved so segments stay separated; the reader side
/// (`decodePercent`) reverses this before resolving.
export function encodeRelPath(path: string): string {
  return path
    .split("/")
    .map((s) => encodeURIComponent(s).replace(/%2F/g, "/"))
    .join("/");
}

/// Reverse `encodeRelPath` (and any author-typed percent-encoding) so
/// the resolver sees the real path before mapping it to a workspace
/// file. A bare string with no `%` is returned unchanged; a malformed
/// escape falls back to the input rather than throwing. The editor's
/// link + image resolvers must decode because the on-disk form is
/// percent-encoded but `normalizeHref` / `/api/fs` expect the
/// decoded path.
export function decodePercent(s: string): string {
  if (!s.includes("%")) return s;
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/// Compute a file-relative path from `fromPath`'s directory to
/// `target`, both workspace-rooted POSIX paths. Always emits a
/// `./` or `../` prefix so the parser can distinguish a relative
/// URL from a legacy workspace-rooted one.
///
/// Examples (fromPath -> target -> result):
///   `Recipes/Pasta.md`    -> `Recipes/Brazilian Rice.md` -> `./Brazilian Rice.md`
///   `Recipes/Pasta.md`    -> `Notes/Foo.md`              -> `../Notes/Foo.md`
///   `README.md`           -> `Recipes/Pasta.md`          -> `./Recipes/Pasta.md`
export function relativizePath(target: string, fromPath: string): string {
  const fromDir = fromPath.split("/").slice(0, -1);
  const tgtParts = target.split("/");
  let i = 0;
  while (
    i < fromDir.length &&
    i < tgtParts.length - 1 &&
    fromDir[i] === tgtParts[i]
  ) {
    i += 1;
  }
  const ups = fromDir.length - i;
  const down = tgtParts.slice(i);
  if (ups === 0) {
    return ["."].concat(down).join("/");
  }
  return Array(ups).fill("..").concat(down).join("/");
}

/// Resolve a relative href against `fromPath`'s directory, returning
/// the canonical workspace-rooted target. Hrefs that don't start with
/// `./` or `../` are treated as already-workspace-rooted (legacy /
/// power-user form) and returned unchanged.
export function resolveRelativePath(href: string, fromPath: string): string {
  if (!href.startsWith("./") && !href.startsWith("../")) {
    return href;
  }
  const fromDir = fromPath.split("/").slice(0, -1);
  const parts = href.split("/");
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") {
      if (fromDir.length > 0) fromDir.pop();
    } else {
      fromDir.push(p);
    }
  }
  return fromDir.join("/");
}

/// Resolve a markdown link href to a clean workspace-relative POSIX path.
///
/// Hand-port of `chan_workspace::markdown::normalize_href`; both must
/// produce the same string for the same input so the on-disk graph
/// edges and the in-editor click navigation agree on the resolved
/// target. Update both files together.
///
/// `href` is the literal target as written in the markdown (or the
/// inner text of a wiki link). `sourceDir` is the directory of the
/// file the href appears in: workspace-relative POSIX, no leading slash;
/// pass "" for files at the workspace root.
///
/// Returns `null` for hrefs that don't address a workspace file:
///   - external schemes (`https:`, `mailto:`, `tel:`, ...)
///   - intra-document fragments (`#section`)
///   - empty hrefs and `/` alone
///   - lexical escapes past the workspace root (`../` from the root)
/// Strips trailing `?query` and `#anchor`; callers that need the
/// anchor for navigation must capture it separately before calling.
///
/// Examples (href, sourceDir -> result):
///   `/x.md`,            `notes`     -> `x.md`
///   `../images/x.png`,  `notes`     -> `images/x.png`
///   `./x.md`,           `notes`     -> `notes/x.md`
///   `x.md`,             `notes`     -> `notes/x.md`
///   `https://x.com/`,   `notes`     -> null
///   `#section`,         `notes`     -> null
///   `../../../x.md`,    `a/b`       -> null
export function normalizeHref(href: string, sourceDir: string): string | null {
  if (href === "" || href.includes("\0")) return null;
  if (href.startsWith("#")) return null;
  // URL scheme: a `:` ahead of any `/`, `#`, `?` marks the href as
  // external. Mirrors the Rust scanner byte-for-byte.
  for (let i = 0; i < href.length; i += 1) {
    const c = href.charCodeAt(i);
    if (c === 0x2f /* / */ || c === 0x23 /* # */ || c === 0x3f /* ? */) {
      break;
    }
    if (c === 0x3a /* : */ && i > 0) return null;
  }
  // Strip trailing query and fragment: keep the earliest cut.
  const q = href.indexOf("?");
  const h = href.indexOf("#");
  const cut = Math.min(
    q === -1 ? href.length : q,
    h === -1 ? href.length : h,
  );
  const pathOnly = href.slice(0, cut);
  if (pathOnly === "") return null;
  let combined: string;
  if (pathOnly.startsWith("/")) {
    combined = pathOnly.slice(1);
  } else if (sourceDir === "") {
    combined = pathOnly;
  } else {
    combined = `${sourceDir.replace(/\/+$/, "")}/${pathOnly}`;
  }
  // Lexical `.` / `..` collapse. A `..` past the workspace root rejects
  // the whole href; matches chan-workspace's no-symlink-chasing rule.
  const stack: string[] = [];
  for (const part of combined.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (stack.length === 0) return null;
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  if (stack.length === 0) return null;
  return stack.join("/");
}
