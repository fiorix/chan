//! A window's title with its caption, as every surface that prints one reads
//! it: `cs window list` and chan-desktop's OS title. The machine-neutral title
//! itself is the library's (`chan_library::windows::window_title`); the
//! caption is appended here because this crate is the one both the `cs`
//! client and chan-desktop link, and the client cannot link the library. The
//! caption stays out of the persisted title: a user changes it at any time,
//! and a title composed when the row was minted would go stale.

/// `title` with the user's `caption` in brackets after it,
/// `chan Window 1 [notes]`, or `title` alone when the caption is empty or
/// only whitespace. The caption is trimmed: the server trims before it stores
/// one, but a record from another build may carry the spaces.
pub fn captioned_window_title(title: &str, caption: &str) -> String {
    let caption = caption.trim();
    if caption.is_empty() {
        title.to_string()
    } else {
        format!("{title} [{caption}]")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_caption_follows_the_title_in_brackets() {
        assert_eq!(
            captioned_window_title("chan Window 1", "notes"),
            "chan Window 1 [notes]"
        );
        assert_eq!(
            captioned_window_title("Terminal Window 2", "  deploy shell  "),
            "Terminal Window 2 [deploy shell]"
        );
        // No caption, or only whitespace, opens no empty pair of brackets.
        assert_eq!(
            captioned_window_title("Terminal Window 2", ""),
            "Terminal Window 2"
        );
        assert_eq!(
            captioned_window_title("Terminal Window 2", "   "),
            "Terminal Window 2"
        );
    }
}
