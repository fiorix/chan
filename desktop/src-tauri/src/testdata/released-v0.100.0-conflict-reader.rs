// The conflict reader of the chan-desktop v0.100.0 release, kept as test
// data. Everything below the marker line is desktop/src-tauri/src/devserver.rs
// at tag v0.100.0 (commit ee060262e240f0b4c5a4e0764c2ca693bc08c4e7), lines
// 299 to 496, byte for byte:
//
//   git show v0.100.0:desktop/src-tauri/src/devserver.rs | sed -n '299,496p'
//
// The test module that includes this file compiles that text and holds its
// SHA-256, so an edit below the marker, a reformat included, fails there. A
// released reader does not change: fix nothing here.
//
// ---- released text begins below this line ----
const LIVE_TERMINALS: &str = "live_terminals";

/// Why a devserver workspace on/off/forget failed, structured so a caller can
/// tell a confirm-before-off (live terminals, offer to force) from a refusal
/// the devserver explained, and both from everything else. The split is by
/// answer shape, not by whether an answer arrived: a 409 is the devserver
/// declining a request it understood, while every other status and every
/// transport failure alike land in `Other`. It stays inside the desktop: the
/// bridge handlers in `main.rs` map it onto the outcome the launcher route
/// answers with.
#[derive(Debug)]
pub enum SetWorkspaceOnError {
    /// An unforced off or forget was rejected: `active_terminals` live
    /// terminals would be killed. The caller confirms, then retries with
    /// `force: true`.
    ActiveTerminals { active_terminals: usize },
    /// A 409: the devserver declined the request and said why. The message is
    /// the peer's own words wherever it sent any, carrying no wording of ours,
    /// though they pass [`peer_message`] first so a caller may print them;
    /// where it sent none, the message names the status instead. Distinct from
    /// [`Other`](Self::Other) because a decline is an answer about this
    /// request, which is what makes it the one failure no caller may absorb
    /// into a success.
    Refused { message: String },
    /// Any other failure (network, decode, any non-409 status), as a plain
    /// message. Answered or not: a 500 from a reachable devserver lands here
    /// beside a connection that never opened.
    Other { message: String },
}

/// Longest peer refusal message kept, in characters.
const MAX_REFUSAL_MESSAGE_CHARS: usize = 200;

/// A character that changes what a surface DOES rather than what it says, so
/// a peer may not put one in front of a reader: the ASCII and C1 controls,
/// where an escape sequence lives; the line and paragraph separators, which
/// end a line in a surface promised one string; the bidirectional controls,
/// which reorder what is displayed without changing what the string contains;
/// and the zero-width characters, which hide text outright.
///
/// Deliberately absent: the zero-width joiners, the variation selectors and
/// the tag characters. Those carry meaning inside ordinary text, an emoji
/// family or flag sequence among them, and editing them out of a legitimate
/// message would damage what it says. That they cannot
/// render alone is [`is_invisible`]'s business, which answers a different
/// question.
fn is_unshowable(c: char) -> bool {
    c.is_control()
        || matches!(c,
            '\u{00ad}'                  // soft hyphen
            | '\u{061c}'                // arabic letter mark
            | '\u{180e}'                // mongolian vowel separator
            | '\u{200b}'                // zero width space
            | '\u{200e}' | '\u{200f}'   // LRM, RLM
            | '\u{2028}'                // line separator
            | '\u{2029}'                // paragraph separator
            | '\u{202a}'..='\u{202e}'   // bidi embeddings and overrides
            | '\u{2066}'..='\u{2069}'   // bidi isolates
            | '\u{feff}'                // zero width no-break space
        )
}

/// A character that renders nothing on its own. A string of only these is not
/// empty, so without this it would reach a banner as a blank, and a
/// discriminator with one appended would not compare equal to itself.
///
/// Broader than [`is_unshowable`] because the question is different: not
/// whether a reader may be shown this, but whether there is anything to see.
/// It adds the selectors and tags that the editing pass deliberately keeps.
fn is_invisible(c: char) -> bool {
    is_unshowable(c)
        || matches!(c,
            '\u{200c}' | '\u{200d}'     // zero width non-joiner, joiner
            | '\u{2060}'..='\u{2064}'   // word joiner, invisible operators
            | '\u{fe00}'..='\u{fe0f}'   // variation selectors
            | '\u{e0000}'..='\u{e007f}' // tags
            | '\u{e0100}'..='\u{e01ef}' // variation selectors supplement
        )
}

/// Whether `text` holds anything a reader could actually see.
fn has_visible_content(text: &str) -> bool {
    text.chars().any(|c| !c.is_whitespace() && !is_invisible(c))
}

/// Whether `message` says only the live-terminals discriminator, whatever
/// invisible characters surround it. Compared on the visible characters alone
/// so a tag or a selector appended to the token cannot smuggle it past.
fn is_bare_discriminator(message: &str) -> bool {
    message
        .chars()
        .filter(|c| !is_invisible(*c) && !c.is_whitespace())
        .eq(LIVE_TERMINALS.chars())
}

/// Make a peer's own words fit to show. Anything [`is_unshowable`] names
/// becomes a space, runs of whitespace collapse to one, and the result is cut
/// to [`MAX_REFUSAL_MESSAGE_CHARS`] on a character boundary.
///
/// The collapse is what keeps the cap useful: a body of two hundred control
/// characters followed by a sentence would otherwise spend the whole budget on
/// substituted spaces and discard the reason. Ordinary text, including
/// non-ASCII, is left as it is.
fn peer_message(raw: &str) -> String {
    let mut out = String::new();
    let mut kept = 0usize;
    let mut pending_space = false;
    for raw_char in raw.chars() {
        let c = if is_unshowable(raw_char) {
            ' '
        } else {
            raw_char
        };
        if c.is_whitespace() {
            pending_space = kept > 0;
            continue;
        }
        if pending_space {
            if kept == MAX_REFUSAL_MESSAGE_CHARS {
                break;
            }
            out.push(' ');
            kept += 1;
            pending_space = false;
        }
        if kept == MAX_REFUSAL_MESSAGE_CHARS {
            break;
        }
        out.push(c);
        kept += 1;
    }
    out
}

/// Read a `409 Conflict` by its body rather than by its status.
///
/// The server answers refusals in more than one shape and a route's set of
/// them can grow, so the body decides: a JSON object carrying a numeric
/// `active_terminals` is the confirm-before-off signal whatever its `error`
/// says; a JSON object carrying no count but a non-empty string `error` uses
/// that string as the message, which is the shape a server moving its
/// refusals into an `{"error": ...}` envelope sends; anything else is its own
/// message. Nothing here invents a count, so a body that carries none can
/// never read as a measured zero.
///
/// The count decides over the reason because the count is the only field that
/// can be acted on: it is what offers the force-retry. An envelope that keeps
/// a sentence in `error` and the count beside it reads correctly this way and
/// would otherwise lose the retry, and a body that carries a count and means
/// something else by it has never existed.
///
/// The launcher reads the same body with `refusalReason` and
/// `liveTerminalsCount`, and this is deliberately one case wider than those
/// two. The launcher only ever calls its own server; the desktop dials
/// devservers of other releases, and the count arrived without the
/// `live_terminals` discriminator before that field existed, while the
/// connect gate is the protocol number rather than the version.
///
/// A peer's own words go through [`peer_message`] before they are tested or
/// kept, so what a banner and the `chan` terminal receive is bounded and inert
/// whatever answered, and a discriminator padded with whitespace is caught by
/// the same pass that would have shown it.
async fn refusal_from_conflict(resp: reqwest::Response) -> SetWorkspaceOnError {
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    let parsed = serde_json::from_str::<serde_json::Value>(&body).ok();
    let error = parsed
        .as_ref()
        .and_then(|value| value.get("error"))
        .and_then(serde_json::Value::as_str);
    let count = parsed
        .as_ref()
        .and_then(|value| value.get("active_terminals"))
        .and_then(serde_json::Value::as_u64)
        .and_then(|count| usize::try_from(count).ok());
    if let Some(active_terminals) = count {
        return SetWorkspaceOnError::ActiveTerminals { active_terminals };
    }
    // Without a count there is nothing to act on, so the reason is the answer.
    // An `error` holding only the discriminator names no reason either, and a
    // blank one names nothing at all: both fall through to the status, because
    // a banner reading `live_terminals` or reading empty is the failure this
    // reader exists to remove. Both tests read the normalized message, so a
    // padded discriminator and a body of nothing but control characters take
    // the same fallback as their plain forms.
    let reason = error
        .map(peer_message)
        .filter(|message| has_visible_content(message) && !is_bare_discriminator(message))
        .unwrap_or_else(|| {
            let body = peer_message(&body);
            if !has_visible_content(&body) || error.is_some() {
                format!("devserver refused with HTTP {status}")
            } else {
                body
            }
        });
    SetWorkspaceOnError::Refused { message: reason }
}
