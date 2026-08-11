#!/usr/bin/env python3
"""Verify content-anchored source citations in roadmap items.

A positional citation (`file.rs:1234`) keeps resolving after the code moves and
points at whatever now occupies that line, so it fails open and silently. A
content needle fails loudly, but only if something actually counts it. This is
that something.

Records live in ```citations fenced blocks, one per line, tab-separated:

    path<TAB>symbol<TAB>expect<TAB>needle

The needle is LAST and is never split, because a needle is arbitrary source
text and can contain any delimiter a table might use. A dry run of an earlier
design split inside the needle `|| p.q.trim().is_empty()` and reported a
mismatch for a citation that was correct, which is a failure in the worst
direction: it sends a reader hunting a defect that does not exist.

`expect` is an integer, or DEAD for a reference that is deliberately dead and
must not be "fixed" by a future sweep.

Exit status is 0 when every record is GOOD or DEAD, and 1 otherwise. A record
whose file is missing is UNRESOLVED and is reported, never skipped: a check
that silently drops what it cannot read reports success for work it did not do.
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from pathlib import Path

BLOCK = re.compile(r"^```citations[ \t]*$(.*?)^```[ \t]*$", re.MULTILINE | re.DOTALL)

GOOD = "GOOD"
DEAD = "DEAD"
DRIFTED = "DRIFTED"
MISSING = "MISSING"
UNRESOLVED = "UNRESOLVED"
MALFORMED = "MALFORMED"

FAILING = {DRIFTED, MISSING, UNRESOLVED, MALFORMED}


@dataclass
class Record:
    source: Path
    lineno: int
    path: str = ""
    symbol: str = ""
    expect: str = ""
    needle: str = ""
    raw: str = ""


@dataclass
class Result:
    record: Record
    verdict: str
    actual: int = 0
    lines: int = 0
    detail: str = ""


def parse(doc: Path) -> list[Record]:
    """Pull every citation record out of a markdown file.

    Records are extracted from fenced blocks rather than from prose, because a
    checker that has to parse prose cannot be trusted with its own input.
    """
    text = doc.read_text(encoding="utf-8")
    records: list[Record] = []
    for block in BLOCK.finditer(text):
        start = text[: block.start(1)].count("\n") + 1
        for offset, line in enumerate(block.group(1).splitlines()):
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            rec = Record(source=doc, lineno=start + offset + 1, raw=line)
            # maxsplit=3 keeps a needle containing tabs intact.
            fields = line.split("\t", 3)
            if len(fields) != 4:
                records.append(rec)
                continue
            rec.path, rec.symbol, rec.expect = (f.strip() for f in fields[:3])
            rec.needle = fields[3]
            records.append(rec)
    return records


def check(rec: Record, root: Path) -> Result:
    if not rec.needle or not rec.path:
        return Result(rec, MALFORMED, detail="expected 4 tab-separated fields")

    target = root / rec.path
    if not target.is_file():
        return Result(rec, UNRESOLVED, detail=f"no such file: {rec.path}")

    try:
        body = target.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        return Result(rec, UNRESOLVED, detail=f"unreadable: {exc}")

    # Literal counting throughout. A needle is source text, so regex
    # metacharacters in it are data and never pattern.
    actual = body.count(rec.needle)
    lines = sum(1 for line in body.splitlines() if rec.needle in line)

    if rec.expect.upper() == DEAD:
        # A recorded dead reference is expected to be gone. If it comes back,
        # say so rather than staying quiet: the record is now wrong.
        verdict = DEAD if actual == 0 else DRIFTED
        detail = "" if actual == 0 else "recorded DEAD but the needle now matches"
        return Result(rec, verdict, actual, lines, detail)

    try:
        expected = int(rec.expect)
    except ValueError:
        return Result(rec, MALFORMED, detail=f"expect must be an integer or DEAD, got {rec.expect!r}")

    if actual == 0:
        return Result(rec, MISSING, actual, lines, "the citation no longer resolves")
    if actual != expected:
        return Result(rec, DRIFTED, actual, lines, f"declared {expected}, found {actual}")
    return Result(rec, GOOD, actual, lines)


def report(results: list[Result], verbose: bool) -> None:
    for res in results:
        rec = res.record
        if res.verdict == GOOD and not verbose:
            continue
        where = f"{rec.source}:{rec.lineno}"
        head = f"{res.verdict:<10} {where}"
        if rec.path:
            head += f"  {rec.path}"
            if rec.symbol and rec.symbol != "-":
                head += f"  ({rec.symbol})"
        print(head)
        if res.detail:
            print(f"           {res.detail}")
        if rec.needle:
            print(f"           needle: {rec.needle!r}")
        # Occurrences and matching lines differ when a needle appears twice on
        # one line. Show both so a count is never quietly ambiguous.
        if res.verdict in FAILING and res.actual and res.actual != res.lines:
            print(f"           {res.actual} occurrences across {res.lines} lines")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("paths", nargs="+", type=Path, help="markdown files or directories to check")
    ap.add_argument("--root", type=Path, default=Path.cwd(), help="repository root citations resolve against")
    ap.add_argument("-v", "--verbose", action="store_true", help="also print records that pass")
    args = ap.parse_args()

    docs: list[Path] = []
    for path in args.paths:
        if path.is_dir():
            docs.extend(sorted(path.rglob("*.md")))
        elif path.is_file():
            docs.append(path)
        else:
            print(f"UNRESOLVED  no such path: {path}", file=sys.stderr)
            return 1

    results: list[Result] = []
    for doc in docs:
        results.extend(check(rec, args.root) for rec in parse(doc))

    report(results, args.verbose)

    counts = {v: sum(1 for r in results if r.verdict == v) for v in (GOOD, DEAD, DRIFTED, MISSING, UNRESOLVED, MALFORMED)}
    failed = sum(counts[v] for v in FAILING)

    # A run that examined nothing must not read as success. Zero failures over
    # zero records is the shape that makes a broken gate look green.
    if not results:
        print(f"no citation records found in {len(docs)} file(s)", file=sys.stderr)
        return 1

    summary = ", ".join(f"{counts[v]} {v.lower()}" for v in (GOOD, DEAD, DRIFTED, MISSING, UNRESOLVED, MALFORMED) if counts[v])
    print(f"{len(results)} citation(s) in {len(docs)} file(s): {summary}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
