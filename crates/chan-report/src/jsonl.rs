// JSONL writer + reader for the on-disk report format.
//
// One record per line, `kind` is the discriminator: meta, file,
// language, totals, cocomo. The exact shape is documented in
// design.md section 4. The reader recomputes roll-ups from the
// `file` records on load and ignores any persisted `language` /
// `totals` / `cocomo` rows (treats them as advisory).

use std::io::{BufRead, Write};

use serde_json::{Map, Value};

use crate::cocomo::CocomoSummary;
use crate::error::ChanReportError;
use crate::summary::{FileStats, LanguageStats, ReportMeta, Totals};

/// Write a full report (meta + every file row + roll-ups +
/// cocomo) to `w`. One JSON object per line, LF-terminated.
pub(crate) fn write_report<W: Write>(
    mut w: W,
    meta: &ReportMeta,
    files: &[FileStats],
    by_language: &[LanguageStats],
    totals: &Totals,
    cocomo: &CocomoSummary,
) -> Result<(), ChanReportError> {
    write_tagged(&mut w, "meta", meta)?;
    for f in files {
        write_tagged(&mut w, "file", f)?;
    }
    for l in by_language {
        write_tagged(&mut w, "language", l)?;
    }
    write_tagged(&mut w, "totals", totals)?;
    write_tagged(&mut w, "cocomo", cocomo)?;
    Ok(())
}

/// Read a JSONL file into the components needed to reconstruct
/// an `Index`. Returns the `meta` record and the deserialized
/// `file` rows; the caller recomputes roll-ups.
pub(crate) fn read_file_rows<R: BufRead>(
    r: R,
) -> Result<(ReportMeta, Vec<FileStats>), ChanReportError> {
    let mut meta: Option<ReportMeta> = None;
    let mut files = Vec::new();
    for (idx, line) in r.lines().enumerate() {
        let line_no = (idx + 1) as u64;
        let line = line.map_err(|e| ChanReportError::Io(e.to_string()))?;
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let v: Value = serde_json::from_str(trimmed).map_err(|e| ChanReportError::JsonlParse {
            line: line_no,
            message: e.to_string(),
        })?;
        let kind = v.get("kind").and_then(|k| k.as_str()).unwrap_or("");
        match kind {
            "meta" => {
                let m: ReportMeta =
                    serde_json::from_value(v).map_err(|e| ChanReportError::JsonlParse {
                        line: line_no,
                        message: e.to_string(),
                    })?;
                meta = Some(m);
            }
            "file" => {
                let f: FileStats =
                    serde_json::from_value(v).map_err(|e| ChanReportError::JsonlParse {
                        line: line_no,
                        message: e.to_string(),
                    })?;
                files.push(f);
            }
            // Roll-ups are recomputed on load; ignore. Unknown
            // kinds are forward-compat (newer writer, older
            // reader) and intentionally tolerated.
            _ => {}
        }
    }
    let meta = meta.ok_or_else(|| ChanReportError::JsonlParse {
        line: 0,
        message: "missing meta record".into(),
    })?;
    Ok((meta, files))
}

fn write_tagged<W: Write, T: serde::Serialize>(
    w: &mut W,
    kind: &'static str,
    value: &T,
) -> Result<(), ChanReportError> {
    let v = serde_json::to_value(value).map_err(|e| ChanReportError::JsonlParse {
        line: 0,
        message: e.to_string(),
    })?;
    let Value::Object(orig) = v else {
        return Err(ChanReportError::JsonlParse {
            line: 0,
            message: format!("record `{}` did not serialize to an object", kind),
        });
    };
    // Rebuild with `kind` first for readability.
    let mut out = Map::with_capacity(orig.len() + 1);
    out.insert("kind".into(), Value::String(kind.into()));
    for (k, v) in orig {
        out.insert(k, v);
    }
    let line =
        serde_json::to_string(&Value::Object(out)).map_err(|e| ChanReportError::JsonlParse {
            line: 0,
            message: e.to_string(),
        })?;
    w.write_all(line.as_bytes())
        .map_err(|e| ChanReportError::Io(e.to_string()))?;
    w.write_all(b"\n")
        .map_err(|e| ChanReportError::Io(e.to_string()))?;
    Ok(())
}
