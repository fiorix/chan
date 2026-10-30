//! The byte escaping of `%output` data.
//!
//! tmux writes every byte below 0x20 and the backslash as a backslash and
//! three octal digits, and every other byte as itself, so a pane's output can
//! never contain the line break or carriage return that frames the stream.

/// Decode the data of an `%output` or `%extended-output` line.
///
/// Lenient on purpose: a stray raw byte below 0x20 is dropped and a backslash
/// that does not start three octal digits for a byte becomes `?`, so one
/// damaged byte costs one byte and not the connection.
pub fn unescape_output(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len());
    let mut i = 0;
    while i < data.len() {
        let b = data[i];
        if b == b'\\' {
            match octal_byte(data.get(i + 1..i + 4)) {
                Some(v) => {
                    out.push(v);
                    i += 4;
                }
                None => {
                    out.push(b'?');
                    i += 1;
                }
            }
        } else if b < 0x20 {
            i += 1;
        } else {
            out.push(b);
            i += 1;
        }
    }
    out
}

fn octal_byte(digits: Option<&[u8]>) -> Option<u8> {
    let d = digits.filter(|d| d.len() == 3)?;
    if !d.iter().all(|b| (b'0'..=b'7').contains(b)) {
        return None;
    }
    let v = u32::from(d[0] - b'0') * 64 + u32::from(d[1] - b'0') * 8 + u32::from(d[2] - b'0');
    u8::try_from(v).ok()
}

/// The inverse of [`unescape_output`], as tmux writes it.
pub fn escape_output(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len());
    for &b in data {
        if b < 0x20 || b == b'\\' {
            out.push(b'\\');
            out.push(b'0' + (b >> 6));
            out.push(b'0' + ((b >> 3) & 7));
            out.push(b'0' + (b & 7));
        } else {
            out.push(b);
        }
    }
    out
}

/// Lowercase hex pairs separated by single spaces, the argument list of
/// `send-keys -H`.
pub(crate) fn hex_pairs(data: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(data.len() * 3);
    for (i, &b) in data.iter().enumerate() {
        if i > 0 {
            out.push(' ');
        }
        out.push(char::from(DIGITS[usize::from(b >> 4)]));
        out.push(char::from(DIGITS[usize::from(b & 15)]));
    }
    out
}
