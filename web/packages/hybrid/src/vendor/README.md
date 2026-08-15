# Vendored

`winbox.bundle.min.js` is WinBox.js v0.2.82, taken from the upstream release tag at <https://github.com/nextapps-de/winbox> (`dist/winbox.bundle.min.js`, 15978 bytes). It is the self-contained build: JavaScript, CSS, and the control icons as base64 data URIs, with no runtime dependencies and no network fetches.

Copyright Thomas Wilkerling, hosted by Nextapps GmbH, licensed Apache-2.0. The file keeps its upstream header carrying that notice.

It is used unmodified. The chan window styling is applied from `../hybrid.css` through the `chan` class the shell passes to every window, and the window manager is reached only through `../wm-winbox.mjs`, so replacing or customizing WinBox touches that one adapter.
