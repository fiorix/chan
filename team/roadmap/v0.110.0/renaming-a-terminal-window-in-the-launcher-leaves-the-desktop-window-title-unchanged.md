# Renaming a terminal window in the launcher leaves the desktop window's title unchanged

Status: raised for v0.110.0 on 2026-10-23 by the owner; not started.

## What was seen

The owner's words of 2026-10-23: "changing the name of a terminal window in chan-launcher on chan-desktop does not change the title of the window, until the window is hidden and reopened; i havent checkes the Window menu value, but i want the value to propagate from the chan-launcher to the window title without having to hide/close and reopen it."

Later the same day: "btw the window title change seems to be working now.. i dont know why it didnt the first time and when i reported". The title follows a rename at least some of the time, so the fault is intermittent: it depends on an order or a state the first attempt met and later ones did not.

## Desired contract

A terminal window renamed in chan-launcher on chan-desktop shows the new name as its native window title at once, without being hidden, closed or reopened; the desktop's Window menu entry for it reads the same name.

## What to do

First step, a reading: where chan-desktop sets a terminal window's native title and its Window menu entry, which event carries a launcher rename to the window, and which order or state leaves the title unchanged until the window is shown again (a rename before the window's page has loaded, a window opened from the launcher before the rename's event subscription, a hidden window renamed); then the change, pinned by a test that reproduces the failing order first. If the reading finds no failing order, the row closes on the reading.

## Acceptance

1. A rename in the launcher retitles the open window and its Window menu entry with no hide, close or reopen, pinned by a desktop test.
2. A hidden window shows the new name when it is shown again, as today.
