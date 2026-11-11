#!/usr/bin/env python3
"""Own the X CLIPBOARD through GTK until killed, as an app's copy does.

    clipboard-owner.py text TEXT   text only
    clipboard-owner.py image PNG   the image as Gtk.Clipboard.set_image
                                   offers it: image/png and every other
                                   format GdkPixbuf can write, as a
                                   screenshot tool's copy does
    clipboard-owner.py png PNG     image/png alone, the file's own bytes

Unlike xclip, which answers a request for any target with its data, GTK
refuses a target it does not hold, so a reader that asks a text owner for
image/png is told there is none rather than handed the text. The process
also ends when its display does.
"""
import sys

import gi

gi.require_version("Gdk", "3.0")
gi.require_version("Gtk", "3.0")
from gi.repository import Gdk, GdkPixbuf, Gtk  # noqa: E402

if len(sys.argv) != 3 or sys.argv[1] not in ("text", "image", "png"):
    sys.exit("usage: clipboard-owner.py text TEXT | image PNG | png PNG")
mode, value = sys.argv[1], sys.argv[2]
clipboard = Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD)
if mode == "text":
    clipboard.set_text(value, -1)
elif mode == "image":
    clipboard.set_image(GdkPixbuf.Pixbuf.new_from_file(value))
else:
    with open(value, "rb") as f:
        data = f.read()
    target = Gdk.Atom.intern("image/png", False)
    # A widget's own selection: GTK answers TARGETS with the one target
    # added here and refuses every other.
    owner = Gtk.Invisible()
    owner.realize()
    Gtk.selection_add_target(owner, Gdk.SELECTION_CLIPBOARD, target, 0)
    owner.connect("selection-get", lambda _w, selection, _info, _time: selection.set(target, 8, data))
    owner.connect("selection-clear-event", lambda *_: Gtk.main_quit())
    if not Gtk.selection_owner_set(owner, Gdk.SELECTION_CLIPBOARD, Gdk.CURRENT_TIME):
        sys.exit("clipboard-owner.py: could not own the clipboard")
Gtk.main()
