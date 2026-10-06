#!/usr/bin/env python3
"""Count the seed's colours in a capture of the desktop's window.

The capture is a binary PPM (`import -window <id> ppm:<file>`), which needs
no image library to read. Prints one JSON line: for each named colour, how
many of the pixels it samples are within the tolerance of it, inside the
box when one is given. It samples every second pixel of every second row,
so a count is about a quarter of the pixels of that colour; a driver polls
this, and a whole capture read pixel by pixel takes seconds. It judges
nothing.

Usage: window-colours.py <capture.ppm> <colours.json> [x0 y0 x1 y1]
Exit 0 with the JSON line, 3 when the capture cannot be read.
"""

import json
import sys

TOLERANCE = 12
STEP = 2


def read_ppm(path):
    data = open(path, "rb").read()
    fields = []
    at = 0
    # Magic, width, height and maximum, separated by whitespace, with
    # comment lines allowed between them; one whitespace byte ends them.
    while len(fields) < 4:
        while data[at : at + 1].isspace():
            at += 1
        if data[at : at + 1] == b"#":
            at = data.index(b"\n", at) + 1
            continue
        end = at
        while end < len(data) and not data[end : end + 1].isspace():
            end += 1
        if end == len(data):
            raise ValueError("truncated PPM header")
        fields.append(data[at:end])
        at = end
    at += 1
    if fields[0] != b"P6" or fields[3] != b"255":
        raise ValueError("not an 8 bit binary PPM")
    width, height = int(fields[1]), int(fields[2])
    pixels = data[at:]
    if len(pixels) < width * height * 3:
        raise ValueError("the capture is shorter than its header says")
    return width, height, pixels


def main():
    if len(sys.argv) not in (3, 7):
        print(__doc__.strip().splitlines()[-2], file=sys.stderr)
        return 3
    try:
        width, height, pixels = read_ppm(sys.argv[1])
        colours = json.load(open(sys.argv[2]))
    except (OSError, ValueError) as error:
        print(f"window-colours: {error}", file=sys.stderr)
        return 3
    x0, y0, x1, y1 = 0, 0, width - 1, height - 1
    if len(sys.argv) == 7:
        x0, y0, x1, y1 = (int(float(v)) for v in sys.argv[3:7])
        x0, y0 = max(0, x0), max(0, y0)
        x1, y1 = min(width - 1, x1), min(height - 1, y1)
    counts = dict.fromkeys(colours, 0)
    for y in range(y0, y1 + 1, STEP):
        row = y * width * 3
        for x in range(x0, x1 + 1, STEP):
            at = row + x * 3
            r, g, b = pixels[at], pixels[at + 1], pixels[at + 2]
            for name, (cr, cg, cb) in colours.items():
                if abs(r - cr) <= TOLERANCE and abs(g - cg) <= TOLERANCE and abs(b - cb) <= TOLERANCE:
                    counts[name] += 1
    print(json.dumps({"width": width, "height": height, "box": [x0, y0, x1, y1], "step": STEP, "counts": counts}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
