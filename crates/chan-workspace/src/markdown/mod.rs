// Markdown parsing for indexing.
//
// Native-only port of the parts of `chan-shared` that the indexer
// needs: ATX heading detection, YAML frontmatter, link extraction
// (markdown + wiki), and reference-token extraction (#tag, @@mention,
// YYYY-MM-DD). The smart-node serializer and wasm bindings stay in
// the chan repo's editor-side code; chan-workspace only sees plain
// markdown on disk.
//
// All parsers are pure functions. They allocate but don't touch
// the filesystem; callers feed them the file's contents.

pub mod frontmatter;
pub mod headings;
pub mod links;
pub mod tokens;

pub use frontmatter::{
    chan_kind, parse as parse_frontmatter, ChanKindSpec, Frontmatter, CHAN_KIND_REGISTRY,
};
pub use headings::{parse as parse_headings, Heading};
pub use links::{extract_links, normalize_href, rewrite_link_targets, Link, LinkRef, LinkRefKind};
pub use tokens::{extract_tokens, Token};

/// Compute a heading anchor slug from display text. Lowercase,
/// non-alphanumeric runs collapsed to a single `-`, leading/trailing
/// `-` stripped. Matches the convention most markdown renderers
/// (GitHub, Obsidian) use so wiki-link anchors round-trip with the
/// rendered output.
pub fn heading_anchor(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut last_dash = true;
    for c in text.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn anchor_basic() {
        assert_eq!(heading_anchor("Some Title"), "some-title");
    }

    #[test]
    fn anchor_strips_punctuation() {
        assert_eq!(heading_anchor("What's up, Doc?"), "what-s-up-doc");
    }

    #[test]
    fn anchor_collapses_runs() {
        assert_eq!(heading_anchor("a   b   c"), "a-b-c");
    }

    #[test]
    fn anchor_trims_edges() {
        assert_eq!(heading_anchor("  hello  "), "hello");
    }

    #[test]
    fn anchor_unicode_passes_through_word_chars_only() {
        // Non-ASCII letters become separators: the slug keeps only [A-Za-z0-9-]. GitHub keeps Unicode letters in its anchors, so a heading with non-ASCII letters gets a different anchor here.
        assert_eq!(heading_anchor("café au lait"), "caf-au-lait");
    }
}
