use std::fmt;

macro_rules! id {
    ($(#[$doc:meta])* $name:ident, $sigil:literal) => {
        $(#[$doc])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
        pub struct $name(pub u32);

        impl $name {
            /// Parse the id as tmux prints it, sigil first.
            pub fn parse(text: &str) -> Option<Self> {
                let digits = text.strip_prefix($sigil)?;
                if digits.is_empty() || digits.len() > 10 || !digits.bytes().all(|b| b.is_ascii_digit()) {
                    return None;
                }
                digits.parse().ok().map(Self)
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(f, "{}{}", $sigil, self.0)
            }
        }
    };
}

id!(
    /// A pane, `%N`.
    PaneId, "%"
);
id!(
    /// A window, `@N`.
    WindowId, "@"
);
id!(
    /// A session, `$N`.
    SessionId, "$"
);
