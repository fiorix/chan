#!/usr/bin/env python3
"""Regenerate the chan-desktop app icon set from the enso source.

Why this exists: hand-producing the icon lets the enso drift too far into the
squircle edge. This bakes a reproducible pipeline: take the cream-paper enso
source, fit it into the SAME macOS squircle shape the current icon uses (reused
verbatim from the current icon's alpha, so the corner shape / transparent
margin never drift), and export every Tauri size.

ENSO_FILL controls the enso size inside the squircle: 1.0 = the source fills the
squircle bbox (un-zoomed, the source's own generous margin); < 1.0 shrinks the
source content and fills the ring with the source's edge cream paper, for even
more breathing room.

Usage:
  python3 scripts/gen-app-icon.py --preview        # write /tmp preview only
  python3 scripts/gen-app-icon.py --write          # overwrite icons/ + build icns/ico
"""
import argparse, os, subprocess, sys, tempfile
from PIL import Image

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.expanduser("~/Downloads/chan-mark-hero.png")
ICONS = os.path.join(REPO, "desktop/src-tauri/icons")
CUR = os.path.join(ICONS, "icon.png")  # current icon: source of the squircle alpha
ENSO_FILL = 1.0  # 1.0 = un-zoom to the source framing; lower = more cream margin

# Tauri icon set (name -> px). Square*Logo are the Windows tiles.
SIZES = {
    "icon.png": 512, "32x32.png": 32, "64x64.png": 64,
    "128x128.png": 128, "128x128@2x.png": 256,
    "Square30x30Logo.png": 30, "Square44x44Logo.png": 44,
    "Square71x71Logo.png": 71, "Square89x89Logo.png": 89,
    "Square107x107Logo.png": 107, "Square142x142Logo.png": 142,
    "Square150x150Logo.png": 150, "Square284x284Logo.png": 284,
    "Square310x310Logo.png": 310, "StoreLogo.png": 50,
}


def build_master(fill: float) -> Image.Image:
    """512 master: source enso fitted into the current icon's squircle shape."""
    mask = Image.open(CUR).convert("RGBA").split()[3]          # exact squircle + margin
    bbox = mask.getbbox()                                      # (47,47,465,465)
    side = bbox[2] - bbox[0]
    src = Image.open(SRC).convert("RGBA")
    inner = max(1, round(side * fill))
    scaled = src.resize((inner, inner), Image.LANCZOS)
    content = Image.new("RGBA", mask.size, (0, 0, 0, 0))
    if fill >= 1.0:
        content.paste(scaled, (bbox[0], bbox[1]))
    else:
        # Fill the squircle with the source's cream paper (an upscaled copy so no
        # enso shows in the ring), then center the smaller enso source on top.
        paper = src.resize((side, side), Image.LANCZOS)
        content.paste(paper, (bbox[0], bbox[1]))
        off = ((side - inner) // 2, (side - inner) // 2)
        content.paste(scaled, (bbox[0] + off[0], bbox[1] + off[1]), scaled)
    content.putalpha(mask)                                     # clip to the squircle
    return content


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--preview", action="store_true")
    ap.add_argument("--write", action="store_true")
    ap.add_argument("--fill", type=float, default=ENSO_FILL)
    a = ap.parse_args()
    if not os.path.exists(SRC):
        sys.exit(f"source not found: {SRC}")
    master = build_master(a.fill)

    if a.preview or not a.write:
        out = f"/tmp/icon-preview-fill{a.fill}.png"
        master.save(out)
        print("preview:", out)
        if not a.write:
            return

    # PNG set
    for name, px in SIZES.items():
        master.resize((px, px), Image.LANCZOS).save(os.path.join(ICONS, name))
    # .ico (multi-size)
    master.save(os.path.join(ICONS, "icon.ico"),
                sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    # .icns via iconutil from a temp .iconset
    with tempfile.TemporaryDirectory() as d:
        iset = os.path.join(d, "icon.iconset")
        os.makedirs(iset)
        for base in (16, 32, 128, 256, 512):
            master.resize((base, base), Image.LANCZOS).save(
                os.path.join(iset, f"icon_{base}x{base}.png"))
            master.resize((base * 2, base * 2), Image.LANCZOS).save(
                os.path.join(iset, f"icon_{base}x{base}@2x.png"))
        subprocess.run(["iconutil", "-c", "icns", iset, "-o",
                        os.path.join(ICONS, "icon.icns")], check=True)
    print("wrote icon set to", ICONS)


if __name__ == "__main__":
    main()
