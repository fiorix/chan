//! Window layouts: the text form every tmux prints and the JSON form tmux 3.8
//! prints once a client asks for `new-layouts`.

use std::fmt;

use crate::ids::PaneId;

/// Deepest nesting accepted.
const MAX_DEPTH: usize = 16;
/// Most cells (splits and panes together) accepted.
const MAX_CELLS: usize = 1024;
/// Largest width or height accepted, in cells.
const MAX_DIM: u32 = 100_000;

/// A parsed window layout.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Layout {
    pub root: Cell,
}

/// A rectangle of the window: a pane, or a split holding more cells.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cell {
    pub width: u32,
    pub height: u32,
    pub x: u32,
    pub y: u32,
    pub kind: Kind,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Kind {
    Pane(PaneId),
    /// Children side by side (`{...}`).
    Horizontal(Vec<Cell>),
    /// Children stacked (`[...]`).
    Vertical(Vec<Cell>),
}

impl Layout {
    /// Every pane in the layout, left to right and top to bottom.
    pub fn panes(&self) -> Vec<PaneId> {
        fn walk(cell: &Cell, out: &mut Vec<PaneId>) {
            match &cell.kind {
                Kind::Pane(id) => out.push(*id),
                Kind::Horizontal(c) | Kind::Vertical(c) => c.iter().for_each(|c| walk(c, out)),
            }
        }
        let mut out = Vec::new();
        walk(&self.root, &mut out);
        out
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LayoutError {
    Syntax(&'static str),
    Checksum,
    TooDeep,
    TooLarge,
    /// A form this crate does not read (floating panes).
    Unsupported,
}

impl fmt::Display for LayoutError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            LayoutError::Syntax(what) => write!(f, "layout syntax: {what}"),
            LayoutError::Checksum => f.write_str("layout checksum mismatch"),
            LayoutError::TooDeep => f.write_str("layout nests too deeply"),
            LayoutError::TooLarge => f.write_str("layout has too many cells"),
            LayoutError::Unsupported => f.write_str("layout form not supported"),
        }
    }
}

impl std::error::Error for LayoutError {}

/// tmux's layout checksum of the text after the first comma.
pub fn checksum(layout: &str) -> u16 {
    let mut csum: u16 = 0;
    for b in layout.bytes() {
        csum = (csum >> 1).wrapping_add((csum & 1) << 15);
        csum = csum.wrapping_add(u16::from(b));
    }
    csum
}

/// Parse either layout form.
pub fn parse_layout(text: &str) -> Result<Layout, LayoutError> {
    if text.starts_with('{') {
        parse_json(text)
    } else {
        parse_text(text)
    }
}

fn parse_text(text: &str) -> Result<Layout, LayoutError> {
    let (csum, body) = text
        .split_once(',')
        .ok_or(LayoutError::Syntax("checksum"))?;
    if csum.len() != 4 {
        return Err(LayoutError::Syntax("checksum"));
    }
    let want = u16::from_str_radix(csum, 16).map_err(|_| LayoutError::Syntax("checksum"))?;
    if want != checksum(body) {
        return Err(LayoutError::Checksum);
    }
    let mut p = Parser {
        s: body.as_bytes(),
        i: 0,
        cells: 0,
    };
    let root = p.cell(0)?;
    if p.i != p.s.len() {
        return Err(LayoutError::Syntax("trailing bytes"));
    }
    Ok(Layout { root })
}

struct Parser<'a> {
    s: &'a [u8],
    i: usize,
    cells: usize,
}

impl Parser<'_> {
    fn number(&mut self) -> Result<u32, LayoutError> {
        let start = self.i;
        while self.s.get(self.i).is_some_and(u8::is_ascii_digit) {
            self.i += 1;
        }
        if self.i == start || self.i - start > 9 {
            return Err(LayoutError::Syntax("number"));
        }
        std::str::from_utf8(&self.s[start..self.i])
            .ok()
            .and_then(|t| t.parse().ok())
            .ok_or(LayoutError::Syntax("number"))
    }

    fn expect(&mut self, b: u8) -> Result<(), LayoutError> {
        if self.s.get(self.i) == Some(&b) {
            self.i += 1;
            Ok(())
        } else {
            Err(LayoutError::Syntax("separator"))
        }
    }

    fn cell(&mut self, depth: usize) -> Result<Cell, LayoutError> {
        if depth > MAX_DEPTH {
            return Err(LayoutError::TooDeep);
        }
        self.cells += 1;
        if self.cells > MAX_CELLS {
            return Err(LayoutError::TooLarge);
        }
        if self.s.get(self.i) == Some(&b'<') {
            return Err(LayoutError::Unsupported);
        }
        let width = self.number()?;
        self.expect(b'x')?;
        let height = self.number()?;
        self.expect(b',')?;
        let x = self.number()?;
        self.expect(b',')?;
        let y = self.number()?;
        if width > MAX_DIM || height > MAX_DIM {
            return Err(LayoutError::TooLarge);
        }
        let kind = match self.s.get(self.i) {
            Some(b',') => {
                self.i += 1;
                Kind::Pane(PaneId(self.number()?))
            }
            Some(&open @ (b'{' | b'[')) => {
                self.i += 1;
                let close = if open == b'{' { b'}' } else { b']' };
                let mut children = vec![self.cell(depth + 1)?];
                while self.s.get(self.i) == Some(&b',') {
                    self.i += 1;
                    children.push(self.cell(depth + 1)?);
                }
                self.expect(close)?;
                if open == b'{' {
                    Kind::Horizontal(children)
                } else {
                    Kind::Vertical(children)
                }
            }
            _ => return Err(LayoutError::Syntax("cell")),
        };
        Ok(Cell {
            width,
            height,
            x,
            y,
            kind,
        })
    }
}

fn parse_json(text: &str) -> Result<Layout, LayoutError> {
    use serde_json::Value;
    let v: Value = serde_json::from_str(text).map_err(|_| LayoutError::Syntax("json"))?;
    let root = v.get("L").ok_or(LayoutError::Syntax("json root"))?;
    let mut cells = 0;
    let root = json_cell(root, 0, &mut cells)?;
    Ok(Layout { root })
}

fn json_cell(v: &serde_json::Value, depth: usize, cells: &mut usize) -> Result<Cell, LayoutError> {
    if depth > MAX_DEPTH {
        return Err(LayoutError::TooDeep);
    }
    *cells += 1;
    if *cells > MAX_CELLS {
        return Err(LayoutError::TooLarge);
    }
    let num = |key: &'static str| -> Result<u32, LayoutError> {
        v.get(key)
            .and_then(serde_json::Value::as_u64)
            .and_then(|n| u32::try_from(n).ok())
            .ok_or(LayoutError::Syntax("json number"))
    };
    let width = num("w")?;
    let height = num("h")?;
    if width > MAX_DIM || height > MAX_DIM {
        return Err(LayoutError::TooLarge);
    }
    let (x, y) = (num("x")?, num("y")?);
    let kind = match v.get("t").and_then(serde_json::Value::as_str) {
        Some("p") => {
            let id = v
                .get("I")
                .and_then(serde_json::Value::as_str)
                .and_then(PaneId::parse)
                .ok_or(LayoutError::Syntax("json pane id"))?;
            Kind::Pane(id)
        }
        Some(t @ ("h" | "v")) => {
            let children = v
                .get("c")
                .and_then(serde_json::Value::as_array)
                .filter(|c| !c.is_empty())
                .ok_or(LayoutError::Syntax("json children"))?
                .iter()
                .map(|c| json_cell(c, depth + 1, cells))
                .collect::<Result<Vec<_>, _>>()?;
            if t == "h" {
                Kind::Horizontal(children)
            } else {
                Kind::Vertical(children)
            }
        }
        _ => return Err(LayoutError::Unsupported),
    };
    Ok(Cell {
        width,
        height,
        x,
        y,
        kind,
    })
}
