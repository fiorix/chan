#!/usr/bin/env python3
"""A small GTK window that drags a file as a file manager does, until killed.

    drag-source.py FILE X Y

The window sits at X,Y on the screen, and a drag that starts on it offers
FILE as text/uri-list over XDND. One line goes to stdout per event, so a
driver can tell a drag that never started from one the target refused:
"ready X Y W H" once the window is mapped (its origin and size on the
screen), then "begin", "data-get TARGET", "end" and "failed RESULT".
"""
import os
import sys

import gi

gi.require_version("Gdk", "3.0")
gi.require_version("Gtk", "3.0")
from gi.repository import Gdk, GLib, Gtk  # noqa: E402

if len(sys.argv) != 4:
    sys.exit("usage: drag-source.py FILE X Y")
uri = GLib.filename_to_uri(os.path.abspath(sys.argv[1]), None)
x, y = int(sys.argv[2]), int(sys.argv[3])


def say(*words):
    print(*words, flush=True)


window = Gtk.Window(title="basic-flows drag source")
window.set_default_size(96, 72)
window.set_keep_above(True)
window.move(x, y)
area = Gtk.EventBox()
area.add(Gtk.Label(label="drag"))
window.add(area)
area.drag_source_set(Gdk.ModifierType.BUTTON1_MASK, [Gtk.TargetEntry.new("text/uri-list", 0, 0)], Gdk.DragAction.COPY)
area.connect("drag-begin", lambda *_: say("begin"))
area.connect("drag-data-get", lambda _w, _ctx, data, _info, _time: (say("data-get", data.get_target().name()), data.set_uris([uri])))
area.connect("drag-end", lambda *_: say("end"))
area.connect("drag-failed", lambda _w, _ctx, result: (say("failed", result.value_nick), False)[1])


def mapped(*_):
    origin = area.get_window().get_origin()
    alloc = area.get_allocation()
    say("ready", origin.x, origin.y, alloc.width, alloc.height)
    return False


window.connect("map-event", lambda *_: GLib.timeout_add(200, mapped) and False)
window.connect("destroy", Gtk.main_quit)
window.show_all()
Gtk.main()
