//! A display reading attributed to the observed foreground, never to a guessed PTY writer.

const MAX_PAYLOAD_BYTES: usize = 4096;
const MAX_DISPLAY_CHARS: usize = 128;

/// Display text only; process ownership and lookup revisions never leave the observer.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(super) struct ProgramReading {
    pub title: Option<String>,
    pub command: Option<String>,
}

/// Unsupported foreground tracking is distinct from a failed Unix observation.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) enum Foreground {
    Group(u32),
    #[default]
    Unavailable,
    TitleOnly,
}

/// A lookup belongs to this observer's revision, not merely to a reusable group id.
#[derive(Clone, Copy, Debug)]
pub(super) struct NameRequest {
    group: u32,
    revision: u64,
}

impl NameRequest {
    pub(super) fn group(self) -> u32 {
        self.group
    }
}

/// Titles live only as long as their observed ownership is provable. No old title is cached
/// for a returning group, and no output replay is needed to read the current pair.
#[derive(Default)]
pub(super) struct TerminalProgram {
    scanner: Scanner,
    reading: ProgramReading,
    foreground: Foreground,
    title_owner: Option<Foreground>,
    revision: u64,
}

impl TerminalProgram {
    pub(super) fn reading(&self) -> &ProgramReading {
        &self.reading
    }

    /// One foreground observation covers the read, including a carried candidate.
    /// Names are applied separately so an output lock need not cover blocking I/O.
    pub(super) fn feed(&mut self, bytes: &[u8], probe: impl FnOnce() -> Foreground) {
        if bytes.is_empty() {
            return;
        }
        if self.scanner.has_candidate() || memchr::memchr(0x1b, bytes).is_some() {
            self.set_foreground(probe());
        }
        if let Some(update) = self.scanner.feed(bytes) {
            self.advance_revision();
            self.clear_title();
            if let Update::Title(title) = update {
                if self.foreground != Foreground::Unavailable {
                    self.reading.title = title;
                    self.title_owner = self.reading.title.as_ref().map(|_| self.foreground);
                }
            }
        }
    }

    /// Capture a name lookup token after expiring any unprovable ownership.
    /// The caller owns the sampling cadence and performs the lookup without this state locked.
    pub(super) fn observe(&mut self, probe: impl FnOnce() -> Foreground) -> Option<NameRequest> {
        self.set_foreground(probe());
        match self.foreground {
            Foreground::Group(group) => Some(NameRequest {
                group,
                revision: self.revision,
            }),
            Foreground::Unavailable | Foreground::TitleOnly => None,
        }
    }

    /// Accept only a lookup whose revision and foreground still match; `after` is a fresh
    /// observation after the lookup. A false result means the name was not applied.
    pub(super) fn apply_name(
        &mut self,
        request: NameRequest,
        after: Foreground,
        name: Option<&str>,
    ) -> bool {
        if request.revision != self.revision || self.foreground != Foreground::Group(request.group)
        {
            return false;
        }
        self.set_foreground(after);
        if self.foreground != Foreground::Group(request.group) {
            return false;
        }
        let command = name.and_then(normalize);
        if let (Some(old), Some(new)) = (&self.reading.command, &command) {
            if old != new {
                self.clear_title();
                self.scanner.discard_candidate();
            }
        }
        self.reading.command = command;
        self.advance_revision();
        true
    }

    /// End an incarnation without allowing an outstanding lookup or partial OSC to revive it.
    pub(super) fn clear(&mut self) {
        self.scanner = Scanner::default();
        self.reading = ProgramReading::default();
        self.foreground = Foreground::Unavailable;
        self.title_owner = None;
        self.advance_revision();
    }

    fn set_foreground(&mut self, foreground: Foreground) {
        if self.foreground != foreground {
            self.clear_title();
            self.reading.command = None;
            self.scanner.discard_candidate();
            self.foreground = foreground;
            self.advance_revision();
        }
    }

    fn clear_title(&mut self) {
        self.reading.title = None;
        self.title_owner = None;
    }

    fn advance_revision(&mut self) {
        self.revision = self.revision.wrapping_add(1);
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Update {
    Title(Option<String>),
    Reset,
}

#[derive(Clone, Copy, Default)]
enum Framing {
    #[default]
    Ground,
    Escape,
    Intermediate,
    Csi,
    Identifier(Option<u8>),
    Body,
    BodyEscape,
    Discard {
        bel_ends: bool,
        escape: bool,
    },
}

#[derive(Default)]
struct Scanner {
    framing: Framing,
    body: Vec<u8>,
}

impl Scanner {
    fn feed(&mut self, mut bytes: &[u8]) -> Option<Update> {
        let mut last = None;
        while !bytes.is_empty() {
            if matches!(self.framing, Framing::Ground) {
                let Some(at) = memchr::memchr(0x1b, bytes) else {
                    break;
                };
                bytes = &bytes[at..];
            }
            last = self.advance(bytes[0]).or(last);
            bytes = &bytes[1..];
        }
        last
    }

    fn advance(&mut self, byte: u8) -> Option<Update> {
        if matches!(byte, 0x18 | 0x1a) {
            self.framing = Framing::Ground;
            self.body.clear();
            return None;
        }
        match self.framing {
            Framing::Ground => {
                if byte == 0x1b {
                    self.framing = Framing::Escape;
                }
            }
            Framing::Escape => {
                self.framing = match byte {
                    b']' => Framing::Identifier(None),
                    b'[' => Framing::Csi,
                    b'P' | b'X' | b'^' | b'_' => Framing::Discard {
                        bel_ends: false,
                        escape: false,
                    },
                    b'c' => {
                        self.framing = Framing::Ground;
                        return Some(Update::Reset);
                    }
                    0x20..=0x2f => Framing::Intermediate,
                    0x00..=0x1f => Framing::Escape,
                    _ => Framing::Ground,
                };
            }
            Framing::Intermediate | Framing::Csi => {
                if byte == 0x1b {
                    self.framing = Framing::Escape;
                } else if byte >= 0x30 && (!matches!(self.framing, Framing::Csi) || byte >= 0x40) {
                    self.framing = Framing::Ground;
                }
            }
            Framing::Identifier(identifier) => {
                self.framing = match (identifier, byte) {
                    (None, b'0' | b'2') => Framing::Identifier(Some(byte)),
                    (Some(_), b';') => Framing::Body,
                    (_, 0x07) => Framing::Ground,
                    (_, 0x1b) => Framing::Escape,
                    _ => Framing::Discard {
                        bel_ends: true,
                        escape: false,
                    },
                };
            }
            Framing::Body => match byte {
                0x07 => return Some(self.finish_title()),
                0x1b => self.framing = Framing::BodyEscape,
                _ if self.body.len() == MAX_PAYLOAD_BYTES => {
                    self.body.clear();
                    self.framing = Framing::Discard {
                        bel_ends: true,
                        escape: false,
                    };
                }
                _ => self.body.push(byte),
            },
            Framing::BodyEscape => {
                if byte == b'\\' {
                    return Some(self.finish_title());
                }
                self.body.clear();
                self.framing = Framing::Escape;
                return self.advance(byte);
            }
            Framing::Discard { bel_ends, escape } => {
                self.framing = if (bel_ends && byte == 0x07) || (escape && byte == b'\\') {
                    Framing::Ground
                } else {
                    Framing::Discard {
                        bel_ends,
                        escape: byte == 0x1b,
                    }
                };
            }
        }
        None
    }

    fn finish_title(&mut self) -> Update {
        let title = normalize(&String::from_utf8_lossy(&self.body));
        self.body.clear();
        self.framing = Framing::Ground;
        Update::Title(title)
    }

    fn has_candidate(&self) -> bool {
        matches!(
            self.framing,
            Framing::Escape | Framing::Identifier(_) | Framing::Body | Framing::BodyEscape
        )
    }

    // Keep framing through the terminator so a new owner cannot inherit a suffix.
    fn discard_candidate(&mut self) {
        self.body.clear();
        self.framing = match self.framing {
            Framing::Escape => Framing::Ground,
            Framing::Identifier(_) | Framing::Body => Framing::Discard {
                bel_ends: true,
                escape: false,
            },
            Framing::BodyEscape => Framing::Discard {
                bel_ends: true,
                escape: true,
            },
            other => other,
        };
    }
}

fn normalize(value: &str) -> Option<String> {
    let filtered: String = value.chars().filter(|ch| !ch.is_control()).collect();
    let trimmed = filtered.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.chars().take(MAX_DISPLAY_CHARS).collect())
    }
}

#[cfg(test)]
#[path = "terminal_program_tests.rs"]
mod tests;
