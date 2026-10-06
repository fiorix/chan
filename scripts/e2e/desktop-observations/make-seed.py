#!/usr/bin/env python3
"""Write the seed of the PDF export observation into a workspace directory.

Everything is generated, so no binary is kept in the repository and the
colours the readers look for are stated once, here, and written beside the
seed as colours.json.

The seed:

  plain.png                  one flat colour, the ordinary page image. The
                             v0.102.0 repair paints this kind itself, so a
                             PDF without it means the reader sees no picture
                             at all, and the run is inconclusive.
  ring-a.png                 a field with a centre square. In the drawing it
                             is rotated by 30 degrees.
  ring-b.png                 an outer ring, a field and a centre square. In
                             the drawing it is cropped to its inner half, so
                             the ring is cut away: the centre must be on the
                             page and in the PDF, the ring on neither.
  drawing-picture.excalidraw the scene holding both pictures as image
                             elements, their bytes in the scene's files.
  drawing-picture.md         a document showing plain.png and the drawing.
  deck.md                    a three slide deck: text and plain.png, text
                             only, and the drawing.
  colours.json               the colours above, by name.

Usage: make-seed.py <workspace directory>
"""

import base64
import json
import struct
import sys
import zlib
from pathlib import Path

COLOURS = {
    "plain": [0, 170, 170],
    "a_field": [20, 90, 200],
    "a_centre": [230, 0, 126],
    "b_ring": [120, 60, 10],
    "b_field": [60, 200, 40],
    "b_centre": [255, 140, 0],
}


def png(width, height, pixel):
    """An 8 bit RGB PNG; pixel(x, y) answers the colour of one pixel."""
    rows = bytearray()
    for y in range(height):
        rows.append(0)
        for x in range(width):
            rows.extend(pixel(x, y))

    def chunk(kind, data):
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(bytes(rows), 9))
        + chunk(b"IEND", b"")
    )


def ring_a(x, y):
    if 40 <= x < 80 and 40 <= y < 80:
        return COLOURS["a_centre"]
    return COLOURS["a_field"]


def ring_b(x, y):
    if 60 <= x < 100 and 60 <= y < 100:
        return COLOURS["b_centre"]
    if 40 <= x < 120 and 40 <= y < 120:
        return COLOURS["b_field"]
    return COLOURS["b_ring"]


def image_element(ident, file_id, x, y, width, height, angle, crop, seed):
    return {
        "id": ident,
        "type": "image",
        "x": x,
        "y": y,
        "width": width,
        "height": height,
        "angle": angle,
        "strokeColor": "transparent",
        "backgroundColor": "transparent",
        "fillStyle": "solid",
        "strokeWidth": 1,
        "strokeStyle": "solid",
        "roughness": 0,
        "opacity": 100,
        "groupIds": [],
        "frameId": None,
        "roundness": None,
        "seed": seed,
        "version": 1,
        "versionNonce": seed + 1,
        "isDeleted": False,
        "boundElements": None,
        "updated": 1,
        "link": None,
        "locked": False,
        "status": "saved",
        "fileId": file_id,
        "scale": [1, 1],
        "crop": crop,
    }


def scene_file(file_id, data):
    return {
        "id": file_id,
        "mimeType": "image/png",
        "dataURL": "data:image/png;base64," + base64.b64encode(data).decode("ascii"),
        "created": 1,
    }


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__.strip().splitlines()[-1])
    root = Path(sys.argv[1])
    root.mkdir(parents=True, exist_ok=True)

    plain = png(80, 80, lambda x, y: COLOURS["plain"])
    a = png(120, 120, ring_a)
    b = png(160, 160, ring_b)
    (root / "plain.png").write_bytes(plain)
    (root / "ring-a.png").write_bytes(a)
    (root / "ring-b.png").write_bytes(b)

    scene = {
        "type": "excalidraw",
        "version": 2,
        "source": "chan-observation",
        "elements": [
            # Thirty degrees, in radians, about the element's centre.
            image_element("picture-a", "file-a", 30, 30, 120, 120, 0.5235987756, None, 11),
            # The inner 80 by 80 of 160 by 160, shown at 120 by 120.
            image_element(
                "picture-b",
                "file-b",
                240,
                30,
                120,
                120,
                0,
                {
                    "x": 40,
                    "y": 40,
                    "width": 80,
                    "height": 80,
                    "naturalWidth": 160,
                    "naturalHeight": 160,
                },
                21,
            ),
        ],
        "appState": {"viewBackgroundColor": "#ffffff"},
        "files": {"file-a": scene_file("file-a", a), "file-b": scene_file("file-b", b)},
    }
    (root / "drawing-picture.excalidraw").write_text(json.dumps(scene) + "\n")

    (root / "drawing-picture.md").write_text(
        "# A drawing that holds pictures\n\n"
        "An ordinary image of the page:\n\n"
        "![](plain.png#w=80)\n\n"
        "A drawing with one rotated and one cropped picture:\n\n"
        "![](drawing-picture.excalidraw#w=420)\n"
    )

    (root / "deck.md").write_text(
        "---\n"
        "chan:\n"
        "  kind: slides\n"
        "  slides:\n"
        '    aspect_ratio: "16:9"\n'
        "---\n\n"
        "# Text and an image\n\n"
        "Slide one carries text and an image.\n\n"
        "![](plain.png#w=180)\n\n"
        '<hr class="chan-page-break">\n\n'
        "# Text only\n\n"
        "Slide two carries a list.\n\n"
        "- one\n- two\n- three\n\n"
        '<hr class="chan-page-break">\n\n'
        "# A drawing\n\n"
        "![](drawing-picture.excalidraw#w=420)\n"
    )

    (root / "colours.json").write_text(json.dumps(COLOURS, indent=2) + "\n")


if __name__ == "__main__":
    main()
