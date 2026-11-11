#!/usr/bin/env python3
"""Own the X CLIPBOARD with text through GTK until killed.

A text copy in a GTK app owns the selection this way. Unlike xclip, which
answers a request for any target with its data, GTK refuses a target it
does not hold, so a reader that asks for image/png is told there is none
rather than handed the text. The process also ends when its display does.

    clipboard-text-owner.py TEXT
"""
import sys

import gi

gi.require_version("Gtk", "3.0")
from gi.repository import Gdk, Gtk  # noqa: E402

if len(sys.argv) != 2:
    sys.exit("usage: clipboard-text-owner.py TEXT")
Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD).set_text(sys.argv[1], -1)
Gtk.main()
