#!/usr/bin/env python3
"""Enumerate workaround signatures in a Rust source tree and split test from production.

A resolved obstacle stops being information: the workaround closes the matter, so
nobody asks what else assumed the thing that was just worked around. That second
question is answerable retrospectively because a workaround leaves a signature in
the tree (sleeps, spin loops, retry budgets, capped waits), and those are
greppable. This prints the population so each site can be asked the question.

Two jobs, kept separate because they fail differently:

1. Enumerate the signature population lexically. Bounded by what a keyword can
   see: a workaround expressed as a reordering, an extra defensive read, or a
   coarser unit matches nothing here. The greps bound what can be enumerated,
   never what can be concluded.

2. Classify each site as test or production. This is the part that is easy to get
   confidently wrong. Comparing a site's line number against the position of a
   `#[cfg(test)]` marker misfiles any production function that follows one, so
   this tracks brace depth over comment-stripped and string-stripped source
   instead, and REFUSES to answer for a file whose depth does not return to zero
   at EOF. A refusal is visible; a plausible wrong bucket is not, and the clean
   rows only mean something if the classifier can say when it did not understand
   a file.

Usage: scripts/census-workarounds.py [repo-root] [--src RELATIVE_DIR]
Output is TSV: file, line, classes, scope, enclosing fn, source line.
"""

import argparse
import re
import sys
from pathlib import Path

IDENT = r"[A-Za-z_][A-Za-z0-9_]*"

# The signature classes. Each is one grep, and the list is meant to grow: a class
# is added whenever a workaround shape turns out to have a cheap lexical form.
CLASSES = [
    ("sleep", re.compile(r"(?:\bthread::sleep|\bsleep\s*\()")),
    ("loop", re.compile(r"\bloop\s*\{")),
    ("wait-const", re.compile(
        r"\b(?:const|static)\s+[A-Z0-9_]+\s*:\s*(?:std::time::)?Duration\b")),
    ("wait-name", re.compile(
        r"\b(?:const|static)\s+[A-Z0-9_]*"
        r"(?:RETRY|RETRIES|ATTEMPT|BACKOFF|BUDGET|DEBOUNCE|INTERVAL|TIMEOUT|DEADLINE)"
        r"[A-Z0-9_]*\s*[:=]")),
    # A retry budget held in a local binding is invisible to a `const`-oriented
    # expression, which is how a hand-rolled attempt counter escapes a census.
    ("attempt-counter", re.compile(
        r"\blet\s+mut\s+(?:attempt|attempts|retries|tries)\b")),
    # A bare early return inside a test is the fail-open shape: a test that
    # cannot reach its case returns green, so it reports success on exactly the
    # systems where the claim it names is false.
    ("test-early-return", re.compile(r"^\s*return\s*;")),
]


def strip_noncode(text):
    """Blank comment bodies and string/char literal bodies, preserving offsets.

    Blanks rather than deletes so line and column positions still line up with
    the original. A brace inside a string or a comment would otherwise unbalance
    the depth count and cost the whole file its classification.
    """
    out = list(text)
    i, n = 0, len(text)
    block_depth = 0

    def blank(a, b):
        for k in range(a, b):
            if out[k] != "\n":
                out[k] = " "

    while i < n:
        c = text[i]
        if block_depth:
            if text.startswith("/*", i):
                block_depth += 1
                blank(i, i + 2)
                i += 2
                continue
            if text.startswith("*/", i):
                block_depth -= 1
                blank(i, i + 2)
                i += 2
                continue
            blank(i, i + 1)
            i += 1
            continue
        if text.startswith("//", i):
            j = text.find("\n", i)
            j = n if j < 0 else j
            blank(i, j)
            i = j
            continue
        if text.startswith("/*", i):
            block_depth = 1
            blank(i, i + 2)
            i += 2
            continue
        m = re.match(r'b?r(#*)"', text[i:])
        if m and (i == 0 or not (text[i - 1].isalnum() or text[i - 1] == "_")):
            close = '"' + m.group(1)
            j = text.find(close, i + m.end())
            j = n if j < 0 else j + len(close)
            blank(i, j)
            i = j
            continue
        if c == '"' or (c == "b" and text.startswith('b"', i)):
            j = i + (2 if c == "b" else 1)
            while j < n:
                if text[j] == "\\":
                    j += 2
                    continue
                if text[j] == '"':
                    j += 1
                    break
                j += 1
            blank(i, j)
            i = j
            continue
        if c == "'":
            # A char literal closes; a lifetime does not. Blanking a lifetime
            # would be harmless, but mistaking `'a` for an unterminated literal
            # would swallow the rest of the line.
            m = re.match(r"'(\\.[^']*|[^'\\])'", text[i:])
            if m:
                blank(i, i + m.end())
                i += m.end()
                continue
        i += 1
    return "".join(out)


def scopes_for(path):
    """Map line number to (in_test, enclosing_fn), or None if the file will not parse."""
    raw = path.read_text(encoding="utf-8", errors="replace")
    lines = strip_noncode(raw).split("\n")
    raw_lines = raw.split("\n")

    depth = 0
    stack = []
    pending_cfg_test = False
    pending_item = None
    result = {}
    underflow = False

    for idx, line in enumerate(lines, start=1):
        # Record the scope BEFORE this line's braces, so the line closing a block
        # still belongs to it.
        result[idx] = (
            any(s[2] for s in stack),
            next((s[1] for s in reversed(stack) if s[0] == "fn"), None),
        )

        stripped = line.strip()
        if re.search(r"#\[cfg\(.*\btest\b.*\)\]", raw_lines[idx - 1]):
            pending_cfg_test = True
        elif (
            stripped
            and not stripped.startswith("#[")
            and not re.search(r"\b(?:fn|mod)\b", stripped)
        ):
            # An attribute binds to the item immediately following it. A
            # `#[cfg(test)]` guarding a statement inside a function body must not
            # reach the next `fn` it happens to meet, or a production function
            # further down the file inherits it and reads as test code.
            pending_cfg_test = False

        pos = 0
        while pos < len(line):
            m = re.match(rf"\bmod\s+({IDENT})", line[pos:])
            if m:
                pending_item = ("mod", m.group(1),
                                pending_cfg_test or m.group(1) == "tests")
                pending_cfg_test = False
                pos += m.end()
                continue
            m = re.match(rf"\bfn\s+({IDENT})", line[pos:])
            if m:
                pending_item = ("fn", m.group(1), pending_cfg_test)
                pending_cfg_test = False
                pos += m.end()
                continue
            ch = line[pos]
            if ch == "{":
                if pending_item is None:
                    stack.append(("block", None, False, depth))
                else:
                    kind, name, is_test = pending_item
                    stack.append((kind, name, is_test, depth))
                    pending_item = None
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth < 0:
                    underflow = True
                while stack and stack[-1][3] >= depth:
                    stack.pop()
            pos += 1

    if depth != 0 or underflow:
        return None
    return result


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    ap.add_argument("root", nargs="?", default=".", help="repository root")
    ap.add_argument("--src", default="crates/chan-workspace/src",
                    help="source directory to census, relative to root")
    args = ap.parse_args()

    root = Path(args.root)
    src = root / args.src
    if not src.is_dir():
        print(f"no such directory: {src}", file=sys.stderr)
        return 2

    rows, unparsed = [], []
    for path in sorted(src.rglob("*.rs")):
        raw = path.read_text(encoding="utf-8", errors="replace")
        code = strip_noncode(raw)
        scopes = scopes_for(path)
        if scopes is None:
            unparsed.append(str(path.relative_to(root)))
        for idx, cline in enumerate(code.split("\n"), start=1):
            hits = [name for name, rx in CLASSES if rx.search(cline)]
            if not hits:
                continue
            in_test, fn = scopes.get(idx, (None, None)) if scopes else (None, None)
            # `test-early-return` is only a signature inside a test; in
            # production a bare return is an ordinary guard clause.
            if hits == ["test-early-return"] and in_test is not True:
                continue
            rows.append((
                str(path.relative_to(root)), idx, "+".join(hits),
                "?" if scopes is None else ("test" if in_test else "prod"),
                fn or "-", raw.split("\n")[idx - 1].strip()[:100],
            ))

    by_class = {}
    for r in rows:
        by_class[r[2]] = by_class.get(r[2], 0) + 1
    print(f"# population: {len(rows)} sites")
    if unparsed:
        print(f"# UNPARSED (classification refused): {unparsed}")
    print(f"# by class: {dict(sorted(by_class.items()))}")
    print(f"# prod={sum(1 for r in rows if r[3] == 'prod')} "
          f"test={sum(1 for r in rows if r[3] == 'test')}")
    print()
    for r in rows:
        print("\t".join(str(x) for x in r))
    return 0


if __name__ == "__main__":
    sys.exit(main())
