// Link extraction. Two link kinds:
//   - Standard markdown: `[label](target)`
//   - Wiki-style:        `[[target]]` and `[[target|label]]`
//
// Resolving the target to an actual file is the caller's concern.
// Relative paths are resolved against the source file's directory;
// absolute URLs are filtered with `is_internal()`.

use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};
use serde::{Deserialize, Serialize};

/// Byte ranges in the source where wiki-link syntax should be
/// ignored: code blocks (fenced + indented), inline code, raw HTML.
/// Wiki links inside these would render as literal text in any
/// markdown viewer, so storing them as graph edges is a phantom.
fn skip_ranges(markdown: &str) -> Vec<std::ops::Range<usize>> {
    let parser = Parser::new_ext(markdown, Options::all()).into_offset_iter();
    let mut out = Vec::new();
    let mut code_depth = 0usize;
    let mut code_start: Option<usize> = None;
    for (event, range) in parser {
        match event {
            Event::Start(Tag::CodeBlock(_)) => {
                if code_depth == 0 {
                    code_start = Some(range.start);
                }
                code_depth += 1;
            }
            Event::End(TagEnd::CodeBlock) => {
                code_depth = code_depth.saturating_sub(1);
                if code_depth == 0 {
                    if let Some(s) = code_start.take() {
                        out.push(s..range.end);
                    }
                }
            }
            Event::Code(_) | Event::Html(_) | Event::InlineHtml(_) => {
                out.push(range);
            }
            _ => {}
        }
    }
    out
}

fn in_skip(ranges: &[std::ops::Range<usize>], pos: usize) -> bool {
    ranges.iter().any(|r| r.start <= pos && pos < r.end)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Link {
    /// Target as written. Not resolved against any base path.
    pub target: String,
    /// Visible label, if any.
    pub label: Option<String>,
    /// True for `[[...]]`, false for standard markdown.
    pub wiki: bool,
}

impl Link {
    /// True for links that point inside the workspace (relative paths,
    /// fragments, query strings). Filters `http://`, `mailto:`, etc.
    pub fn is_internal(&self) -> bool {
        let bytes = self.target.as_bytes();
        for (i, b) in bytes.iter().enumerate() {
            match b {
                b'/' | b'#' | b'?' => return true,
                b':' if i > 0 => return false,
                _ => continue,
            }
        }
        true
    }
}

/// Extract all links in document order. Wiki links first, then
/// standard markdown links; duplicates are not deduplicated.
pub fn extract_links(markdown: &str) -> Vec<Link> {
    let mut out = wiki_links(markdown);
    out.extend(standard_links(markdown));
    out
}

/// Resolve a link href to a clean workspace-relative POSIX path.
///
/// `href` is the literal target as written in the markdown (or the
/// inner text of a wiki link). `source_dir` is the directory of the
/// file the href appears in, expressed as a workspace-relative POSIX
/// path with no leading slash (use `""` for files at the workspace
/// root).
///
/// Returns `None` for hrefs that don't address a graph-targetable
/// file: external schemes, intra-document fragments, empty hrefs,
/// and relative paths that escape the workspace root.
///
/// The graph builder and the editor's click handler both call this
/// (the editor side via a hand-port in TS) so the on-disk edges and
/// the in-editor navigation agree on the same target string.
pub fn normalize_href(href: &str, source_dir: &str) -> Option<String> {
    if href.is_empty() || href.as_bytes().contains(&0) {
        return None;
    }
    // Fragment-only refs (`#anchor`) stay intra-document and don't
    // produce a graph edge.
    if href.starts_with('#') {
        return None;
    }
    // URL scheme detection: a `:` that appears before any `/`, `#`,
    // or `?` marks the href as external (`https:`, `mailto:`, etc.).
    // Mirrors `Link::is_internal` so the two stay in sync.
    for (i, b) in href.bytes().enumerate() {
        match b {
            b':' if i > 0 => return None,
            b'/' | b'#' | b'?' => break,
            _ => continue,
        }
    }
    // Strip the trailing `?query` and `#anchor` portions; the graph
    // already records anchor on its own column, so the path-only
    // view is what's resolved against the workspace.
    let path_only = {
        let q = href.find('?').unwrap_or(href.len());
        let h = href.find('#').unwrap_or(href.len());
        &href[..q.min(h)]
    };
    if path_only.is_empty() {
        return None;
    }
    let combined = if let Some(rest) = path_only.strip_prefix('/') {
        rest.to_string()
    } else if source_dir.is_empty() {
        path_only.to_string()
    } else {
        format!("{}/{}", source_dir.trim_end_matches('/'), path_only)
    };
    // Lexical `.` / `..` collapse. A `..` that pops past the workspace
    // root is rejected; lexical-only matches chan-workspace's no-symlink
    // sandbox philosophy.
    let mut stack: Vec<&str> = Vec::new();
    for part in combined.split('/') {
        match part {
            "" | "." => continue,
            ".." => {
                stack.pop()?;
            }
            _ => stack.push(part),
        }
    }
    if stack.is_empty() {
        return None;
    }
    Some(stack.join("/"))
}

/// Kind of link visited by `rewrite_link_targets`. The caller may
/// want to distinguish wiki targets (which have no `./` flavor and
/// are always workspace-rooted by convention) from standard markdown
/// hrefs (which can carry `./`, `../`, or a leading `/`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkRefKind {
    /// `[[target]]` or `[[target|label]]`: the `target` portion.
    Wiki,
    /// `[label](href)` or `![alt](src)`: the `href` portion. Title
    /// component (`[label](href "title")`) is excluded from the
    /// callback view and preserved verbatim on rewrite.
    Markdown,
}

/// One link visit fed to the `rewrite_link_targets` callback. The
/// callback returns `Some(replacement)` to rewrite the target slice,
/// or `None` to leave the link untouched.
pub struct LinkRef<'a> {
    pub kind: LinkRefKind,
    pub href: &'a str,
}

/// Replace each link target in `markdown` for which `f` returns
/// `Some(new)`. Visits wiki link targets and standard markdown link
/// / image hrefs in document order. Returns `Some(new_markdown)` if
/// any replacement was made, `None` if every callback returned
/// `None` (or there were no links). The returned string preserves
/// every byte of the input outside the rewritten slices, including
/// labels, titles, and surrounding whitespace, so `cargo fmt`-like
/// reformatting doesn't sneak into the diff.
///
/// Skips:
///   - Wiki and standard syntax inside fenced / indented code
///     blocks, inline code, and raw HTML (matches `extract_links`).
///   - Reference-style links (`[label][ref]` + `[ref]: url`) and
///     autolinks (`<https://...>`): not in scope for v1 since the
///     editor doesn't emit them.
pub fn rewrite_link_targets<F>(markdown: &str, mut f: F) -> Option<String>
where
    F: FnMut(LinkRef<'_>) -> Option<String>,
{
    let skips = skip_ranges(markdown);
    let mut edits: Vec<(usize, usize, String)> = Vec::new();

    // Wiki links: hand-rolled byte scan. The target lives between
    // `[[` and either `|` (if a label is present) or `]]`. We replace
    // exactly that target slice, leaving the surrounding `[[ ]]`,
    // optional `| label`, and any internal whitespace untouched.
    let bytes = markdown.as_bytes();
    let mut i = 0;
    while i + 1 < bytes.len() {
        if bytes[i] == b'[' && bytes[i + 1] == b'[' {
            if in_skip(&skips, i) {
                i += 1;
                continue;
            }
            let start = i + 2;
            let mut j = start;
            while j + 1 < bytes.len() {
                if bytes[j] == b'\n' {
                    j = bytes.len();
                    break;
                }
                if bytes[j] == b']' && bytes[j + 1] == b']' {
                    break;
                }
                j += 1;
            }
            if j + 1 < bytes.len() && bytes[j] == b']' && bytes[j + 1] == b']' {
                let inner = &markdown[start..j];
                let target_end_rel = inner.find('|').unwrap_or(inner.len());
                let target_slice = &inner[..target_end_rel];
                let target_trimmed = target_slice.trim();
                if !target_trimmed.is_empty() {
                    if let Some(replacement) = f(LinkRef {
                        kind: LinkRefKind::Wiki,
                        href: target_trimmed,
                    }) {
                        // Replace the trimmed-target byte range, not
                        // the whole pre-`|` slice, so leading /
                        // trailing whitespace inside `[[  target  ]]`
                        // (rare but legal) survives the edit.
                        let lead = target_slice.len() - target_slice.trim_start().len();
                        let trail = target_slice.len() - target_slice.trim_end().len();
                        let abs_start = start + lead;
                        let abs_end = start + target_end_rel - trail;
                        edits.push((abs_start, abs_end, replacement));
                    }
                }
                i = j + 2;
                continue;
            }
        }
        i += 1;
    }

    // Standard markdown links + images via pulldown-cmark offsets.
    // Stack-based so a nested image inside a link's label gets
    // visited as its own link in addition to the outer link.
    let parser = Parser::new_ext(markdown, Options::all()).into_offset_iter();
    let mut stack: Vec<usize> = Vec::new();
    for (event, range) in parser {
        match event {
            Event::Start(Tag::Link { .. }) | Event::Start(Tag::Image { .. }) => {
                stack.push(range.start);
            }
            Event::End(TagEnd::Link) | Event::End(TagEnd::Image) => {
                let Some(start_off) = stack.pop() else {
                    continue;
                };
                let end_off = range.end;
                if end_off <= start_off || end_off > markdown.len() {
                    continue;
                }
                if in_skip(&skips, start_off) {
                    continue;
                }
                let chunk = &markdown[start_off..end_off];
                // The last `](` inside the link source is the splitter
                // between label and destination. Anything before is
                // label (possibly with nested brackets); anything
                // after is `dest title?)`. rfind is safe because the
                // dest itself cannot contain `](` unescaped.
                let Some(rel_open) = chunk.rfind("](") else {
                    continue;
                };
                let dest_open = start_off + rel_open + 2;
                // end_off includes the trailing `)`; the dest region
                // is dest_open..end_off-1.
                if end_off == 0 {
                    continue;
                }
                let dest_close = end_off - 1;
                if dest_close < dest_open {
                    continue;
                }
                let dest_raw = &markdown[dest_open..dest_close];
                // CommonMark link destination has two flavors:
                //   * Bare: `[label](url)` or `[label](url "title")`.
                //     The url ends at the first ASCII whitespace.
                //   * Angle-wrapped: `[label](<url>)` or
                //     `[label](<url> "title")`. The url is everything
                //     between `<` and `>`, including spaces.
                // We compute the byte range of just the url so the
                // title (and the angle brackets themselves) survive
                // the rewrite unchanged.
                let (href_start, href_end, href_text): (usize, usize, &str) =
                    if let Some(stripped) = dest_raw.strip_prefix('<') {
                        match stripped.find('>') {
                            Some(close_rel) => (
                                dest_open + 1,
                                dest_open + 1 + close_rel,
                                &stripped[..close_rel],
                            ),
                            None => continue,
                        }
                    } else {
                        let end_rel = dest_raw
                            .find(|c: char| c.is_ascii_whitespace())
                            .unwrap_or(dest_raw.len());
                        (dest_open, dest_open + end_rel, &dest_raw[..end_rel])
                    };
                if href_text.is_empty() {
                    continue;
                }
                if href_end > dest_close {
                    continue;
                }
                if let Some(replacement) = f(LinkRef {
                    kind: LinkRefKind::Markdown,
                    href: href_text,
                }) {
                    edits.push((href_start, href_end, replacement));
                }
            }
            _ => {}
        }
    }

    if edits.is_empty() {
        return None;
    }
    edits.sort_by_key(|e| e.0);
    // Overlapping edits would corrupt the splice; the two scanners
    // never overlap (wiki `[[...]]` and standard `[...](...)` are
    // syntactically disjoint), but guard explicitly in case future
    // scanner additions break that property.
    let mut prev_end = 0usize;
    for (start, end, _) in &edits {
        if *start < prev_end {
            tracing::warn!(
                start,
                prev_end,
                "rewrite_link_targets: overlapping edits; aborting rewrite"
            );
            return None;
        }
        prev_end = *end;
    }
    let mut out = String::with_capacity(markdown.len());
    let mut cursor = 0;
    for (start, end, repl) in &edits {
        out.push_str(&markdown[cursor..*start]);
        out.push_str(repl);
        cursor = *end;
    }
    out.push_str(&markdown[cursor..]);
    Some(out)
}

fn standard_links(markdown: &str) -> Vec<Link> {
    let parser = Parser::new_ext(markdown, Options::all());
    let mut links = Vec::new();
    let mut current_label = String::new();
    let mut in_link: Option<String> = None;

    for event in parser {
        match event {
            // `[label](dest)` and `![alt](src)` both contribute an
            // edge from the source file to the target. Image embeds
            // count: skipping them would show an image's inspector
            // view a misleading "0 backlinks" even when N markdown
            // files embed it. Treating both events as the same link
            // kind matches the wiki-side behavior (`![[img]]` produces
            // an edge because the wiki scanner ignores the leading `!`).
            Event::Start(Tag::Link { dest_url, .. })
            | Event::Start(Tag::Image { dest_url, .. }) => {
                in_link = Some(dest_url.into_string());
                current_label.clear();
            }
            Event::Text(t) if in_link.is_some() => current_label.push_str(&t),
            Event::Code(t) if in_link.is_some() => current_label.push_str(&t),
            Event::End(TagEnd::Link) | Event::End(TagEnd::Image) => {
                if let Some(target) = in_link.take() {
                    // Empty-target links/images (`[label]()`,
                    // `![alt]()`) carry no graph signal; downstream
                    // we'd build a ghost node with an empty id and
                    // Cytoscape rejects those at render time.
                    // Matches the wiki_links scanner which already
                    // requires `!target.is_empty()`.
                    if target.is_empty() {
                        current_label.clear();
                        continue;
                    }
                    let label = if current_label.is_empty() {
                        None
                    } else {
                        Some(std::mem::take(&mut current_label))
                    };
                    links.push(Link {
                        target,
                        label,
                        wiki: false,
                    });
                }
            }
            _ => {}
        }
    }
    links
}

/// Hand-rolled scanner for `[[...]]` because pulldown-cmark doesn't
/// know about wiki links. We don't nest, and a newline inside the
/// brackets aborts the match. Skips matches that fall inside ranges
/// pulldown-cmark identified as code or raw HTML, where the syntax
/// would render literally and storing it as a graph edge is a
/// phantom.
fn wiki_links(markdown: &str) -> Vec<Link> {
    let mut out = Vec::new();
    let skips = skip_ranges(markdown);
    let bytes = markdown.as_bytes();
    let mut i = 0;
    while i + 1 < bytes.len() {
        if bytes[i] == b'[' && bytes[i + 1] == b'[' {
            if in_skip(&skips, i) {
                i += 1;
                continue;
            }
            let start = i + 2;
            let mut j = start;
            while j + 1 < bytes.len() {
                if bytes[j] == b']' && bytes[j + 1] == b']' {
                    break;
                }
                if bytes[j] == b'\n' {
                    j = bytes.len();
                    break;
                }
                j += 1;
            }
            if j + 1 < bytes.len() && bytes[j] == b']' && bytes[j + 1] == b']' {
                let inner = &markdown[start..j];
                let (target, label) = match inner.split_once('|') {
                    Some((t, l)) => (t.trim().to_string(), Some(l.trim().to_string())),
                    None => (inner.trim().to_string(), None),
                };
                if !target.is_empty() {
                    out.push(Link {
                        target,
                        label,
                        wiki: true,
                    });
                }
                i = j + 2;
                continue;
            }
        }
        i += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn standard_link_extracted() {
        let links = extract_links("see [home](./index.md) for more");
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].target, "./index.md");
        assert_eq!(links[0].label.as_deref(), Some("home"));
        assert!(!links[0].wiki);
    }

    #[test]
    fn standard_image_embed_extracted() {
        // `![alt](src)` is a Tag::Image in pulldown-cmark, not a link;
        // dropping it would leave images with empty backlinks in the
        // inspector, so it must come out as an edge target.
        let links = extract_links("see ![cat](images/cat.jpg) please");
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].target, "images/cat.jpg");
        assert_eq!(links[0].label.as_deref(), Some("cat"));
        assert!(!links[0].wiki);
    }

    #[test]
    fn standard_link_and_image_both_collected() {
        let links = extract_links("[home](./i.md) and ![pic](./p.jpg)");
        assert_eq!(links.len(), 2);
        let targets: Vec<&str> = links.iter().map(|l| l.target.as_str()).collect();
        assert_eq!(targets, vec!["./i.md", "./p.jpg"]);
    }

    #[test]
    fn wiki_link_extracted() {
        let links = extract_links("see [[index]] now");
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].target, "index");
        assert!(links[0].wiki);
        assert!(links[0].label.is_none());
    }

    #[test]
    fn wiki_link_with_label() {
        let links = extract_links("ref [[notes/x|exhibit X]]");
        assert_eq!(links[0].target, "notes/x");
        assert_eq!(links[0].label.as_deref(), Some("exhibit X"));
    }

    #[test]
    fn wiki_link_no_newline_span() {
        let links = extract_links("[[bad\nlink]]");
        assert!(links.is_empty());
    }

    #[test]
    fn external_filtered() {
        let l = Link {
            target: "https://example.com".into(),
            label: None,
            wiki: false,
        };
        assert!(!l.is_internal());
    }

    #[test]
    fn relative_kept() {
        let l = Link {
            target: "./a.md".into(),
            label: None,
            wiki: false,
        };
        assert!(l.is_internal());
    }

    #[test]
    fn fragment_only_kept() {
        let l = Link {
            target: "#section".into(),
            label: None,
            wiki: false,
        };
        assert!(l.is_internal());
    }

    #[test]
    fn mixed_document() {
        let md = "Hello [a](./a.md) and [[b]] and <https://x.com>";
        let links = extract_links(md);
        assert_eq!(links.len(), 3);
    }

    #[test]
    fn wiki_link_in_fenced_code_is_skipped() {
        let md = "before\n\n```\n[[ignored]]\n```\n\nafter [[real]] tail";
        let links = extract_links(md);
        let wiki: Vec<&Link> = links.iter().filter(|l| l.wiki).collect();
        assert_eq!(wiki.len(), 1, "got: {wiki:?}");
        assert_eq!(wiki[0].target, "real");
    }

    #[test]
    fn wiki_link_in_indented_code_is_skipped() {
        let md = "para\n\n    [[ignored]]\n\nafter";
        let wiki: Vec<Link> = extract_links(md).into_iter().filter(|l| l.wiki).collect();
        assert!(wiki.is_empty(), "got: {wiki:?}");
    }

    #[test]
    fn wiki_link_in_inline_code_is_skipped() {
        let md = "use `[[example]]` and write [[real]]";
        let wiki: Vec<Link> = extract_links(md).into_iter().filter(|l| l.wiki).collect();
        assert_eq!(wiki.len(), 1);
        assert_eq!(wiki[0].target, "real");
    }

    #[test]
    fn wiki_link_in_raw_html_block_is_skipped() {
        let md = "<div>\n[[ignored]]\n</div>\n\nafter [[real]]";
        let wiki: Vec<Link> = extract_links(md).into_iter().filter(|l| l.wiki).collect();
        assert_eq!(wiki.len(), 1);
        assert_eq!(wiki[0].target, "real");
    }

    #[test]
    fn normalize_workspace_rooted_strips_leading_slash() {
        assert_eq!(normalize_href("/x.md", "notes").as_deref(), Some("x.md"));
        assert_eq!(
            normalize_href("/images/x.png", "deep/nested").as_deref(),
            Some("images/x.png"),
        );
    }

    #[test]
    fn normalize_parent_relative_walks_up() {
        assert_eq!(normalize_href("../x.md", "notes").as_deref(), Some("x.md"));
        assert_eq!(normalize_href("../../x.md", "a/b").as_deref(), Some("x.md"),);
    }

    #[test]
    fn normalize_parent_relative_escapes_workspace() {
        assert!(normalize_href("../../../x.md", "a/b").is_none());
        assert!(normalize_href("../x.md", "").is_none());
    }

    #[test]
    fn normalize_dot_relative_resolves_to_source_dir() {
        assert_eq!(
            normalize_href("./x.md", "notes").as_deref(),
            Some("notes/x.md"),
        );
    }

    #[test]
    fn normalize_bare_relative_resolves_to_source_dir() {
        assert_eq!(
            normalize_href("x.md", "notes").as_deref(),
            Some("notes/x.md"),
        );
        assert_eq!(normalize_href("x.md", "").as_deref(), Some("x.md"));
    }

    #[test]
    fn normalize_external_schemes_rejected() {
        assert!(normalize_href("https://x.com/", "notes").is_none());
        assert!(normalize_href("mailto:a@b", "notes").is_none());
        assert!(normalize_href("tel:+15551234", "notes").is_none());
    }

    #[test]
    fn normalize_fragment_only_rejected() {
        assert!(normalize_href("#section", "notes").is_none());
    }

    #[test]
    fn normalize_strips_anchor_from_relative() {
        assert_eq!(
            normalize_href("a.md#sec", "notes").as_deref(),
            Some("notes/a.md"),
        );
    }

    #[test]
    fn normalize_strips_anchor_from_absolute() {
        assert_eq!(
            normalize_href("/a.md#sec", "notes").as_deref(),
            Some("a.md"),
        );
    }

    #[test]
    fn normalize_strips_query() {
        assert_eq!(
            normalize_href("a.md?q=1", "notes").as_deref(),
            Some("notes/a.md"),
        );
    }

    #[test]
    fn normalize_strips_query_and_anchor_together() {
        assert_eq!(
            normalize_href("a.md?q=1#sec", "notes").as_deref(),
            Some("notes/a.md"),
        );
        assert_eq!(
            normalize_href("a.md#sec?q=1", "notes").as_deref(),
            Some("notes/a.md"),
        );
    }

    #[test]
    fn normalize_empty_rejected() {
        assert!(normalize_href("", "notes").is_none());
    }

    #[test]
    fn normalize_root_only_rejected() {
        assert!(normalize_href("/", "notes").is_none());
        assert!(normalize_href("/#frag", "notes").is_none());
        assert!(normalize_href("/?q=1", "notes").is_none());
    }

    #[test]
    fn normalize_preserves_spaces() {
        assert_eq!(
            normalize_href("/contacts/Jane Doe.md", "notes").as_deref(),
            Some("contacts/Jane Doe.md"),
        );
    }

    #[test]
    fn normalize_collapses_interior_dot() {
        assert_eq!(
            normalize_href("a/./b.md", "notes").as_deref(),
            Some("notes/a/b.md"),
        );
    }

    #[test]
    fn normalize_collapses_interior_double_dot() {
        assert_eq!(
            normalize_href("a/b/../c.md", "notes").as_deref(),
            Some("notes/a/c.md"),
        );
    }

    #[test]
    fn normalize_rejects_null_byte() {
        assert!(normalize_href("a\0b.md", "notes").is_none());
    }

    // ---- rewrite_link_targets -------------------------------------------

    fn rewrite_one(input: &str, from: &str, to: &str) -> Option<String> {
        rewrite_link_targets(input, |link| {
            if link.href == from {
                Some(to.to_string())
            } else {
                None
            }
        })
    }

    #[test]
    fn rewrite_standard_link_target() {
        let out = rewrite_one("see [home](./old.md) for more", "./old.md", "./new.md");
        assert_eq!(out.as_deref(), Some("see [home](./new.md) for more"));
    }

    #[test]
    fn rewrite_image_target() {
        let out = rewrite_one("![cat](images/cat.jpg) ok", "images/cat.jpg", "img/cat.jpg");
        assert_eq!(out.as_deref(), Some("![cat](img/cat.jpg) ok"));
    }

    #[test]
    fn rewrite_preserves_link_title() {
        let out = rewrite_one(
            "[home](./old.md \"the home page\") tail",
            "./old.md",
            "./new.md",
        );
        assert_eq!(
            out.as_deref(),
            Some("[home](./new.md \"the home page\") tail"),
        );
    }

    #[test]
    fn rewrite_preserves_angle_bracket_url_form() {
        let out = rewrite_one(
            "[label](<./old name.md>) tail",
            "./old name.md",
            "./new name.md",
        );
        assert_eq!(out.as_deref(), Some("[label](<./new name.md>) tail"),);
    }

    #[test]
    fn rewrite_wiki_target_no_label() {
        let out = rewrite_one("see [[old]] now", "old", "new/directory");
        assert_eq!(out.as_deref(), Some("see [[new/directory]] now"));
    }

    #[test]
    fn rewrite_wiki_target_preserves_label() {
        let out = rewrite_one("ref [[notes/x|exhibit X]]", "notes/x", "archive/x");
        assert_eq!(out.as_deref(), Some("ref [[archive/x|exhibit X]]"));
    }

    #[test]
    fn rewrite_wiki_in_code_block_skipped() {
        let md = "before\n\n```\n[[old]]\n```\n\nafter [[old]] tail";
        let out = rewrite_one(md, "old", "new").expect("rewrite ran");
        // Only the second [[old]] (outside the code fence) is rewritten.
        assert!(out.contains("```\n[[old]]\n```"));
        assert!(out.contains("after [[new]] tail"));
    }

    #[test]
    fn rewrite_standard_link_in_inline_code_skipped() {
        // pulldown-cmark won't surface a link inside backticks, so the
        // rewriter naturally skips it. Guard against regressions.
        let md = "use `[label](./old.md)` and write [label](./old.md) tail";
        let out = rewrite_one(md, "./old.md", "./new.md").expect("rewrite ran");
        assert!(out.contains("`[label](./old.md)`"));
        assert!(out.contains("[label](./new.md) tail"));
    }

    #[test]
    fn rewrite_returns_none_when_nothing_matches() {
        let out = rewrite_one("[home](./a.md) and [[b]]", "./other.md", "./new.md");
        assert!(out.is_none());
    }

    #[test]
    fn rewrite_skips_link_when_callback_returns_none() {
        let md = "[home](./old.md) and [home](./old.md)";
        let mut calls = 0;
        let out = rewrite_link_targets(md, |link| {
            calls += 1;
            if link.href == "./old.md" && calls == 1 {
                Some("./new.md".to_string())
            } else {
                None
            }
        });
        assert_eq!(
            out.as_deref(),
            Some("[home](./new.md) and [home](./old.md)")
        );
        assert_eq!(calls, 2);
    }

    #[test]
    fn rewrite_handles_nested_image_in_link() {
        // `[label-with-image](outer)` where label is `![alt](inner)`.
        // Both the inner image's src and the outer link's href should
        // be rewriteable in the same pass.
        let md = "[![alt](./img.png)](./old.md)";
        let out = rewrite_link_targets(md, |link| match link.href {
            "./img.png" => Some("./new-img.png".to_string()),
            "./old.md" => Some("./new.md".to_string()),
            _ => None,
        });
        assert_eq!(out.as_deref(), Some("[![alt](./new-img.png)](./new.md)"));
    }

    #[test]
    fn rewrite_multiple_in_one_document_order() {
        let md = "see [[a]] and [home](./b.md) and [[c|name]] end";
        let out = rewrite_link_targets(md, |link| {
            Some(match link.href {
                "a" => "A".into(),
                "./b.md" => "./B.md".into(),
                "c" => "C".into(),
                _ => return None,
            })
        });
        assert_eq!(
            out.as_deref(),
            Some("see [[A]] and [home](./B.md) and [[C|name]] end"),
        );
    }
}
